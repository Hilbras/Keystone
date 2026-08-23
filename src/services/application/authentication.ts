import type { AuthenticationDomainService } from "../domain/authentication.js";
import type { TokenSet } from "../tokens.js";
import type { User } from "../../db/schema.js";
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
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
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

  async login(request: LoginRequest): Promise<Result<AuthResponse>> {
    const result = await this.domain.login(request);
    if (!result.success) return result;
    return {
      success: true,
      data: this.toAuthResponse(result.data.user, result.data.tokens),
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
