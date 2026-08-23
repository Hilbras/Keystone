import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userIdentities, identityProviders, orgMemberships, type User } from "../db/schema.js";

export interface OAuthClaims {
  sub: string;
  email: string;
  username?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function findUserByZitadelId(zitadelUserId: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.zitadelUserId, zitadelUserId)).limit(1);
  return user;
}

export async function createPasswordUser(input: {
  zitadelUserId?: string;
  passwordHash?: string;
  username: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      zitadelUserId: input.zitadelUserId ?? null,
      passwordHash: input.passwordHash ?? null,
      username: slugifyUsername(input.username),
      email: input.email.toLowerCase().trim(),
      name: input.name.trim() || input.username,
      provider: "password",
      emailVerified: input.emailVerified ?? true,
    })
    .returning();
  return user;
}

export async function upsertOAuthUser(
  claims: OAuthClaims,
  providerType: string,
  providerId?: string
): Promise<User> {
  const username = slugifyUsername(claims.username || claims.name || claims.email.split("@")[0]);
  const email = claims.email.toLowerCase().trim();

  // Prefer linking by external identity when a provider record is available.
  if (providerId) {
    const [existingLink] = await db
      .select({ user: users })
      .from(userIdentities)
      .where(eq(userIdentities.externalSub, claims.sub))
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .limit(1);

    if (existingLink) {
      const existing = existingLink.user;
      const [updated] = await db
        .update(users)
        .set({
          email,
          username: await ensureUniqueUsername(username, existing.id),
          name: claims.name || existing.name,
          avatarUrl: claims.picture || existing.avatarUrl,
          emailVerified: claims.email_verified ?? existing.emailVerified ?? true,
          provider: providerType,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, existing.id))
        .returning();
      return updated;
    }
  }

  // Fall back to email-based matching.
  const existing = await findUserByEmail(email);
  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email,
        username: await ensureUniqueUsername(username, existing.id),
        name: claims.name || existing.name,
        avatarUrl: claims.picture || existing.avatarUrl,
        emailVerified: claims.email_verified ?? existing.emailVerified ?? true,
        provider: providerType,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  const [user] = await db
    .insert(users)
    .values({
      email,
      username: await ensureUniqueUsername(username),
      name: claims.name || username,
      avatarUrl: claims.picture,
      emailVerified: claims.email_verified ?? true,
      provider: providerType,
    })
    .returning();

  if (providerId) {
    await db.insert(userIdentities).values({
      userId: user.id,
      providerId,
      providerType,
      externalSub: claims.sub,
      email,
      profile: { name: claims.name, picture: claims.picture, username: claims.username },
    });
  }

  return user;
}

export async function linkUserIdentity(
  userId: string,
  providerId: string,
  providerType: string,
  externalSub: string,
  email?: string,
  profile?: Record<string, unknown>
): Promise<void> {
  const [provider] = await db.select().from(identityProviders).where(eq(identityProviders.id, providerId)).limit(1);
  if (!provider) throw new Error("Identity provider not found");
  await db
    .insert(userIdentities)
    .values({
      userId,
      providerId,
      providerType,
      externalSub,
      email,
      profile: profile ?? {},
    })
    .onConflictDoNothing({ target: [userIdentities.providerId, userIdentities.externalSub] });
}

export async function updateUserLastSeen(id: string): Promise<void> {
  await db.update(users).set({ updatedAt: sql`now()` }).where(eq(users.id, id));
}

export async function findOrCreateUserByEmail(input: {
  email: string;
  name?: string;
  username?: string;
}): Promise<User> {
  const existing = await findUserByEmail(input.email);
  if (existing) return existing;

  const baseUsername = input.username || input.email.split("@")[0];
  const username = await ensureUniqueUsername(slugifyUsername(baseUsername));

  const [user] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase().trim(),
      username,
      name: input.name || username,
      provider: "password",
      emailVerified: false,
    })
    .returning();
  return user;
}

export async function listUsersByOrg(orgId: string): Promise<User[]> {
  const rows = await db
    .select({ user: users })
    .from(users)
    .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId));
  return rows.map((r) => r.user);
}

export async function updateUser(
  userId: string,
  updates: Partial<{
    name: string;
    username: string;
    role: string;
    emailVerified: boolean;
  }>
): Promise<User | undefined> {
  const [updated] = await db
    .update(users)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(eq(users.id, userId))
    .returning();
  return updated;
}

export async function deactivateUser(userId: string): Promise<void> {
  await db.update(users).set({ emailVerified: false, updatedAt: sql`now()` }).where(eq(users.id, userId));
}

export function slugifyUsername(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export async function ensureUniqueUsername(base: string, excludeId?: string): Promise<string> {
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

