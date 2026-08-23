import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { findUserByEmail } from "../services/users.js";
import {
  generateMagicLink,
  storeMagicLink,
  consumeMagicLink,
  magicLinkExpiresAt,
} from "../services/magicLinks.js";
import { createTokenSet } from "../services/tokens.js";
import { fingerprintFromRequest, recordDevice } from "../services/devices.js";
import { setSessionCookies } from "../plugins/auth.js";
import { emailProvider } from "../services/email.js";
import { toPublicUser } from "../types.js";
import { config } from "../config.js";

const SendSchema = z.object({
  email: z.string().email(),
});

function magicLinkUrl(token: string): string {
  // The link lands on the client app (Keystone admin UI or a client
  // application), which exchanges the token via the verify endpoint.
  const base = process.env.CLIENT_APP_URL || "http://localhost:5173";
  return `${base}/#magic-link=${encodeURIComponent(token)}`;
}

function postLoginRedirect(): string {
  return process.env.CLIENT_APP_URL || "http://localhost:5173";
}

export default async function magicLinkRoutes(app: FastifyInstance) {
  app.post("/magic-link/send", async (request, reply) => {
    const body = SendSchema.parse(request.body);
    const user = await findUserByEmail(body.email);
    if (!user) {
      return reply.status(200).send({ success: true });
    }

    const { token, tokenHash } = generateMagicLink();
    await storeMagicLink(user.id, tokenHash, magicLinkExpiresAt());

    try {
      const url = magicLinkUrl(token);
      const ttlMinutes = Math.round(config.MAGIC_LINK_TTL_SECONDS / 60);
      await emailProvider.send({
        to: user.email,
        subject: "Your sign-in link",
        text: `Click the link to sign in:\n\n${url}\n\nThis link expires in ${ttlMinutes} minutes and can only be used once.`,
        html: `<p>Click <a href="${url}">here</a> to sign in.</p><p>This link expires in ${ttlMinutes} minutes and can only be used once.</p>`,
      });
    } catch (err) {
      request.log.error({ err }, "Failed to send magic link email");
    }

    await request.audit("magic_link_sent", { userId: user.id });

    return { success: true };
  });

  app.get("/magic-link/verify", async (request: FastifyRequest, reply) => {
    const query = request.query as { token?: string; redirect?: string };
    if (!query.token) {
      return reply.status(400).send({ error: "Missing token" });
    }

    const user = await consumeMagicLink(query.token);
    if (!user) {
      return reply.status(400).send({ error: "Invalid or expired token" });
    }

    const fingerprint = fingerprintFromRequest(request);
    await recordDevice(user.id, fingerprint, request.ip, request.headers["user-agent"]);

    const tokens = await createTokenSet(
      user,
      request.ip,
      request.headers["user-agent"],
      {},
      fingerprint
    );
    setSessionCookies(reply, tokens.accessToken, tokens.refreshToken);

    await request.audit("magic_link_verified", { userId: user.id });

    // Browser flow: redirect back to the app after setting session cookies.
    const accept = request.headers.accept || "";
    if (accept.includes("text/html")) {
      return reply.redirect(postLoginRedirect());
    }

    return {
      user: toPublicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  });
}
