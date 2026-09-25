export const LEGACY_OIDC_SECRET_PREFIX = "legacy:";

export function isLegacyOidcSecret(value: string): boolean {
  return value.startsWith(LEGACY_OIDC_SECRET_PREFIX);
}
