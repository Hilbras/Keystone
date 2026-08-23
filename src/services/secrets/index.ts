import { config } from "../../config.js";
import { DatabaseSecretsProvider } from "./database.js";
import { EnvironmentSecretsProvider } from "./environment.js";
import { VaultSecretsProvider } from "./vault.js";
import { AwsKmsSecretsProvider } from "./awsKms.js";
import { AzureKeyVaultSecretsProvider } from "./azureKeyVault.js";
import type { SecretsProvider } from "./provider.js";

function createProvider(): SecretsProvider {
  const providerName = config.KEYSTONE_SECRETS_PROVIDER || "database";
  switch (providerName) {
    case "environment":
      return new EnvironmentSecretsProvider();
    case "vault":
      return new VaultSecretsProvider();
    case "aws-kms":
      return new AwsKmsSecretsProvider();
    case "azure-key-vault":
      return new AzureKeyVaultSecretsProvider();
    case "database":
    default:
      return new DatabaseSecretsProvider();
  }
}

export const secretsProvider: SecretsProvider = createProvider();

// Re-export everything for backwards compatibility.
export * from "./provider.js";
export { DatabaseSecretsProvider } from "./database.js";
export { EnvironmentSecretsProvider } from "./environment.js";
export { VaultSecretsProvider } from "./vault.js";
export { AwsKmsSecretsProvider } from "./awsKms.js";
export { AzureKeyVaultSecretsProvider } from "./azureKeyVault.js";

// Convenience re-exports of the active provider's methods.
export const hashPassword = secretsProvider.hashPassword.bind(secretsProvider);
export const verifyPassword = secretsProvider.verifyPassword.bind(secretsProvider);
export const hashApiKey = secretsProvider.hashApiKey.bind(secretsProvider);
export const hashClientSecret = secretsProvider.hashClientSecret.bind(secretsProvider);
export const generateClientSecret = secretsProvider.generateClientSecret.bind(secretsProvider);
export const generateApiKey = secretsProvider.generateApiKey.bind(secretsProvider);
export const getActiveSigningKey = secretsProvider.getActiveSigningKey.bind(secretsProvider);
export const getSigningKeyById = secretsProvider.getSigningKeyById.bind(secretsProvider);
export const rotateSigningKeys = secretsProvider.rotateSigningKeys.bind(secretsProvider);
export const listActiveSigningKeys = secretsProvider.listActiveSigningKeys.bind(secretsProvider);
export const listValidSigningKeys = secretsProvider.listValidSigningKeys.bind(secretsProvider);
export const getEncryptionKey = secretsProvider.getEncryptionKey.bind(secretsProvider);
export const encryptSecret = secretsProvider.encryptSecret.bind(secretsProvider);
export const decryptSecret = secretsProvider.decryptSecret.bind(secretsProvider);
