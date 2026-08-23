/**
 * Example: protect an API route using a Keystone access token.
 *
 * Your frontend sends the access token as:
 *   Authorization: Bearer <access-token>
 *
 * Your backend verifies it by fetching Keystone's JWKS.
 */

import { createPublicKey } from "node:crypto";
import { jwtVerify, createLocalJWKSet, type JWTPayload } from "jose";

const KEYSTONE_URL = process.env.KEYSTONE_URL || "http://localhost:4001";

interface KeystoneToken extends JWTPayload {
  sub: string;
  email: string;
  username?: string;
}

let jwks: ReturnType<typeof createLocalJWKSet> | null = null;

async function getJwks() {
  if (jwks) return jwks;
  const res = await fetch(`${KEYSTONE_URL}/.well-known/jwks.json`);
  const data = await res.json();
  jwks = createLocalJWKSet(data);
  return jwks;
}

export async function verifyKeystoneToken(token: string): Promise<KeystoneToken> {
  const jwks = await getJwks();
  const { payload } = await jwtVerify(token, jwks, {
    issuer: KEYSTONE_URL,
    audience: undefined, // set to your client_id in production
  });
  return payload as KeystoneToken;
}

// Express example
// import type { Request, Response, NextFunction } from "express";
// export async function requireAuth(req: Request, res: Response, next: NextFunction) {
//   const header = req.headers.authorization;
//   if (!header?.startsWith("Bearer ")) return res.status(401).send({ error: "Unauthorized" });
//   try {
//     req.user = await verifyKeystoneToken(header.slice(7));
//     next();
//   } catch {
//     res.status(401).send({ error: "Invalid token" });
//   }
// }
