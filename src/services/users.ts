import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userIdentities, identityProviders, orgMemberships, type User } from "../db/schema.js";

export interface OAuthClaims {
  sub: string;
  email: string;
  username?: string;
  name?: string;
  picture?: string;
  emailVerified?: boolean;
  email_verified?: boolean;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user;
}

export async function findIdentityProviderByType(providerType: string) {
  const [provider] = await db
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.providerType, providerType), eq(identityProviders.isActive, true)))
    .limit(1);
  return provider;
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
  const verified = claims.emailVerified === true || claims.email_verified === true;
  if (!verified) {
    throw new Error("Identity provider did not verify the email address");
  }
  const username = slugifyUsername(claims.username || claims.name || claims.email.split("@")[0]);
  const email = claims.email.toLowerCase().trim();

  // Only an explicit provider/subject link may identify an existing account.
  if (providerId) {
    const [existingLink] = await db
      .select({ user: users })
      .from(userIdentities)
      .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.externalSub, claims.sub)))
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .limit(1);

    if (existingLink) {
      const existing = existingLink.user;
      if (!existing.isActive || existing.accountReviewRequired) throw new Error("User account is unavailable");
      const [updated] = await db
        .update(users)
        .set({
          email,
          username: await ensureUniqueUsername(username, existing.id),
          name: claims.name || existing.name,
          avatarUrl: claims.picture || existing.avatarUrl,
          emailVerified: true,
          provider: providerType,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, existing.id))
        .returning();
      return updated;
    }
  }

  // Email equality alone is never proof of identity. Existing users must be
  // linked through an explicitly provisioned provider/subject identity.
  const existingByEmail = await findUserByEmail(email);
  if (existingByEmail) {
    throw new Error("Existing account requires an explicit external identity link");
  }

  const [user] = await db
    .insert(users)
    .values({
      email,
      username: await ensureUniqueUsername(username),
      name: claims.name || username,
      avatarUrl: claims.picture,
      emailVerified: true,
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

export async function listUsersByOrg(orgId: string): Promise<User[]> {
  const rows = await db
    .select({ user: users })
    .from(users)
    .innerJoin(orgMemberships, eq(users.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId));
  return rows.map((r) => r.user);
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

