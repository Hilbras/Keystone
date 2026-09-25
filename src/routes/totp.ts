import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { revokeAllUserRefreshTokens } from "../services/tokens.js";
import { SessionRepository } from "../repositories/session.js";
import {
  generateSecret,
  buildProvisioningUri,
  encryptSecret,
  generateBackupCodes,
  storeBackupCodes,
  verifyBackupCode,
  verifyUserTotpCode,
} from "../services/totp.js";

const CodeSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, "A TOTP code must be exactly six digits"),
});

const BackupCodeSchema = z.object({
  code: z.string().min(10).max(40),
});

/** Sensitive factor operations get their own budget, separate from login. */
const factorRateLimit = (keyPrefix: string) =>
  rateLimit({ keyPrefix, maxAttempts: 10, windowSeconds: 300 });

export default async function totpRoutes(app: FastifyInstance) {
  app.post(
    "/totp/enroll",
    { preHandler: [app.authenticate, factorRateLimit("totp-enroll")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (user.totpEnabled) {
        return reply.status(409).send({ error: "TOTP already enrolled" });
      }

      const secret = generateSecret();
      const encrypted = encryptSecret(secret);
      const { codes, hashes } = generateBackupCodes();

      // Enrollment is not atomic on its own, so a partial failure must not leave
      // a usable factor half-registered.
      try {
        await app.container.userRepository.setTotpSecret(user.id, encrypted);
        await storeBackupCodes(user.id, hashes);
      } catch (err) {
        await app.container.userRepository.disableTotp(user.id).catch(() => {});
        request.log.error({ err }, "TOTP enrollment failed");
        return reply.status(500).send({ error: "Could not start TOTP enrollment" });
      }

      const provisioningUri = buildProvisioningUri({
        secret,
        email: user.email,
        issuer: config.TOTP_ISSUER,
      });

      await request.audit("totp_enrolled", { userId: user.id });

      return {
        secret,
        provisioningUri,
        backupCodes: codes,
      };
    }
  );

  /**
   * Regenerate backup codes. Requires the current TOTP code so a hijacked
   * session cannot silently mint fresh recovery material.
   */
  app.post(
    "/totp/backup",
    { preHandler: [app.authenticate, factorRateLimit("totp-backup")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret || !user.totpEnabled) {
        return reply.status(400).send({ error: "TOTP not enabled" });
      }

      const body = z
        .object({ code: z.string().regex(/^[0-9]{6}$/, "A TOTP code must be exactly six digits") })
        .parse(request.body);

      const verified = await verifyUserTotpCode(user, body.code);
      if (!verified.valid) {
        await request.audit("totp_verify_failed", { userId: user.id, method: "totp" });
        return reply.status(401).send({ error: "Invalid code" });
      }

      const { codes, hashes } = generateBackupCodes();
      await storeBackupCodes(user.id, hashes);
      await request.audit("mfa_backup_code_regenerated", { userId: user.id });

      return { backupCodes: codes };
    }
  );

  app.post(
    "/totp/verify",
    { preHandler: [app.authenticate, factorRateLimit("totp-verify")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret) {
        return reply.status(400).send({ error: "TOTP not enrolled" });
      }

      const body = CodeSchema.parse(request.body);
      // Enrollment verification still goes through the user's own secret, and
      // the time-step is consumed so the same code cannot enable MFA twice.
      const verified = await verifyUserTotpCode(user, body.code, {
        consume: false,
        requireEnabled: false,
      });
      if (!verified.valid) {
        await request.audit("totp_verify_failed", { userId: user.id });
        return reply.status(401).send({ error: "Invalid code" });
      }

      await app.container.userRepository.enableTotp(user.id);

      // Enrolling MFA must not leave sessions that were created before the
      // second factor existed.
      await revokeAllUserRefreshTokens(user.id);
      await new SessionRepository().revokeAllForUser(user.id);
      await app.container.mfaChallengeRepository.invalidateUserChallenges(user.id, new Date());

      await request.audit("totp_enabled", { userId: user.id });

      return { success: true, sessionsRevoked: true };
    }
  );

  app.post(
    "/totp/disable",
    { preHandler: [app.authenticate, factorRateLimit("totp-disable")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret || !user.totpEnabled) {
        return reply.status(400).send({ error: "TOTP not enabled" });
      }

      const body = CodeSchema.parse(request.body);
      const verified = await verifyUserTotpCode(user, body.code);
      if (!verified.valid) {
        await request.audit("totp_disable_failed", { userId: user.id });
        return reply.status(401).send({ error: "Invalid code" });
      }

      await app.container.userRepository.disableTotp(user.id);
      await request.audit("totp_disabled", { userId: user.id });

      return { success: true };
    }
  );

  /**
   * Verify a backup code out of band (e.g. account recovery tooling). This
   * never establishes a session; login completes through /auth/mfa/verify.
   */
  app.post(
    "/totp/backup/verify",
    { preHandler: [app.authenticate, factorRateLimit("totp-backup-verify")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret || !user.totpEnabled) {
        return reply.status(400).send({ error: "TOTP not enabled" });
      }

      const body = BackupCodeSchema.parse(request.body);
      const valid = await verifyBackupCode(user.id, body.code);
      if (!valid) {
        await request.audit("totp_verify_failed", { userId: user.id, method: "backup_code" });
        return reply.status(401).send({ error: "Invalid backup code" });
      }

      return { success: true, sessionEstablished: false };
    }
  );
}
