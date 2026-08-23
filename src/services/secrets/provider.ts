import type { KeyLike } from "jose";

export interface SigningKeyPair {
  keyId: string;
  privateKey: KeyLike | Uint8Array;
  publicKey: KeyLike;
}

export interface SecretsProvider {
  readonly name: string;

  // Password hashing
  hashPassword(plain: string): Promise<string>;
  verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean>;

  // API key / client secret hashing
  hashApiKey(key: string): string;
  hashClientSecret(secret: string): string;
  generateClientSecret(): string;
  generateApiKey(): { key: string; prefix: string };

  // JWT signing keys
  getActiveSigningKey(): Promise<SigningKeyPair>;
  getSigningKeyById(keyId: string): Promise<SigningKeyPair | undefined>;
  rotateSigningKeys(): Promise<SigningKeyPair>;
  listActiveSigningKeys(): Promise<{ keyId: string; createdAt: Date; expiresAt?: Date | null }[]>;
  /**
   * Return all signing keys that are currently valid: the active key plus any
   * recently rotated keys still within the grace period. Used to verify tokens
   * after a key rotation.
   */
  listValidSigningKeys(): Promise<SigningKeyPair[]>;

  // Symmetric encryption
  getEncryptionKey(): Promise<Buffer>;
  encryptSecret(plain: string): Promise<string>;
  decryptSecret(cipherText: string): Promise<string>;
}
