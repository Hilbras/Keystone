import crypto from "node:crypto";
import { importPKCS8, importSPKI, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { config } from "../../config.js";
import type { SecretsProvider, SigningKeyPair } from "./provider.js";
import { hashPassword, verifyPassword } from "./password.js";
import { serviceLogger } from "../../lib/logger.js";

const moduleLog = serviceLogger("secrets");

let envKeyPair: SigningKeyPair | null = null;
let envEncryptionKey: Buffer | null = null;

export class EnvironmentSecretsProvider implements SecretsProvider {
  readonly name = "environment";

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
    if (envKeyPair) return envKeyPair;

    if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
      const privateKey = await importPKCS8(config.JWT_PRIVATE_KEY, "RS256");
      const publicKey = await importSPKI(config.JWT_PUBLIC_KEY, "RS256");
      envKeyPair = { keyId: "env", privateKey, publicKey };
      return envKeyPair;
    }

    if (config.NODE_ENV === "production") {
      throw new Error("EnvironmentSecretsProvider requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY in production");
    }

    // Outside production, and only when the environment supplies no keys, one is
    // generated so a developer can start the server with nothing configured. It
    // is ephemeral, and the two lines below exist so the developer can capture it:
    // a key that only ever existed in this process's memory is a key that
    // invalidates every token the next time the process restarts.
    //
    // Both PEMs are logged, including the private one. That is safe here and only
    // here: the branch is unreachable when `NODE_ENV=production`, which throws
    // above, and an operator who has a development key pair in their console has
    // already published it by running a dev server with no keys configured.
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privatePem = await exportPKCS8(pair.privateKey);
    const publicPem = await exportSPKI(pair.publicKey);
    moduleLog.warn(
      {},
      "Generated ephemeral JWT keys. Set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY in production. " +
        "The PEMs follow, in order private then public."
    );
    moduleLog.warn({}, `JWT_PRIVATE_KEY\n${privatePem}`);
    moduleLog.warn({}, `JWT_PUBLIC_KEY\n${publicPem}`);
    envKeyPair = { keyId: "env-generated", privateKey: pair.privateKey, publicKey: pair.publicKey };
    return envKeyPair;
  }

  async getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined> {
    const active = await this.getActiveSigningKey();
    if (active.keyId === keyId) return active;
    return undefined;
  }

  async rotateSigningKeys(): Promise<SigningKeyPair> {
    envKeyPair = null;
    return this.getActiveSigningKey();
  }

  async listActiveSigningKeys(): Promise<{ keyId: string; createdAt: Date; expiresAt?: Date | null }[]> {
    const active = await this.getActiveSigningKey();
    return [{ keyId: active.keyId, createdAt: new Date(), expiresAt: null }];
  }

  async listValidSigningKeys(): Promise<SigningKeyPair[]> {
    const active = await this.getActiveSigningKey();
    return [active];
  }

  async getEncryptionKey(): Promise<Buffer> {
    if (envEncryptionKey) return envEncryptionKey;
    if (config.KEYSTONE_ENCRYPTION_KEY) {
      envEncryptionKey = crypto.createHash("sha256").update(config.KEYSTONE_ENCRYPTION_KEY).digest();
      return envEncryptionKey;
    }
    envEncryptionKey = crypto.randomBytes(32);
    moduleLog.warn(
      {},
      "Generated an ephemeral encryption key. Set KEYSTONE_ENCRYPTION_KEY in " +
        "production — without it, every encrypted secret becomes unreadable on restart."
    );
    return envEncryptionKey;
  }

  async encryptSecret(plain: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, encrypted]);
    return `aes-256-gcm$${payload.toString("base64url")}`;
  }

  async decryptSecret(cipherText: string): Promise<string> {
    if (!cipherText.startsWith("aes-256-gcm$")) {
      throw new Error("Unsupported cipher format");
    }
    const key = await this.getEncryptionKey();
    const payload = Buffer.from(cipherText.slice("aes-256-gcm$".length), "base64url");
    const iv = payload.subarray(0, 16);
    const tag = payload.subarray(16, 32);
    const encrypted = payload.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
