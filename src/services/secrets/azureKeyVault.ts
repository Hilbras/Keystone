import crypto from "node:crypto";
import { importPKCS8, importSPKI, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import type { SecretsProvider, SigningKeyPair } from "./provider.js";
import { hashPassword, verifyPassword } from "./password.js";
import { decryptAtRest, encryptAtRest, isLegacyCiphertext } from "./cipher.js";
import { serviceLogger } from "../../lib/logger.js";

const moduleLog = serviceLogger("secrets");

/**
 * Azure Key Vault secrets provider.
 *
 * This is a reference implementation. In production it should use the Azure
 * SDK (@azure/identity and @azure/keyvault-keys/secrets) to retrieve signing
 * keys, encryption keys, and credentials from Azure Key Vault. Password hashing
 * helpers are reused locally because they are compute-bound.
 */
export class AzureKeyVaultSecretsProvider implements SecretsProvider {
  readonly name = "azure-key-vault";

  hashPassword = hashPassword;
  verifyPassword = verifyPassword;

  private vaultUrl: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;

  constructor() {
    this.vaultUrl = (process.env.AZURE_KEY_VAULT_URL || "").replace(/\/$/, "");
    this.tenantId = process.env.AZURE_TENANT_ID || "";
    this.clientId = process.env.AZURE_CLIENT_ID || "";
    this.clientSecret = process.env.AZURE_CLIENT_SECRET || "";

    if (!this.vaultUrl || !this.tenantId || !this.clientId || !this.clientSecret) {
      throw new Error(
        "AzureKeyVaultSecretsProvider requires AZURE_KEY_VAULT_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET"
      );
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
    const stored = await this.readKey("jwt-active");
    if (stored?.private && stored?.public) {
      const privateKey = await importPKCS8(String(stored.private), "RS256");
      const publicKey = await importSPKI(String(stored.public), "RS256");
      return { keyId: String(stored.keyId ?? "azure-active"), privateKey, publicKey };
    }
    return this.rotateSigningKeys();
  }

  async getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined> {
    const active = await this.getActiveSigningKey();
    if (active.keyId === keyId) return active;
    const stored = await this.readKey(`jwt-${keyId}`);
    if (!stored?.private) return undefined;
    const privateKey = await importPKCS8(String(stored.private), "RS256");
    const publicKey = await importSPKI(String(stored.public), "RS256");
    return { keyId, privateKey, publicKey };
  }

  async rotateSigningKeys(): Promise<SigningKeyPair> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privatePem = await exportPKCS8(pair.privateKey);
    const publicPem = await exportSPKI(pair.publicKey);
    const keyId = `azure-${crypto.randomBytes(8).toString("base64url")}`;

    await this.writeKey("jwt-active", { keyId, private: privatePem, public: publicPem, rotatedAt: new Date().toISOString() });

    return { keyId, privateKey: pair.privateKey, publicKey: pair.publicKey };
  }

  async listActiveSigningKeys(): Promise<{ keyId: string; createdAt: Date; expiresAt?: Date | null }[]> {
    const active = await this.getActiveSigningKey();
    return [{ keyId: active.keyId, createdAt: new Date(), expiresAt: null }];
  }

  async listValidSigningKeys(): Promise<SigningKeyPair[]> {
    return [await this.getActiveSigningKey()];
  }

  async getEncryptionKey(): Promise<Buffer> {
    const stored = await this.readKey("encryption-key");
    if (stored?.value) {
      return Buffer.from(String(stored.value), "base64");
    }
    const key = crypto.randomBytes(32);
    await this.writeKey("encryption-key", { value: key.toString("base64") });
    return key;
  }

  async encryptSecret(plain: string): Promise<string> {
    return encryptAtRest(await this.getEncryptionKey(), plain);
  }

  /**
   * Read a value in either format.
   *
   * The format, the authentication and the legacy CBC read path all live in
   * `cipher.ts`, so they can be tested directly — the first version of the
   * SEC-059 suite copied the logic into the test file, and a test of a copy
   * cannot fail: reverting this provider to CBC left the suite green.
   *
   * The legacy branch is still here, deliberately. Deleting it would turn a
   * security improvement into an outage — every already-stored value would become
   * undecryptable. Migration is the explicit operation
   * `npm run db:reencrypt-oidc-secrets`; a read must not silently rewrite
   * storage, so it does not.
   */
  async decryptSecret(cipherText: string): Promise<string> {
    const plaintext = decryptAtRest(await this.getEncryptionKey(), cipherText);
    if (isLegacyCiphertext(cipherText)) {
      moduleLog.warn(
        { component: "secrets", provider: this.name, event: "legacy_ciphertext_decrypted" },
        "decrypted a legacy AES-256-CBC secret; run db:reencrypt-oidc-secrets to migrate"
      );
    }
    return plaintext;
  }

  // Reference stubs for Azure Key Vault HTTP API integration.
  private async readPath(path: string): Promise<Record<string, unknown> | undefined> {
    const url = `${this.vaultUrl}/secrets/${path}?api-version=7.4`;
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Azure Key Vault read failed: ${response.status}`);
    const body = await response.json();
    return typeof body.value === "string" ? JSON.parse(body.value) : body.value;
  }

  private async readKey(name: string): Promise<Record<string, unknown> | undefined> {
    return this.readPath(name);
  }

  private async writeKey(name: string, value: Record<string, unknown>): Promise<void> {
    const url = `${this.vaultUrl}/secrets/${name}?api-version=7.4`;
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
    if (!response.ok) throw new Error(`Azure Key Vault write failed: ${response.status}`);
  }

  private async getAccessToken(): Promise<string> {
    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.set("client_id", this.clientId);
    params.set("client_secret", this.clientSecret);
    params.set("scope", "https://vault.azure.net/.default");
    params.set("grant_type", "client_credentials");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!response.ok) throw new Error(`Azure authentication failed: ${response.status}`);
    const body = await response.json();
    return String(body.access_token);
  }
}
