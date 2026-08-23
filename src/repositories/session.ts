import { db } from "../db/index.js";
import { userSessions } from "../db/schema.js";
import { eq, and, lt, desc } from "drizzle-orm";

export interface CreateSessionInput {
  userId: string;
  refreshTokenId: string;
  deviceFingerprint?: string;
  ipAddress?: string;
  userAgent?: string;
  expiresAt: Date;
}

export class SessionRepository {
  async create(input: CreateSessionInput) {
    const [session] = await db.insert(userSessions).values({
      userId: input.userId,
      refreshTokenId: input.refreshTokenId,
      deviceFingerprint: input.deviceFingerprint ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: input.expiresAt,
    }).returning();
    return session;
  }

  async listByUser(userId: string) {
    return db.select().from(userSessions)
      .where(eq(userSessions.userId, userId))
      .orderBy(desc(userSessions.lastSeenAt));
  }

  async findByRefreshTokenId(refreshTokenId: string) {
    const [session] = await db.select().from(userSessions)
      .where(eq(userSessions.refreshTokenId, refreshTokenId))
      .limit(1);
    return session;
  }

  async findById(id: string) {
    const [session] = await db.select().from(userSessions)
      .where(eq(userSessions.id, id))
      .limit(1);
    return session;
  }

  async updateLastSeen(id: string) {
    await db.update(userSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(userSessions.id, id));
  }

  async deleteById(id: string, userId: string) {
    const result = await db.delete(userSessions)
      .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId)));
    return result.count > 0;
  }

  async deleteByRefreshTokenId(refreshTokenId: string) {
    await db.delete(userSessions)
      .where(eq(userSessions.refreshTokenId, refreshTokenId));
  }

  async deleteExpired() {
    await db.delete(userSessions)
      .where(lt(userSessions.expiresAt, new Date()));
  }

  async deleteAllForUser(userId: string, exceptRefreshTokenId?: string) {
    if (exceptRefreshTokenId) {
      await db.delete(userSessions)
        .where(and(eq(userSessions.userId, userId), lt(userSessions.refreshTokenId, exceptRefreshTokenId)));
    } else {
      await db.delete(userSessions).where(eq(userSessions.userId, userId));
    }
  }
}
