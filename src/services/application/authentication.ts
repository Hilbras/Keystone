import type { AuthenticationDomainService } from "../domain/authentication.js";
import type { TokenSet } from "../tokens.js";
import type { User } from "../../db/schema.js";
import type { MfaFlow } from "../../repositories/types.js";
import type { MfaFactor } from "../mfa.js";
import type { Result } from "../../lib/result.js";

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  name?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

export interface LoginRequest {
  email: string;
  password: string;
  clientId?: string;
  flow?: MfaFlow;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * The password step succeeded but the second factor has not been satisfied.
 * No access or refresh token is present; `challenge` must be presented to
 * `completeMfa` before any token is issued.
 */
export interface MfaRequiredResponse {
  status: "requires_mfa";
  user: User;
  challenge: string;
  expiresAt: Date;
  flow: MfaFlow;
  clientId?: string;
}

export type LoginResponse =
  | { status: "authenticated"; data: AuthResponse }
  | { status: "requires_mfa"; data: MfaRequiredResponse };

export interface MfaCompleteRequest {
  challenge: string;
  code: string;
  factor?: MfaFactor;
  ipAddress?: string;
  userAgent?: string;
}

export interface MfaCompleteResponse extends AuthResponse {
  flow: MfaFlow;
  factor: MfaFactor;
  clientId?: string;
}

export class AuthenticationApplicationService {
  constructor(private readonly domain: AuthenticationDomainService) {}

  async register(request: RegisterRequest): Promise<Result<AuthResponse>> {
    const result = await this.domain.register(request);
    if (!result.success) return result;
    return {
      success: true,
      data: this.toAuthResponse(result.data.user, result.data.tokens),
    };
  }

  async login(request: LoginRequest): Promise<Result<LoginResponse>> {
    const result = await this.domain.login(request);
    if (!result.success) return result;

    if (result.data.status === "requires_mfa") {
      return {
        success: true,
        data: {
          status: "requires_mfa",
          data: {
            status: "requires_mfa",
            user: result.data.user,
            challenge: result.data.challenge.challenge,
            expiresAt: result.data.challenge.expiresAt,
            flow: result.data.challenge.flow,
            clientId: result.data.challenge.clientId,
          },
        },
      };
    }

    return {
      success: true,
      data: {
        status: "authenticated",
        data: this.toAuthResponse(result.data.user, result.data.tokens),
      },
    };
  }

  async completeMfa(request: MfaCompleteRequest): Promise<Result<MfaCompleteResponse>> {
    const factor = request.factor ?? detectFactor(request.code);
    const result = await this.domain.completeMfa(
      request.challenge,
      request.code,
      factor,
      request.ipAddress,
      request.userAgent
    );
    if (!result.success) return result;
    return {
      success: true,
      data: {
        ...this.toAuthResponse(result.data.user, result.data.tokens),
        flow: result.data.flow,
        factor: result.data.factor,
        clientId: result.data.clientId,
      },
    };
  }

  async refresh(refreshToken: string, clientId?: string): Promise<Result<TokenSet>> {
    const result = await this.domain.refresh(refreshToken, clientId);
    if (!result.success) return result;
    return { success: true, data: result.data.tokens };
  }

  async logout(refreshToken?: string): Promise<Result<void>> {
    return this.domain.logout(refreshToken);
  }

  async createPasswordResetToken(email: string): Promise<Result<{ token: string; user: User } | null>> {
    return this.domain.createPasswordResetToken(email);
  }

  async resetPasswordWithToken(token: string, newPassword: string): Promise<Result<User>> {
    return this.domain.resetPasswordWithToken(token, newPassword);
  }

  private toAuthResponse(user: User, tokens: TokenSet): AuthResponse {
    return {
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  }
}

/**
 * TOTP codes are exactly six digits; anything else is treated as a backup
 * code. The MFA service still validates the factor independently, so this only
 * picks which verification path to run.
 */
function detectFactor(code: string): MfaFactor {
  return /^[0-9]{6}$/.test(code.trim()) ? "totp" : "backup_code";
}
