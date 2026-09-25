import type { User } from "../../db/schema.js";
import { LastOwnerInvariantError, type UserRepository, type IdentityRepository } from "../../repositories/types.js";
import type { TokenSet } from "../tokens.js";
import { createTokenSet, type MfaAssertion } from "../tokens.js";
import { emit } from "../events/bus.js";
import { getFederationAuthorizeUrl as getFederationAuthorizeUrlService, completeFederationLogin as completeFederationLoginService, type FederationApplicationContext } from "../federation.js";
import { ok, err, type Result } from "../../lib/result.js";
import { canManagePlatformRole, isPlatformRole, type PlatformRole } from "./authorization.js";
import type { EventContext } from "../events/types.js";

export class IdentityDomainService {
  constructor(
    private readonly users: UserRepository,
    private readonly identities: IdentityRepository
  ) {}

  private async auditDenied(actorId: string, action: string, targetUserId?: string, context?: EventContext): Promise<void> {
    await emit({
      type: "unauthorized_access",
      payload: {
        userId: actorId,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        metadata: { action, targetUserId },
      },
    });
  }

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
    actorId: string,
    userId: string,
    updates: Partial<{ name: string; username: string; emailVerified: boolean }>,
    context?: EventContext
  ): Promise<Result<User>> {
    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (actor.role !== "owner") {
      await this.auditDenied(actorId, "platform_user_update", userId, context);
      return err({ code: "FORBIDDEN", message: "Only platform owners can update users", statusCode: 403 });
    }

    const updated = await this.users.update(userId, updates);
    if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    await emit({
      type: "platform_user_updated",
      payload: {
        userId: actorId,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        metadata: { targetUserId: userId, updates: Object.keys(updates), action: "platform_user_update" },
      },
    });
    return ok(updated);
  }

  async updatePlatformRole(
    actorId: string,
    targetUserId: string,
    role: PlatformRole,
    context?: EventContext
  ): Promise<Result<User>> {
    if (!isPlatformRole(role)) {
      await this.auditDenied(actorId, "invalid_platform_role", targetUserId, context);
      return err({ code: "INVALID_PLATFORM_ROLE", message: "Invalid platform role", statusCode: 400 });
    }

    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (!canManagePlatformRole(actor.role, role)) {
      await this.auditDenied(actorId, "platform_role_change", targetUserId, context);
      return err({ code: "FORBIDDEN", message: "Only platform owners can change platform roles", statusCode: 403 });
    }

    const target = await this.users.findById(targetUserId);
    if (!target) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    let updated: User | undefined;
    try {
      updated = await this.users.updateRole(targetUserId, role);
    } catch (error) {
      if (error instanceof LastOwnerInvariantError) {
        await this.auditDenied(actorId, "last_platform_owner_protection", targetUserId, context);
        return err({ code: "LAST_PLATFORM_OWNER", message: error.message, statusCode: 400 });
      }
      throw error;
    }
    if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });

    await emit({
      type: "platform_role_changed",
      payload: {
        userId: actorId,
        orgId: target.defaultOrgId ?? undefined,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
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

  async deactivate(actorId: string, targetUserId: string, context?: EventContext): Promise<Result<void>> {
    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (actor.role !== "owner") {
      await this.auditDenied(actorId, "platform_user_deactivate", targetUserId, context);
      return err({ code: "FORBIDDEN", message: "Only platform owners can deactivate users", statusCode: 403 });
    }
    if (actorId === targetUserId) {
      await this.auditDenied(actorId, "self_deactivation", targetUserId, context);
      return err({ code: "SELF_DEACTIVATION", message: "Cannot deactivate yourself", statusCode: 400 });
    }

    const target = await this.users.findById(targetUserId);
    if (!target) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    try {
      await this.users.deactivate(targetUserId);
    } catch (error) {
      if (error instanceof LastOwnerInvariantError) {
        await this.auditDenied(actorId, "last_platform_owner_protection", targetUserId, context);
        return err({ code: "LAST_PLATFORM_OWNER", message: error.message, statusCode: 400 });
      }
      throw error;
    }
    await emit({
      type: "platform_user_deactivated",
      payload: {
        userId: actorId,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        metadata: { targetUserId, action: "platform_user_deactivated" },
      },
    });
    return ok(undefined);
  }

  async reviewAccount(
    actorId: string,
    targetUserId: string,
    active: boolean,
    context?: EventContext
  ): Promise<Result<User>> {
    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (actor.role !== "owner") {
      await this.auditDenied(actorId, "platform_account_review", targetUserId, context);
      return err({ code: "FORBIDDEN", message: "Only platform owners can review accounts", statusCode: 403 });
    }
    const target = await this.users.findById(targetUserId);
    if (!target) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });

    try {
      if (active) {
        const updated = await this.users.update(targetUserId, {
          isActive: true,
          accountReviewRequired: false,
          emailVerified: true,
        });
        if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
        await emit({
          type: "platform_account_reviewed",
          payload: {
            userId: actorId,
            requestId: context?.requestId,
            ip: context?.ip,
            userAgent: context?.userAgent,
            metadata: { targetUserId, active: true, action: "platform_account_review" },
          },
        });
        return ok(updated);
      }
      await this.users.deactivate(targetUserId);
    } catch (error) {
      if (error instanceof LastOwnerInvariantError) {
        await this.auditDenied(actorId, "last_platform_owner_protection", targetUserId, context);
        return err({ code: "LAST_PLATFORM_OWNER", message: error.message, statusCode: 400 });
      }
      throw error;
    }
    const updated = await this.users.findById(targetUserId);
    if (!updated) return err({ code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 });
    await emit({
      type: "platform_account_reviewed",
      payload: {
        userId: actorId,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        metadata: { targetUserId, active: false, action: "platform_account_review" },
      },
    });
    return ok(updated);
  }

  async touchLastSeen(userId: string): Promise<void> {
    await this.users.updateLastSeen(userId);
  }

  async linkUserIdentity(
    actorId: string,
    userId: string,
    providerId: string,
    providerType: string,
    externalSub: string,
    email?: string
  ): Promise<Result<void>> {
    const actor = await this.users.findById(actorId);
    if (!actor) return err({ code: "USER_NOT_FOUND", message: "Actor not found", statusCode: 404 });
    if (actorId !== userId && actor.role !== "owner") {
      await this.auditDenied(actorId, "federation_identity_link", userId);
      return err({ code: "FORBIDDEN", message: "You cannot link an identity for another user", statusCode: 403 });
    }
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
    redirectUri: string,
    application?: FederationApplicationContext
  ): Promise<Result<{ user: User; tokens: { accessToken: string; refreshToken: string } }>> {
    const result = await completeFederationLoginService(provider, code, redirectUri, application);
    await emit({
      type: "federation_login",
      payload: { provider, userId: result.user.id, email: result.user.email },
    });
    return ok(result);
  }

  /**
   * Issue a local token set on behalf of an already-verified factor.
   *
   * `mfaFactor` is required rather than optional: without it the token
   * chokepoint rejects MFA-enabled users, and an omitted argument silently
   * reintroduces the bypass this parameter exists to prevent.
   */
  async issueLocalTokenSet(
    user: User,
    mfaFactor: MfaAssertion,
    opts?: {
      appId?: string;
      orgId?: string;
      clientId?: string;
      deviceFingerprint?: string;
    }
  ): Promise<TokenSet> {
    return createTokenSet(
      user,
      undefined,
      undefined,
      { ...opts, mfaFactor },
      opts?.deviceFingerprint
    );
  }
}
