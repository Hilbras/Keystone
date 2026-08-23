import { setContainer, type Container } from "./container.js";
import { ConfigurationService } from "./services/configuration.js";
import { DefaultFeatureFlagService } from "./services/features.js";
import {
  DrizzleUserRepository,
  DrizzleIdentityRepository,
  DrizzleOrganizationRepository,
  DrizzleApplicationRepository,
  DrizzleAuditRepository,
  DrizzlePermissionRepository,
} from "./repositories/index.js";
import { secretsProvider } from "./services/secrets/index.js";
import { queue } from "./services/queue/index.js";
import {
  AuthenticationDomainService,
  AuthorizationDomainService,
  IdentityDomainService,
  OrganizationDomainService,
} from "./services/domain/index.js";
import {
  AuthenticationApplicationService,
  IdentityApplicationService,
  OrganizationApplicationService,
} from "./services/application/index.js";

export function buildContainer(overrides: Partial<Container> = {}): Container {
  const config = new ConfigurationService();
  const features = new DefaultFeatureFlagService(config);

  const userRepository = new DrizzleUserRepository();
  const identityRepository = new DrizzleIdentityRepository();
  const organizationRepository = new DrizzleOrganizationRepository();
  const applicationRepository = new DrizzleApplicationRepository();
  const auditRepository = new DrizzleAuditRepository();
  const permissionRepository = new DrizzlePermissionRepository();

  const authorizationDomain = new AuthorizationDomainService(organizationRepository, permissionRepository);
  const authenticationDomain = new AuthenticationDomainService(userRepository);
  const identityDomain = new IdentityDomainService(userRepository, identityRepository);
  const organizationDomain = new OrganizationDomainService(organizationRepository, applicationRepository);

  const container: Container = {
    config,
    features,
    userRepository,
    identityRepository,
    organizationRepository,
    applicationRepository,
    auditRepository,
    permissionRepository,
    secretsProvider,
    queue,
    ...overrides,
  };

  return container;
}

export function initializeContainer(overrides?: Partial<Container>): Container {
  const container = buildContainer(overrides);
  setContainer(container);
  return container;
}

export function buildApplicationServices(container: Container) {
  const authorizationDomain = new AuthorizationDomainService(container.organizationRepository, container.permissionRepository);
  const authenticationDomain = new AuthenticationDomainService(container.userRepository);
  const identityDomain = new IdentityDomainService(container.userRepository, container.identityRepository);
  const organizationDomain = new OrganizationDomainService(container.organizationRepository, container.applicationRepository);

  return {
    auth: new AuthenticationApplicationService(authenticationDomain),
    identity: new IdentityApplicationService(identityDomain),
    organization: new OrganizationApplicationService(organizationDomain, authorizationDomain, identityDomain),
    authorization: authorizationDomain,
  };
}
