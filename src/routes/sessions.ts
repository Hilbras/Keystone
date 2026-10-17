import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { revokeUserSessions } from "../services/sessionRevocation.js";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export default async function sessionRoutes(app: FastifyInstance) {
  const sessions = app.container.sessionRepository;
  app.get("/sessions", { preHandler: [app.authenticate, app.requireScopes("sessions:read")] }, async (request: FastifyRequest) => {
    const userId = request.user?.id;
    if (!userId) return { sessions: [] };
    const list = await sessions.listByUser(userId);
    // Only the refresh cookie names a row in refresh_tokens (the access cookie
    // never hashes to one), so it is the credential that identifies this
    // browser's own session. No cookie / no row → nothing is "current".
    const currentRefreshToken = request.cookies?.[`${config.COOKIE_NAME}-refresh`];
    const currentRefreshRow = currentRefreshToken
      ? await sessions.findRefreshTokenByHash(hashToken(currentRefreshToken))
      : undefined;
    return {
      sessions: list.map((s) => ({
        id: s.id,
        deviceFingerprint: s.deviceFingerprint,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        current: !!currentRefreshRow && currentRefreshRow.id === s.refreshTokenId,
      })),
    };
  });

  app.delete("/sessions/:id", { preHandler: [app.authenticate, app.requireScopes("sessions:revoke")] }, async (request: FastifyRequest, reply: FastifyReply) => {
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

  app.post("/sessions/revoke-all", { preHandler: [app.authenticate, app.requireScopes("sessions:revoke")] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    // The refresh cookie carries the credential that must survive "log out
    // everywhere else"; the access cookie (`config.COOKIE_NAME`) never matches
    // a row in refresh_tokens, so reading it here left the except-branch dead.
    const currentRefreshToken = request.cookies?.[`${config.COOKIE_NAME}-refresh`];
    let exceptSessionId: string | undefined;
    let exceptRefreshTokenId: string | undefined;
    if (currentRefreshToken) {
      const row = await sessions.findRefreshTokenByHash(hashToken(currentRefreshToken));
      if (row) {
        exceptRefreshTokenId = row.id;
        exceptSessionId = (await sessions.findByRefreshTokenId(row.id))?.id;
      }
    }

    // Deleting session rows alone never revoked refresh_tokens, so every
    // outstanding refresh token kept minting access tokens after a revoke-all.
    const counts = await revokeUserSessions(userId, { exceptSessionId, exceptRefreshTokenId });
    await request.audit("sessions_revoked_all", {
      exceptSessionId,
      sessions: counts.sessions,
      refreshTokens: counts.refreshTokens,
    });
    return { success: true };
  });
}
