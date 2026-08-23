import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SessionRepository } from "../repositories/session.js";
import { revokeRefreshToken } from "../services/tokens.js";
import { db } from "../db/index.js";
import { refreshTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";

const sessions = new SessionRepository();

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

    // Revoke the associated refresh token.
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, session.refreshTokenId));
    await sessions.deleteById(id, userId);

    return { success: true };
  });

  app.post("/sessions/revoke-all", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const currentRefreshToken = request.cookies?.[config.COOKIE_NAME];
    let currentRefreshTokenId: string | undefined;
    if (currentRefreshToken) {
      const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(currentRefreshToken))).limit(1);
      currentRefreshTokenId = row?.id;
    }

    await sessions.deleteAllForUser(userId, currentRefreshTokenId);
    return { success: true };
  });
}

import { config } from "../config.js";
import crypto from "node:crypto";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
