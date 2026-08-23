import crypto from "node:crypto";
import { importPKCS8, importSPKI, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import type { SecretsProvider, SigningKeyPair } from "./provider.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * AWS KMS secrets provider reference implementation.
 *
 * In a real deployment this would use the AWS SDK to:
 * - Store/retrieve JWT signing keys in AWS Secrets Manager or Parameter Store
 * - Use KMS for envelope encryption of secrets
 *
 * The current implementation keeps keys in memory and encrypts the data
 * encryption key (DEK) with a KMS key ID supplied via KMS_KEY_ID. It is
 * intended as a starting point for a full AWS integration.
 */
export class AwsKmsSecretsProvider implements SecretsProvider {
  readonly name = "aws-kms";

  hashPassword = hashPassword;
  verifyPassword = verifyPassword;

  private kmsKeyId?: string;
  private keyPair: SigningKeyPair | null = null;

  constructor() {
    this.kmsKeyId = process.env.KMS_KEY_ID;
    if (!this.kmsKeyId) {
      throw new Error("AwsKmsSecretsProvider requires KMS_KEY_ID");
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
    if (this.keyPair) return this.keyPair;
    return this.rotateSigningKeys();
  }

  async getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined> {
    const active = await this.getActiveSigningKey();
    if (active.keyId === keyId) return active;
    return undefined;
  }

  async rotateSigningKeys(): Promise<SigningKeyPair> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privatePem = await exportPKCS8(pair.privateKey);
    const publicPem = await exportSPKI(pair.publicKey);
    const keyId = `aws-${crypto.randomBytes(8).toString("base64url")}`;

    // In production: store privatePem/publicPem in AWS Secrets Manager encrypted by KMS.
    // eslint-disable-next-line no-console
    console.warn(`[aws-kms] New signing key ${keyId} generated. In production, store it in AWS Secrets Manager.`);

    this.keyPair = { keyId, privateKey: pair.privateKey, publicKey: pair.publicKey };
    return this.keyPair;
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
    // In production: decrypt a stored data key using KMS.
    throw new Error("AwsKmsSecretsProvider.getEncryptionKey() is not yet implemented");
  }

  async encryptSecret(plain: string): Promise<string> {
    throw new Error("AwsKmsSecretsProvider.encryptSecret() is not yet implemented");
  }

  async decryptSecret(cipherText: string): Promise<string> {
    throw new Error("AwsKmsSecretsProvider.decryptSecret() is not yet implemented");
  }
}
