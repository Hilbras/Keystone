import type { IdentityDomainService } from "../domain/identity.js";
import type { User } from "../../db/schema.js";
import type { Result } from "../../lib/result.js";
import type { PlatformRole } from "../domain/authorization.js";
import type { EventContext } from "../events/types.js";

export class IdentityApplicationService {
  constructor(private readonly domain: IdentityDomainService) {}

  async findUser(id: string): Promise<Result<User>> {
    return this.domain.findUser(id);
  }

  async findUserByEmail(email: string): Promise<Result<User>> {
    return this.domain.findUserByEmail(email);
  }

  async upsertInvitedUser(input: { email: string; name?: string; username?: string }): Promise<Result<User>> {
    return this.domain.upsertInvitedUser(input);
  }

  async updateUserProfile(
    actorId: string,
    userId: string,
    updates: Partial<{ name: string; username: string; emailVerified: boolean }>,
    context?: EventContext
  ): Promise<Result<User>> {
    return this.domain.updateUserProfile(actorId, userId, updates, context);
  }

  async updatePlatformRole(
    actorId: string,
    targetUserId: string,
    role: PlatformRole,
    context?: EventContext
  ): Promise<Result<User>> {
    return this.domain.updatePlatformRole(actorId, targetUserId, role, context);
  }

  async deactivate(actorId: string, targetUserId: string, context?: EventContext): Promise<Result<void>> {
    return this.domain.deactivate(actorId, targetUserId, context);
  }

  async listOrganizationUsers(orgId: string): Promise<User[]> {
    return this.domain.listOrganizationUsers(orgId);
  }

  async linkUserIdentity(
    actorId: string,
    userId: string,
    providerId: string,
    providerType: string,
    externalSub: string,
    email?: string
  ): Promise<Result<void>> {
    return this.domain.linkUserIdentity(actorId, userId, providerId, providerType, externalSub, email);
  }

  async getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string): Promise<Result<{ url: string }>> {
    return this.domain.getFederationAuthorizeUrl(provider, state, redirectUri);
  }

  async completeFederationLogin(
    provider: string,
    code: string,
    redirectUri: string
  ): Promise<Result<{ user: User; tokens: { accessToken: string; refreshToken: string } }>> {
    return this.domain.completeFederationLogin(provider, code, redirectUri);
  }
}
