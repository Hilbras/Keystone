import crypto from "node:crypto";
import { eq, and, or, gt, isNull } from "drizzle-orm";
import { importPKCS8, importSPKI, exportPKCS8, exportSPKI, generateKeyPair, type KeyLike } from "jose";
import { db } from "../../db/index.js";
import { secrets, type Secret } from "../../db/schema.js";
import { config } from "../../config.js";
import type { SecretsProvider, SigningKeyPair } from "./provider.js";
import { hashPassword, verifyPassword } from "./password.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_ID_BYTES = 8;

export class DatabaseSecretsProvider implements SecretsProvider {
  readonly name = "database";

  hashPassword = hashPassword;
  verifyPassword = verifyPassword;

  hashApiKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  hashClientSecret(secret: string): string {
    return crypto.createHash("sha256").update(secret).digest("hex");
  }

  generateClientSecret(): string {
    return `cs_${crypto.randomBytes(32).toString("base64url")}`;
  }

  generateApiKey(): { key: string; prefix: string } {
    const key = `ks_${crypto.randomBytes(32).toString("base64url")}`;
    const prefix = key.slice(0, 7);
    return { key, prefix };
  }

  async getActiveSigningKey(): Promise<SigningKeyPair> {
    const [active] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.type, "jwt_signing"), eq(secrets.isActive, true), isNull(secrets.expiresAt)))
      .orderBy(secrets.createdAt)
      .limit(1);

    if (active) {
      return this.loadKeyPair(active);
    }

    return this.createSigningKey();
  }

  async getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined> {
    const [record] = await db.select().from(secrets).where(eq(secrets.keyId, keyId)).limit(1);
    if (!record || record.type !== "jwt_signing") return undefined;
    return this.loadKeyPair(record);
  }

  async rotateSigningKeys(): Promise<SigningKeyPair> {
    await db
      .update(secrets)
      .set({ isActive: false, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      .where(eq(secrets.type, "jwt_signing"));
    return this.createSigningKey();
  }

  private async createSigningKey(): Promise<SigningKeyPair> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privatePem = await exportPKCS8(pair.privateKey);
    const publicPem = await exportSPKI(pair.publicKey);
    const keyId = crypto.randomBytes(KEY_ID_BYTES).toString("base64url");

    await db.insert(secrets).values({
      keyId,
      type: "jwt_signing",
      value: JSON.stringify({ private: privatePem, public: publicPem }),
      algorithm: "RS256",
      isActive: true,
      rotatedAt: new Date(),
    });

    return { keyId, privateKey: pair.privateKey, publicKey: pair.publicKey };
  }

  private async loadKeyPair(record: Secret): Promise<SigningKeyPair> {
    const parsed = JSON.parse(record.value) as { private: string; public: string };
    const privateKey = await importPKCS8(parsed.private, "RS256");
    const publicKey = await importSPKI(parsed.public, "RS256");
    return { keyId: record.keyId, privateKey, publicKey };
  }

  async getEncryptionKey(): Promise<Buffer> {
    if (config.KEYSTONE_ENCRYPTION_KEY) {
      return crypto.createHash("sha256").update(config.KEYSTONE_ENCRYPTION_KEY).digest();
    }

    const [active] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.type, "encryption"), eq(secrets.isActive, true)))
      .limit(1);

    if (active) {
      return Buffer.from(active.value, "base64url");
    }

    const value = crypto.randomBytes(32);
    await db.insert(secrets).values({
      keyId: `enc-${crypto.randomBytes(KEY_ID_BYTES).toString("base64url")}`,
      type: "encryption",
      value: value.toString("base64url"),
      algorithm: "aes-256-gcm",
      isActive: true,
    });
    return value;
  }

  async encryptSecret(plain: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, encrypted]);
    return `${ENCRYPTION_ALGORITHM}$${payload.toString("base64url")}`;
  }

  async decryptSecret(cipherText: string): Promise<string> {
    if (!cipherText.startsWith(`${ENCRYPTION_ALGORITHM}$`)) {
      throw new Error("Unsupported cipher format");
    }
    const key = await this.getEncryptionKey();
    const payload = Buffer.from(cipherText.slice(`${ENCRYPTION_ALGORITHM}$`.length), "base64url");
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  async listActiveSigningKeys(): Promise<{ keyId: string; createdAt: Date; expiresAt?: Date | null }[]> {
    const rows = await db
      .select({ keyId: secrets.keyId, createdAt: secrets.createdAt, expiresAt: secrets.expiresAt })
      .from(secrets)
      .where(and(eq(secrets.type, "jwt_signing"), eq(secrets.isActive, true)))
      .orderBy(secrets.createdAt);
    return rows;
  }

  async listValidSigningKeys(): Promise<SigningKeyPair[]> {
    const now = new Date();
    const rows = await db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.type, "jwt_signing"),
          or(eq(secrets.isActive, true), and(eq(secrets.isActive, false), gt(secrets.expiresAt, now)))
        )
      )
      .orderBy(secrets.createdAt);
    return Promise.all(rows.map((row) => this.loadKeyPair(row)));
  }
}
