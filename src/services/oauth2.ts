import crypto from "node:crypto";
import { eq, and, gt, isNull, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  oauth2AuthorizationCodes,
  oauth2Consents,
  applications,
  users,
  type User,
  type Application,
} from "../db/schema.js";
import { config } from "../config.js";
import { createTokenSet, createIdToken, type AccessTokenOptions } from "./tokens.js";

export interface AuthorizationCodeInput {
  appId: string;
  userId: string;
  challenge?: string;
  challengeMethod?: string;
  redirectUri?: string;
  scopes?: string[];
  nonce?: string;
}

export function generateAuthorizationCode(): { code: string; codeHash: string } {
  const code = crypto.randomBytes(48).toString("base64url");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  return { code, codeHash };
}

export async function storeAuthorizationCode(input: AuthorizationCodeInput) {
  const { code, codeHash } = generateAuthorizationCode();
  const expiresAt = new Date(Date.now() + config.OAUTH_CODE_TTL_SECONDS * 1000);

  const [record] = await db
    .insert(oauth2AuthorizationCodes)
    .values({
      appId: input.appId,
      userId: input.userId,
      codeHash,
      challenge: input.challenge ?? null,
      challengeMethod: input.challengeMethod ?? null,
      redirectUri: input.redirectUri ?? null,
      scopes: input.scopes ?? [],
      nonce: input.nonce ?? null,
      expiresAt,
    })
    .returning();

  return { ...record, code };
}

export async function consumeAuthorizationCode(
  code: string,
  appId: string,
  redirectUri?: string
): Promise<typeof oauth2AuthorizationCodes.$inferSelect | undefined> {
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const now = new Date();

  const [record] = await db
    .select()
    .from(oauth2AuthorizationCodes)
    .where(
      and(
        eq(oauth2AuthorizationCodes.codeHash, codeHash),
        eq(oauth2AuthorizationCodes.appId, appId),
        gt(oauth2AuthorizationCodes.expiresAt, now),
        isNull(oauth2AuthorizationCodes.usedAt)
      )
    )
    .limit(1);

  if (!record) return undefined;
  if (redirectUri && record.redirectUri && record.redirectUri !== redirectUri) {
    return undefined;
  }

  await db
    .update(oauth2AuthorizationCodes)
    .set({ usedAt: now })
    .where(eq(oauth2AuthorizationCodes.id, record.id));

  return record;
}

export function verifyPKCE(
  challenge: string | null | undefined,
  method: string | null | undefined,
  verifier: string
): boolean {
  if (!challenge) return true;
  if (method?.toLowerCase() !== "s256") return false;
  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return hash === challenge;
}

export async function hasConsent(
  userId: string,
  appId: string,
  requestedScopes: string[]
): Promise<boolean> {
  if (requestedScopes.length === 0) return true;

  const [consent] = await db
    .select()
    .from(oauth2Consents)
    .where(
      and(
        eq(oauth2Consents.appId, appId),
        eq(oauth2Consents.userId, userId),
        isNull(oauth2Consents.revokedAt)
      )
    )
    .limit(1);

  if (!consent) return false;
  const granted = new Set(consent.scopes);
  return requestedScopes.every((scope) => granted.has(scope));
}

export async function grantConsent(userId: string, appId: string, scopes: string[]) {
  const now = new Date();
  const [record] = await db
    .insert(oauth2Consents)
    .values({
      appId,
      userId,
      scopes,
      grantedAt: now,
    })
    .onConflictDoUpdate({
      target: [oauth2Consents.appId, oauth2Consents.userId],
      set: {
        scopes,
        grantedAt: now,
        revokedAt: null,
      },
    })
    .returning();
  return record;
}

export async function revokeConsent(userId: string, appId: string): Promise<void> {
  await db
    .update(oauth2Consents)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauth2Consents.appId, appId), eq(oauth2Consents.userId, userId)));
}

export async function listConsentsByAppId(appId: string) {
  return db
    .select()
    .from(oauth2Consents)
    .where(and(eq(oauth2Consents.appId, appId), isNull(oauth2Consents.revokedAt)));
}

export async function createTokenResponse(
  user: User,
  app: Application,
  scopes: string[],
  opts: { ip?: string; userAgent?: string; deviceFingerprint?: string; nonce?: string } = {}
) {
  const tokenOpts: AccessTokenOptions = {
    appId: app.id,
    orgId: app.orgId,
    clientId: app.clientId,
  };

  const tokenSet = await createTokenSet(
    user,
    opts.ip,
    opts.userAgent,
    tokenOpts,
    opts.deviceFingerprint
  );

  const response: Record<string, unknown> = {
    access_token: tokenSet.accessToken,
    refresh_token: tokenSet.refreshToken,
    token_type: "Bearer",
    expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  };

  if (scopes.includes("openid")) {
    response.id_token = await createIdToken(user, app, opts.nonce);
  }

  return response;
}

export async function findApplicationByClientId(clientId: string): Promise<Application | undefined> {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
    .limit(1);
  return app;
}

export async function verifyClientSecret(
  clientId: string,
  secret: string
): Promise<Application | undefined> {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
    .limit(1);

  if (!app) return undefined;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  if (app.clientSecretHash !== hash) return undefined;
  return app;
}
