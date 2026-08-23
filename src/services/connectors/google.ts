import { OidcConnector, normalizePayload } from "./oidc.js";
import type { ExternalIdentity, AuthorizeUrlOptions } from "./types.js";

/**
 * Google-specific OIDC connector.
 *
 * Extends the generic OIDC connector with Google-specific authorization
 * parameters and a userinfo fallback. Google returns most claims in the
 * id_token, but the userinfo endpoint is used as a fallback when claims
 * are missing.
 */
export class GoogleConnector extends OidcConnector {
  getAuthorizeUrl(opts: AuthorizeUrlOptions): string {
    // Ask the user to pick an account every time. This avoids silent
    // logins with the wrong Google account when multiple accounts exist.
    opts.extraParams = {
      ...opts.extraParams,
      prompt: "select_account",
      access_type: "online",
    };
    return super.getAuthorizeUrl(opts);
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ExternalIdentity> {
    const identity = await super.exchangeCode(code, redirectUri);

    // Google usually returns picture, email_verified, etc. in the id_token.
    // If something is missing, enrich from the userinfo endpoint.
    if (!identity.name || !identity.picture || identity.emailVerified === undefined) {
      try {
        const enriched = await this.fetchUserinfo(code, redirectUri);
        return {
          ...identity,
          name: identity.name || enriched.name,
          picture: identity.picture || enriched.picture,
          emailVerified: identity.emailVerified ?? enriched.emailVerified,
        };
      } catch (err) {
        // Userinfo enrichment is best-effort; the id_token identity is still valid.
        this.logDebug("Google userinfo enrichment failed", err);
      }
    }

    return identity;
  }

  private async fetchUserinfo(code: string, redirectUri: string): Promise<ExternalIdentity> {
    // Re-exchange the code for an access token. In practice the parent
    // exchange already did this, but we do not retain the access token.
    // A future refactor could pass it through to avoid a second request.
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(this.config.tokenEndpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`Google token refresh for userinfo failed: ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      throw new Error("Google did not return an access_token for userinfo");
    }

    const userinfoRes = await fetch(this.config.userinfoEndpoint!, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userinfoRes.ok) {
      throw new Error(`Google userinfo request failed: ${userinfoRes.status}`);
    }

    const payload = (await userinfoRes.json()) as Record<string, unknown>;
    return normalizePayload(payload, this.config.attributeMapping);
  }

  private logDebug(message: string, err: unknown): void {
    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.debug(`[GoogleConnector] ${message}:`, err);
    }
  }
}
