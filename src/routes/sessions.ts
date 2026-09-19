import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { SessionRepository } from "../repositories/session.js";

const sessions = new SessionRepository();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export default async function sessionRoutes(app: FastifyInstance) {
  app.get("/sessions", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    const userId = request.user?.id;
    if (!userId) return { sessions: [] };
    const list = await sessions.listByUser(userId);
    return {
      sessions: list.map((s) => ({
        id: s.id,
        deviceFingerprint: s.deviceFingerprint,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      })),
    };
  });

  app.delete("/sessions/:id", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    const { id } = request.params as { id: string };
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const session = await sessions.findById(id);
    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await sessions.revokeRefreshToken(session.refreshTokenId);
    await sessions.deleteById(id, userId);

    await request.audit("session_revoked", { sessionId: id });
    return { success: true };
  });

  app.post("/sessions/revoke-all", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const currentRefreshToken = request.cookies?.[config.COOKIE_NAME];
    let currentRefreshTokenId: string | undefined;
    if (currentRefreshToken) {
      const row = await sessions.findRefreshTokenByHash(hashToken(currentRefreshToken));
      currentRefreshTokenId = row?.id;
    }

    await sessions.deleteAllForUser(userId, currentRefreshTokenId);
    await request.audit("sessions_revoked_all", { exceptSessionId: currentRefreshTokenId });
    return { success: true };
  });
}
