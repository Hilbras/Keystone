import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, userIdentities, identityProviders, type User } from "../db/schema.js";
import type { CreateUserInput, UpdateUserInput, UserRepository } from "./types.js";

export class DrizzleUserRepository implements UserRepository {
  async findById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return user;
  }

  async create(input: CreateUserInput): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({
        email: input.email.toLowerCase().trim(),
        username: input.username,
        name: input.name.trim() || input.username,
        passwordHash: input.passwordHash ?? null,
        provider: input.provider ?? "password",
        emailVerified: input.emailVerified ?? true,
        avatarUrl: input.avatarUrl ?? null,
        zitadelUserId: input.zitadelUserId ?? null,
        metadata: input.metadata ?? {},
      })
      .returning();
    return user;
  }

  async update(id: string, input: UpdateUserInput): Promise<User | undefined> {
    const safeUpdates = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      ...(input.phoneVerified !== undefined ? { phoneVerified: input.phoneVerified } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const [updated] = await db
      .update(users)
      .set({ ...safeUpdates, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return updated;
  }

  async updateRole(id: string, role: "owner" | "user"): Promise<User | undefined> {
    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return updated;
  }

  async deactivate(id: string): Promise<void> {
    await db.update(users).set({ emailVerified: false, updatedAt: sql`now()` }).where(eq(users.id, id));
  }

  async listByOrg(orgId: string): Promise<User[]> {
    const rows = await db
      .select({ user: users })
      .from(users)
      .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
      .where(eq(orgMemberships.orgId, orgId));
    return rows.map((r) => r.user);
  }

  async updateLastSeen(id: string): Promise<void> {
    await db.update(users).set({ updatedAt: sql`now()` }).where(eq(users.id, id));
  }

  async recordFailedLogin(id: string): Promise<User | undefined> {
    const [updated] = await db
      .update(users)
      .set({ failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return updated;
  }

  async resetFailedLogins(id: string): Promise<void> {
    await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: sql`now()` })
      .where(eq(users.id, id));
  }

  async lockAccount(id: string, until: Date): Promise<void> {
    await db.update(users).set({ lockedUntil: until, updatedAt: sql`now()` }).where(eq(users.id, id));
  }

  async ensureUniqueUsername(base: string, excludeId?: string): Promise<string> {
    let username = base || "user";
    let counter = 2;
    while (true) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (existing.length === 0 || existing[0].id === excludeId) {
        return username;
      }
      username = `${base}-${counter}`;
      counter++;
    }
  }

  async listAll(): Promise<User[]> {
    return db.select().from(users);
  }

  async countByRole(role: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(users)
      .where(eq(users.role, role));
    return row?.count ?? 0;
  }

  async setTotpSecret(userId: string, totpSecret: string): Promise<void> {
    await db.update(users).set({ totpSecret, totpEnabled: false }).where(eq(users.id, userId));
  }

  async enableTotp(userId: string): Promise<void> {
    await db.update(users).set({ totpEnabled: true, totpVerifiedAt: new Date() }).where(eq(users.id, userId));
  }

  async disableTotp(userId: string): Promise<void> {
    await db.update(users).set({ totpSecret: null, totpEnabled: false, totpVerifiedAt: null }).where(eq(users.id, userId));
  }

  async deleteById(userId: string): Promise<void> {
    await db.delete(users).where(eq(users.id, userId));
  }
}

export class DrizzleIdentityRepository {
  async link(input: {
    userId: string;
    providerId: string;
    providerType: string;
    externalSub: string;
    email?: string;
    profile?: Record<string, unknown>;
  }): Promise<void> {
    await db
      .insert(userIdentities)
      .values({
        userId: input.userId,
        providerId: input.providerId,
        providerType: input.providerType,
        externalSub: input.externalSub,
        email: input.email,
        profile: input.profile ?? {},
      })
      .onConflictDoNothing({ target: [userIdentities.providerId, userIdentities.externalSub] });
  }

  async findLinkedByExternalSub(providerId: string, externalSub: string): Promise<User | undefined> {
    const [existing] = await db
      .select({ user: users })
      .from(userIdentities)
      .where(eq(userIdentities.externalSub, externalSub))
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .limit(1);
    return existing?.user;
  }

  async listByUserId(userId: string): Promise<{ identity: any; provider: { id: string; name: string; providerType: string } }[]> {
    return db
      .select({
        identity: userIdentities,
        provider: { id: identityProviders.id, name: identityProviders.name, providerType: identityProviders.providerType },
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .innerJoin(identityProviders, eq(userIdentities.providerId, identityProviders.id));
  }
}
