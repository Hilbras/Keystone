import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getSdk } from "../sdk/index.js";
import { isZitadelConfigured } from "../config.js";
import { requestPasswordReset, setPassword } from "../services/zitadel.js";
import { findUserByEmail } from "../services/users.js";
import { emailProvider } from "../services/email.js";
import { sendResultError } from "./helpers.js";
import { rateLimit } from "../plugins/rateLimit.js";

const ForgotSchema = z.object({
  email: z.string().email(),
});

const ResetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

function resetUrl(token: string): string {
  const base = process.env.RESET_PASSWORD_URL || `${process.env.CLIENT_APP_URL || "http://localhost:5173"}/reset-password`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

export default async function passwordRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post("/forgot-password", {
    preHandler: [
      rateLimit({
        keyPrefix: "forgot-password",
        maxAttempts: 5,
        windowSeconds: 900,
      }),
    ],
  }, async (request, reply) => {
    const body = ForgotSchema.parse(request.body);
    const user = await findUserByEmail(body.email);

    // Always return success to avoid email enumeration.
    if (!user) {
      await request.audit("password_reset_requested", { found: false });
      return { success: true };
    }

    // If Zitadel is configured and the user has a Zitadel mirror, prefer Zitadel's flow.
    if (isZitadelConfigured() && user.zitadelUserId) {
      try {
        const redirectUrl = process.env.RESET_PASSWORD_URL || `${process.env.CLIENT_APP_URL || "http://localhost:5173"}/reset-password`;
        await requestPasswordReset(user.zitadelUserId, redirectUrl);
        await request.audit("password_reset_requested", {
          found: true,
          userId: user.id,
          zitadelUserId: user.zitadelUserId,
        });
      } catch (err) {
        request.log.error({ err }, "Zitadel password reset request failed");
      }
      return { success: true };
    }

    // Local token-based reset flow.
    const result = await sdk.authentication.createPasswordResetToken(body.email);
    if (!result.success) return sendResultError(reply, result);

    if (result.data) {
      try {
        await emailProvider.send({
          to: user.email,
          subject: "Reset your Hilbras Keystone password",
          text: `Click the link to reset your password:\n\n${resetUrl(result.data.token)}\n\nThis link expires in 1 hour.`,
          html: `<p>Click <a href="${resetUrl(result.data.token)}">here</a> to reset your password.</p><p>This link expires in 1 hour.</p>`,
        });
      } catch (err) {
        request.log.error({ err }, "Failed to send password reset email");
      }
    }

    return { success: true };
  });

  app.post("/reset-password", async (request, reply) => {
    const body = ResetSchema.parse(request.body);
    const result = await sdk.authentication.resetPasswordWithToken(body.token, body.newPassword);
    if (!result.success) return sendResultError(reply, result);
    await request.audit("password_reset_completed", { userId: result.data.id });
    return { success: true };
  });
}
