import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { db } from "../db/index.js";
import {
  webauthnCredentials,
  users,
  type User,
  type WebAuthnCredential as DbWebAuthnCredential,
} from "../db/schema.js";
import { config } from "../config.js";

const RP_NAME = "Hilbras Keystone";

function rpID(): string {
  const url = config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
  return new URL(url).hostname;
}

function origin(): string {
  return config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
}

export interface WebAuthnChallenge {
  challenge: string;
  userId?: string;
  expiresAt: number;
}

const challenges = new Map<string, WebAuthnChallenge>();

function cleanupChallenges(): void {
  const now = Date.now();
  for (const [key, value] of challenges) {
    if (value.expiresAt < now) challenges.delete(key);
  }
}

export function createChallenge(userId?: string): string {
  cleanupChallenges();
  const challenge = crypto.randomBytes(32).toString("base64url");
  challenges.set(challenge, { challenge, userId, expiresAt: Date.now() + 5 * 60 * 1000 });
  return challenge;
}

export function consumeChallenge(challenge: string): WebAuthnChallenge | undefined {
  const record = challenges.get(challenge);
  challenges.delete(challenge);
  if (!record) return undefined;
  if (record.expiresAt < Date.now()) return undefined;
  return record;
}

export async function listCredentialsByUser(userId: string): Promise<DbWebAuthnCredential[]> {
  return db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
}

export async function findCredentialById(credentialId: string): Promise<DbWebAuthnCredential | undefined> {
  const [record] = await db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, credentialId))
    .limit(1);
  return record;
}

export async function buildRegistrationOptions(user: User) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(),
    userName: user.email,
    userDisplayName: user.name || user.username,
    userID: Buffer.from(user.id, "utf8"),
    challenge: createChallenge(user.id),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return options;
}

export async function verifyAndStoreRegistration(
  user: User,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  deviceName?: string
) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("WebAuthn registration verification failed");
  }

  const info = verification.registrationInfo;
  const credential = info.credential;
  await db.insert(webauthnCredentials).values({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: (credential.transports || []) as AuthenticatorTransportFuture[],
    aaguid: info.aaguid || null,
    deviceName: deviceName || null,
  });

  return { verified: true };
}

export async function buildAuthenticationOptions(email?: string) {
  let allowCredentials:
    | { id: string; type: "public-key"; transports?: AuthenticatorTransportFuture[] }[]
    | undefined;
  let userId: string | undefined;

  if (email) {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (user) {
      userId = user.id;
      const credentials = await listCredentialsByUser(user.id);
      allowCredentials = credentials.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: (c.transports || []) as AuthenticatorTransportFuture[],
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    challenge: createChallenge(userId),
    allowCredentials,
    userVerification: "preferred",
  });

  return options;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string) {
  const credentialId = response.id;
  const credential = await findCredentialById(credentialId);
  if (!credential) {
    throw new Error("Credential not found");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: credential.counter,
      transports: (credential.transports || []) as AuthenticatorTransportFuture[],
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error("WebAuthn authentication verification failed");
  }

  await db
    .update(webauthnCredentials)
    .set({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    })
    .where(eq(webauthnCredentials.id, credential.id));

  const [user] = await db.select().from(users).where(eq(users.id, credential.userId)).limit(1);
  if (!user) {
    throw new Error("User not found");
  }

  return { verified: true, user };
}
