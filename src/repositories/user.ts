import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, userIdentities, identityProviders, refreshTokens, apiKeys, userSessions, type User } from "../db/schema.js";
import { LastOwnerInvariantError, type CreateUserInput, type UpdateUserInput, type UserRepository } from "./types.js";

/**
 * Columns a generic update may write. Both the global and the
 * organization-scoped update path share this allowlist so they cannot drift,
 * and so a field like `role` is never reachable through a profile update.
 */
function writableColumns(input: UpdateUserInput) {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.username !== undefined ? { username: input.username } : {}),
    ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
    ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
    ...(input.phoneVerified !== undefined ? { phoneVerified: input.phoneVerified } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.accountReviewRequired !== undefined ? { accountReviewRequired: input.accountReviewRequired } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

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
    const [updated] = await db
      .update(users)
      .set({ ...writableColumns(input), updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return updated;
  }

  async updateRole(id: string, role: "owner" | "user"): Promise<User | undefined> {
    if (role !== "owner" && role !== "user") throw new Error("Invalid platform role");

    return db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!target) return undefined;

      if (target.role === "owner" && role === "user") {
        const owners = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
          .for("update");
        if (owners.length <= 1) throw new LastOwnerInvariantError("Cannot demote the last platform owner");
      }

      const [updated] = await tx
        .update(users)
        .set({ role, updatedAt: sql`now()` })
        .where(eq(users.id, id))
        .returning();
      return updated;
    });
  }

  async deactivate(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!target) return;
      if (target.role === "owner" && target.isActive) {
        const owners = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
          .for("update");
        if (owners.length <= 1) throw new LastOwnerInvariantError("Cannot deactivate the last platform owner");
      }
      const now = new Date();
      await tx
        .update(users)
        .set({ isActive: false, accountReviewRequired: false, emailVerified: false, passwordHash: null, totpSecret: null, totpEnabled: false, updatedAt: now })
        .where(eq(users.id, id));
      await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
      await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.userId, id), isNull(apiKeys.revokedAt)));
      await tx.delete(userSessions).where(eq(userSessions.userId, id));
    });
  }

  async listByOrg(orgId: string): Promise<User[]> {
    const rows = await db
      .select({ user: users })
      .from(users)
      .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
      .where(eq(orgMemberships.orgId, orgId));
    return rows.map((r) => r.user);
  }

  async findByIdInOrg(orgId: string, userId: string): Promise<User | undefined> {
    const [row] = await db
      .select({ user: users })
      .from(users)
      .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
      .where(and(eq(orgMemberships.orgId, orgId), eq(users.id, userId)))
      .limit(1);
    return row?.user;
  }

  /**
   * Organization-scoped update. The membership check is part of the statement,
   * so a caller cannot update a global user row by passing a user id that is
   * outside the organization.
   */
  async updateInOrg(orgId: string, userId: string, input: UpdateUserInput): Promise<User | undefined> {
    const changes = writableColumns(input);
    if (Object.keys(changes).length === 0) return this.findByIdInOrg(orgId, userId);

    const [updated] = await db
      .update(users)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(
        and(
          eq(users.id, userId),
          sql`exists (select 1 from ${orgMemberships} m where m.user_id = ${users.id} and m.org_id = ${orgId})`
        )
      )
      .returning();
    return updated;
  }

  async listOrgIdsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, userId));
    return rows.map((r) => r.orgId);
  }

  /**
   * Remove a user from one organization without reaching outside it.
   *
   * A user row is global, so a blanket deactivation would revoke that person's
   * access to every other organization they belong to — an action this
   * credential is not authorized to take. The membership is therefore removed
   * first, and the account is only deactivated once no membership remains.
   */
  async removeFromOrg(
    orgId: string,
    userId: string
  ): Promise<
    | { outcome: "membership_removed" | "deactivated" | "not_found" | "last_owner"; user?: User }
    | undefined
  > {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ user: users, role: orgMemberships.role })
        .from(users)
        .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
        .where(and(eq(orgMemberships.orgId, orgId), eq(users.id, userId)))
        .limit(1)
        .for("update");
      if (!row) return { outcome: "not_found" as const };

      if (row.user.role === "owner") {
        return { outcome: "last_owner" as const, user: row.user };
      }

      const memberships = await tx
        .select({ id: orgMemberships.id, orgId: orgMemberships.orgId })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, userId))
        .for("update");

      await tx
        .delete(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)));

      if (memberships.length > 1) {
        // Still a member elsewhere: leave the shared account intact.
        return { outcome: "membership_removed" as const, user: row.user };
      }

      const now = new Date();
      const [deactivated] = await tx
        .update(users)
        .set({ isActive: false, accountReviewRequired: false, emailVerified: false, passwordHash: null, totpSecret: null, totpEnabled: false, updatedAt: now })
        .where(eq(users.id, userId))
        .returning();
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      await tx
        .update(apiKeys)
        .set({ revokedAt: now })
        .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
      await tx.delete(userSessions).where(eq(userSessions.userId, userId));

      return { outcome: "deactivated" as const, user: deactivated ?? row.user };
    });
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
      .where(and(eq(users.role, role), eq(users.isActive, true)));
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
