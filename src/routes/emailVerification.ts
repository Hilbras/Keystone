import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { findUserByEmail } from "../services/users.js";
import {
  sendVerificationEmail,
  consumeVerificationToken,
} from "../services/emailVerification.js";

const SendSchema = z.object({
  email: z.string().email(),
});

export default async function emailVerificationRoutes(app: FastifyInstance) {
  // Authenticated: resend the verification email for the signed-in user.
  app.post("/email-verification/send", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    if (user.emailVerified) return { success: true, alreadyVerified: true };

    try {
      await sendVerificationEmail(user);
    } catch (err) {
      request.log.error({ err }, "Failed to send verification email");
      return reply.status(500).send({ error: "Failed to send verification email" });
    }

    await request.audit("email_verification_sent", { userId: user.id });
    return { success: true };
  });

  // Unauthenticated: request a verification email by address.
  // Always returns success to avoid user enumeration.
  app.post("/email-verification/request", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = SendSchema.parse(request.body);
    const user = await findUserByEmail(body.email);
    if (!user || user.emailVerified) {
      return reply.status(200).send({ success: true });
    }

    try {
      await sendVerificationEmail(user);
      await request.audit("email_verification_sent", { userId: user.id });
    } catch (err) {
      request.log.error({ err }, "Failed to send verification email");
    }

    return { success: true };
  });

  app.get("/email-verification/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { token?: string };
    if (!query.token) {
      return reply.status(400).send({ error: "Missing token" });
    }

    const user = await consumeVerificationToken(query.token);
    if (!user) {
      return reply.status(400).send({ error: "Invalid or expired token" });
    }

    await request.audit("email_verified", { userId: user.id });
    return { success: true, email: user.email };
  });
}
