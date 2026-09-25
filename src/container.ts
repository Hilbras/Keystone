import type { ConfigurationService } from "./services/configuration.js";
import type { FeatureFlagService } from "./services/features.js";
import type {
  UserRepository,
  OrganizationRepository,
  ApplicationRepository,
  AuditRepository,
  IdentityRepository,
  PermissionRepository,
  MfaChallengeRepository,
  ScimConnectionRepository,
  ScimGroupRepository,
} from "./repositories/types.js";
import type { ApiKeyRepository } from "./repositories/apiKey.js";
import type { SamlConnectionRepository } from "./repositories/samlConnection.js";
import type { OidcConnectionRepository } from "./repositories/oidcConnection.js";
import type { SecretsProvider } from "./services/secrets/provider.js";
import type { Queue } from "./services/queue/types.js";

export interface Container {
  config: ConfigurationService;
  features: FeatureFlagService;
  userRepository: UserRepository;
  identityRepository: IdentityRepository;
  organizationRepository: OrganizationRepository;
  applicationRepository: ApplicationRepository;
  auditRepository: AuditRepository;
  permissionRepository: PermissionRepository;
  mfaChallengeRepository: MfaChallengeRepository;
  scimConnectionRepository: ScimConnectionRepository;
  scimGroupRepository: ScimGroupRepository;
  apiKeyRepository: ApiKeyRepository;
  samlConnectionRepository: SamlConnectionRepository;
  oidcConnectionRepository: OidcConnectionRepository;
  secretsProvider: SecretsProvider;
  queue: Queue;
}

let globalContainer: Container | null = null;

export function setContainer(container: Container): void {
  globalContainer = container;
}

export function getContainer(): Container {
  if (!globalContainer) {
    throw new Error("DI container has not been initialized");
  }
  return globalContainer;
}

export function resolve<K extends keyof Container>(key: K): Container[K] {
  return getContainer()[key];
}
