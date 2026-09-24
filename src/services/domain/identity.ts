import type { User } from "../../db/schema.js";
import type { UserRepository, IdentityRepository } from "../../repositories/types.js";
import type { TokenSet } from "../tokens.js";
import { createTokenSet } from "../tokens.js";
import { emit } from "../events/bus.js";
import { getFederationAuthorizeUrl as getFederationAuthorizeUrlService, completeFederationLogin as completeFederationLoginService } from "../federation.js";
import { ok, err, type Result } from "../../lib/result.js";
import { canManagePlatformRole, isPlatformRole, type PlatformRole } from "./authorization.js";
import type { EventContext } from "../events/types.js";

export class IdentityDomainService {
  constructor(
    private readonly users: UserRepository,
    private readonly identities: IdentityRepository
  ) {}

  async findUser(id: string): Promise<Result<User>> {
    const user = await this.users.findById(id);
    if (!user) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    return ok(user);
  }

  async findUserByEmail(email: string): Promise<Result<User>> {
    const user = await this.users.findByEmail(email);
    if (!user) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    return ok(user);
  }

  async upsertInvitedUser(input: { email: string; name?: string; username?: string }): Promise<Result<User>> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) return ok(existing);

    const baseUsername = input.username || input.email.split("@")[0];
    const username = await this.users.ensureUniqueUsername(
      baseUsername.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
    );

    const user = await this.users.create({
      email: input.email,
      username,
      name: input.name || username,
      provider: "password",
      emailVerified: false,
    });
    return ok(user);
  }

  async updateUserProfile(
    userId: string,
    updates: Partial<{ name: string; username: string; emailVerified: boolean }>
  ): Promise<Result<User>> {
    const updated = await this.users.update(userId, updates);
    if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    return ok(updated);
  }

  async updatePlatformRole(
    actorId: string,
    targetUserId: string,
    role: PlatformRole,
    context?: EventContext
  ): Promise<Result<User>> {
    if (!isPlatformRole(role)) {
      return err({ code: "INVALID_PLATFORM_ROLE", message: "Invalid platform role", statusCode: 400 });
    }

    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (!canManagePlatformRole(actor.role, role)) {
      return err({ code: "FORBIDDEN", message: "Only platform owners can change platform roles", statusCode: 403 });
    }

    const target = await this.users.findById(targetUserId);
    if (!target) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    if (target.role === "owner" && role === "user" && (await this.users.countByRole("owner")) <= 1) {
      return err({ code: "LAST_PLATFORM_OWNER", message: "Cannot demote the last platform owner", statusCode: 400 });
    }

    const updated = await this.users.updateRole(targetUserId, role);
    if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });

    await emit({
      type: "platform_role_changed",
      payload: {
        userId: actorId,
        orgId: target.defaultOrgId ?? undefined,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        appId: context?.appId,
        metadata: {
          targetUserId,
          previousRole: target.role,
          newRole: role,
          action: "platform_role_changed",
        },
      },
    });
    return ok(updated);
  }

  async deactivate(userId: string): Promise<Result<void>> {
    await this.users.deactivate(userId);
    return ok(undefined);
  }

  async listOrganizationUsers(orgId: string): Promise<User[]> {
    return this.users.listByOrg(orgId);
  }

  async touchLastSeen(userId: string): Promise<void> {
    await this.users.updateLastSeen(userId);
  }

  async linkUserIdentity(
    userId: string,
    providerId: string,
    providerType: string,
    externalSub: string,
    email?: string
  ): Promise<Result<void>> {
    await this.identities.link({ userId, providerId, providerType, externalSub, email });
    return ok(undefined);
  }

  async getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string): Promise<Result<{ url: string }>> {
    const url = await getFederationAuthorizeUrlService(provider, state, redirectUri);
    return ok({ url });
  }

  async completeFederationLogin(
    provider: string,
    code: string,
    redirectUri: string
  ): Promise<Result<{ user: User; tokens: { accessToken: string; refreshToken: string } }>> {
    const result = await completeFederationLoginService(provider, code, redirectUri);
    await emit({
      type: "federation_login",
      payload: { provider, userId: result.user.id, email: result.user.email },
    });
    return ok(result);
  }

  async issueLocalTokenSet(
    user: User,
    opts?: {
      appId?: string;
      orgId?: string;
      clientId?: string;
      deviceFingerprint?: string;
    }
  ): Promise<TokenSet> {
    return createTokenSet(user, undefined, undefined, opts, opts?.deviceFingerprint);
  }
}
