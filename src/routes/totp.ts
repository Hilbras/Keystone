import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { config } from "../config.js";
import {
  generateSecret,
  buildProvisioningUri,
  verifyTOTP,
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  storeBackupCodes,
  verifyBackupCode,
} from "../services/totp.js";

const CodeSchema = z.object({
  code: z.string().min(6).max(8),
});

const BackupCodeSchema = z.object({
  code: z.string().min(8).max(16),
});

export default async function totpRoutes(app: FastifyInstance) {
  app.post(
    "/totp/enroll",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (user.totpEnabled) {
        return reply.status(409).send({ error: "TOTP already enrolled" });
      }

      const secret = generateSecret();
      const encrypted = encryptSecret(secret);
      const { codes, hashes } = generateBackupCodes();

      await db
        .update(users)
        .set({
          totpSecret: encrypted,
          totpEnabled: false,
        })
        .where(eq(users.id, user.id));

      await storeBackupCodes(user.id, hashes);

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

  app.post(
    "/totp/backup",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret || !user.totpEnabled) {
        return reply.status(400).send({ error: "TOTP not enabled" });
      }

      const body = BackupCodeSchema.parse(request.body);
      const valid = await verifyBackupCode(user.id, body.code);
      if (!valid) {
        await request.audit("totp_verify_failed", { userId: user.id, method: "backup_code" });
        return reply.status(400).send({ error: "Invalid backup code" });
      }

      await request.audit("totp_enabled", { userId: user.id, method: "backup_code" });
      return { success: true };
    }
  );

  app.post(
    "/totp/verify",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret) {
        return reply.status(400).send({ error: "TOTP not enrolled" });
      }

      const body = CodeSchema.parse(request.body);
      const secret = decryptSecret(user.totpSecret);
      if (!verifyTOTP(secret, body.code)) {
        await request.audit("totp_verify_failed", { userId: user.id });
        return reply.status(400).send({ error: "Invalid code" });
      }

      await db
        .update(users)
        .set({
          totpEnabled: true,
          totpVerifiedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await request.audit("totp_enabled", { userId: user.id });

      return { success: true };
    }
  );

  app.post(
    "/totp/disable",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      if (!user.totpSecret || !user.totpEnabled) {
        return reply.status(400).send({ error: "TOTP not enabled" });
      }

      const body = CodeSchema.parse(request.body);
      const secret = decryptSecret(user.totpSecret);
      if (!verifyTOTP(secret, body.code)) {
        await request.audit("totp_disable_failed", { userId: user.id });
        return reply.status(400).send({ error: "Invalid code" });
      }

      await db
        .update(users)
        .set({
          totpSecret: null,
          totpEnabled: false,
          totpVerifiedAt: null,
        })
        .where(eq(users.id, user.id));

      await request.audit("totp_disabled", { userId: user.id });

      return { success: true };
    }
  );
}
