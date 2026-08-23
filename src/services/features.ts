import type { ConfigurationService } from "./configuration.js";

export interface FeatureFlagService {
  isEnabled(flag: string): boolean;
  requireEnabled(flag: string): void;
}

export class DefaultFeatureFlagService implements FeatureFlagService {
  constructor(private readonly config: ConfigurationService) {}

  isEnabled(flag: string): boolean {
    return this.config.isEnabled(flag);
  }

  requireEnabled(flag: string): void {
    if (!this.isEnabled(flag)) {
      const error = new Error(`Feature '${flag}' is not enabled`) as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }
  }
}
