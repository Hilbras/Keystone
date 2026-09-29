import { eq } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { db } from "../db/index.js";
import { redis } from "./redis.js";
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

/**
 * Ceremony challenges, in Redis.
 *
 * Two defects lived here, and both were found by §4.2 writing the first test that
 * drove a real ceremony. They are recorded in the roadmap as SEC-050 and SEC-051;
 * the shape of the fix is worth reading because the first one is a trap.
 *
 * **The store is keyed by exactly the value that goes into the cookie.** It used
 * to be keyed by `createChallenge()`, which returned a random string, and that
 * string was then passed to `generateRegistrationOptions` as `challenge`.
 * `@simplewebauthn/server` re-encodes a string challenge —
 * `isoBase64URL.fromBuffer(isoUint8Array.fromUTF8String(challenge))` — so the
 * value it returns is the base64url encoding of the *ASCII bytes* of what was
 * passed in, which is a different string. The cookie held one value, the store was
 * keyed by the other, and `consumeChallenge` missed every time. Every passkey
 * registration and every passkey sign-in returned 400 "Invalid challenge". The
 * feature did not work at all, and no test had driven it, because the only
 * WebAuthn test asserted a *refusal* and the refusal happens before the challenge
 * is read.
 *
 * So the challenge is no longer generated here and passed in. SimpleWebAuthn
 * generates it, and the store is keyed on what it returns. There is no second
 * value to keep in step, which is the only way this class of bug stops recurring.
 *
 * **The store is Redis, not a process-local `Map`.** `docs/DEPLOYMENT.md`
 * recommends "multiple Keystone containers behind a load balancer" and
 * `docs/ARCHITECTURE.md` promises "horizontal scaling through Redis-backed
 * state". A `Map` is per-process, so with two containers a challenge minted on one
 * could not be consumed on the other and half of all ceremonies failed —
 * intermittently, and only in production, which is the worst place to find out.
 *
 * `GETDEL` rather than `GET` then `DEL`: the challenge is single-use, and a
 * read-then-delete is the same race `singleUse.ts` exists to prevent.
 */
const CHALLENGE_TTL_SECONDS = 300;

const keyFor = (challenge: string): string =>
  `${config.CACHE_KEY_PREFIX || "keystone:"}webauthn:challenge:${challenge}`;

/**
 * Remember a challenge, keyed by the value the client will present.
 *
 * Takes the challenge rather than making one. The caller must pass
 * `options.challenge` verbatim — see the note above on why nothing generates a
 * second value here.
 */
export async function storeChallenge(challenge: string, userId?: string): Promise<void> {
  const record: WebAuthnChallenge = {
    challenge,
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  };
  // Awaited, not fired and forgotten. The caller is about to hand this challenge
  // to the client, and a write that is still in flight means the client can
  // complete the ceremony before the record exists — which surfaces as a
  // "Invalid challenge" 400 on the very next request, with nothing in the logs
  // and no way to tell a race from an attack.
  //
  // A failed write therefore propagates: handing out a challenge that provably
  // cannot be redeemed is worse than refusing to start the ceremony.
  await redis.set(keyFor(challenge), JSON.stringify(record), "EX", CHALLENGE_TTL_SECONDS);
}

/**
 * Redeem a challenge, exactly once.
 *
 * Async because the store is Redis, and the claim is `GETDEL` — one command, so
 * two simultaneous ceremonies presenting the same challenge cannot both win.
 */
export async function consumeChallenge(challenge: string): Promise<WebAuthnChallenge | undefined> {
  const raw = await redis.getdel(keyFor(challenge));
  if (raw === null) return undefined;
  const record = JSON.parse(raw) as WebAuthnChallenge;
  // Redis's own TTL is the backstop; this is the check that survives a clock
  // disagreement between the writer and the reader, which is a real thing when
  // two containers' clocks drift.
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
  // No `challenge` passed in. SimpleWebAuthn generates one and re-encodes
  // whatever it is given, so the only value guaranteed to round-trip is the one
  // it returns — see the note on `storeChallenge`.
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(),
    userName: user.email,
    userDisplayName: user.name || user.username,
    userID: Buffer.from(user.id, "utf8"),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  await storeChallenge(options.challenge, user.id);
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
    transports: (credential.transports || []) as AuthenticatorTransport[],
    aaguid: info.aaguid || null,
    deviceName: deviceName || null,
  });

  return { verified: true };
}

export async function buildAuthenticationOptions(email?: string) {
  let allowCredentials:
    | { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[]
    | undefined;
  let userId: string | undefined;

  if (email) {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (user && user.isActive) {
      userId = user.id;
      const credentials = await listCredentialsByUser(user.id);
      allowCredentials = credentials.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: (c.transports || []) as AuthenticatorTransport[],
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials,
    userVerification: "preferred",
  });
  await storeChallenge(options.challenge, userId);

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
      transports: (credential.transports || []) as AuthenticatorTransport[],
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
  if (!user?.isActive) {
    throw new Error("User account is deactivated");
  }

  return { verified: true, user, credentialRegisteredAt: credential.createdAt };
}
