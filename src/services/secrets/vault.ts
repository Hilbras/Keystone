import crypto from "node:crypto";
import { importPKCS8, importSPKI, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import type { SecretsProvider, SigningKeyPair } from "./provider.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * HashiCorp Vault secrets provider.
 *
 * This is a reference implementation. In production it should call the
 * Vault HTTP API (or use a Vault client library) to retrieve signing keys,
 * encryption keys, and credentials. The password hashing helpers are reused
 * locally because they are compute-bound and do not need external storage.
 */
export class VaultSecretsProvider implements SecretsProvider {
  readonly name = "vault";

  hashPassword = hashPassword;
  verifyPassword = verifyPassword;

  private vaultAddr: string;
  private vaultToken: string;
  private mountPath: string;

  constructor() {
    this.vaultAddr = (process.env.VAULT_ADDR || "").replace(/\/$/, "");
    this.vaultToken = process.env.VAULT_TOKEN || "";
    this.mountPath = (process.env.VAULT_MOUNT_PATH || "secret").replace(/(^\/)|(\/$)/g, "");

    if (!this.vaultAddr || !this.vaultToken) {
      throw new Error("VaultSecretsProvider requires VAULT_ADDR and VAULT_TOKEN");
    }
  }

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
    return { key, prefix: key.slice(0, 7) };
  }

  async getActiveSigningKey(): Promise<SigningKeyPair> {
    const stored = await this.readPath("jwt/active");
    if (stored?.private && stored?.public) {
      const privateKey = await importPKCS8(String(stored.private), "RS256");
      const publicKey = await importSPKI(String(stored.public), "RS256");
      return { keyId: String(stored.keyId ?? "vault-active"), privateKey, publicKey };
    }
    return this.rotateSigningKeys();
  }

  async getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined> {
    const active = await this.getActiveSigningKey();
    if (active.keyId === keyId) return active;
    const stored = await this.readPath(`jwt/${keyId}`);
    if (!stored?.private) return undefined;
    const privateKey = await importPKCS8(String(stored.private), "RS256");
    const publicKey = await importSPKI(String(stored.public), "RS256");
    return { keyId, privateKey, publicKey };
  }

  async rotateSigningKeys(): Promise<SigningKeyPair> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privatePem = await exportPKCS8(pair.privateKey);
    const publicPem = await exportSPKI(pair.publicKey);
    const keyId = `vault-${crypto.randomBytes(8).toString("base64url")}`;

    await this.writePath("jwt/active", { keyId, private: privatePem, public: publicPem, rotatedAt: new Date().toISOString() });

    return { keyId, privateKey: pair.privateKey, publicKey: pair.publicKey };
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
    const stored = await this.readPath("encryption/active");
    if (stored?.value) {
      return Buffer.from(String(stored.value), "base64url");
    }
    const value = crypto.randomBytes(32);
    await this.writePath("encryption/active", { value: value.toString("base64url") });
    return value;
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

  private async readPath(path: string): Promise<Record<string, unknown> | undefined> {
    const url = `${this.vaultAddr}/v1/${this.mountPath}/data/${path}`;
    const res = await fetch(url, {
      headers: { "X-Vault-Token": this.vaultToken },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Vault read failed: ${res.status}`);
    const data = (await res.json()) as { data?: { data?: Record<string, unknown> } };
    return data.data?.data;
  }

  private async writePath(path: string, data: Record<string, unknown>): Promise<void> {
    const url = `${this.vaultAddr}/v1/${this.mountPath}/data/${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Vault-Token": this.vaultToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) throw new Error(`Vault write failed: ${res.status}`);
  }
}
