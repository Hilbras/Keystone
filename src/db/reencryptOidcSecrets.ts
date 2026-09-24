import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { oidcConnections } from "./schema.js";
import { encryptSecret } from "../services/secrets/index.js";
import { isLegacyOidcSecret, LEGACY_OIDC_SECRET_PREFIX } from "../services/oidcSecretFormat.js";

const allowUnmarkedPlaintext = process.argv.includes("--allow-unmarked-plaintext");

function looksEncrypted(value: string): boolean {
  if (value.startsWith("aes-256-gcm$") || value.startsWith("azure-key-vault$")) return true;
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  try {
    return Buffer.from(parts[0], "base64").length === 16 && parts[1].length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rows = await db.select().from(oidcConnections);
  let migrated = 0;
  for (const row of rows) {
    const value = row.clientSecret;
    const legacy = isLegacyOidcSecret(value);
    if (!legacy && (!allowUnmarkedPlaintext || looksEncrypted(value))) continue;
    const plaintext = legacy ? value.slice(LEGACY_OIDC_SECRET_PREFIX.length) : value;
    const encrypted = await encryptSecret(plaintext);
    await db.update(oidcConnections).set({ clientSecret: encrypted, updatedAt: new Date() }).where(eq(oidcConnections.id, row.id));
    migrated++;
  }
  console.log(`[db] migrated ${migrated} OIDC client secret(s)`);
}

await main();
