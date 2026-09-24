# Migration Guide: v1.6.x to v1.7.0

## Authorization boundary changes

### Platform roles

Platform roles are now limited to `owner` and `user`. Use:

```http
PATCH /v1/admin/platform/users/<userId>/role
Authorization: Bearer <platform-owner-token>
Content-Type: application/json

{"role":"user"}
```

The generic platform user PATCH endpoint rejects a `role` field. A platform owner cannot demote the final platform owner.

### Organization membership

Organization membership roles are `owner`, `admin`, and `member`. Use:

```http
PATCH /v1/admin/organizations/<orgId>/members/<userId>
```

The old organization user PATCH/DELETE endpoints return a migration response (`410`) and cannot change global user state. Organization user read responses are redacted and no longer include password hashes, TOTP secrets, or sensitive metadata.

### Authorization checks

Add the organization being evaluated to every `/v1/authz/check` request:

```json
{
  "organizationId": "<orgId>",
  "resource": "application",
  "action": "read"
}
```

The actor must be an authenticated member of that organization.

### Workflows

Remove `assign_role`, `add_membership`, `add_app_membership`, `create_organization`, plugin-alias, and arbitrary webhook steps from tenant workflows before deploying v1.7.0. These steps are rejected at creation and blocked at execution for existing definitions. Replace them with an explicitly authorized administrative workflow or an application service call.

## Deployment checklist

- [ ] Run `npm ci` and rebuild backend/frontend artifacts.
- [ ] Run `npm run build` before `npm run db:reencrypt-oidc-secrets -- --allow-unmarked-plaintext`; the packaged migration command runs the compiled `dist` helper and requires an explicit review flag for unmarked legacy values.
- [ ] Run the security regression suite against PostgreSQL and Redis.
- [ ] Review the role-constraint migration; legacy invalid platform roles are normalized to `user` and invalid organization roles to `member` before constraints are applied.
- [ ] Remove unsafe legacy workflow definitions.
- [ ] Configure a stable high-entropy `KEYSTONE_INTERNAL_API_KEY` for SAML transaction binding.
- [ ] Configure a stable `KEYSTONE_ENCRYPTION_KEY`; run `npm run db:reencrypt-oidc-secrets -- --allow-unmarked-plaintext` after reviewing legacy rows, then verify encrypted OIDC secrets. The command executes the compiled `dist/db/reencryptOidcSecrets.js` helper.
- [ ] Review quarantined legacy accounts: migration `0010` marks ambiguous pre-v1.7 unverified accounts `account_review_required` and inactive; do not bulk-reactivate them without review. Platform owners can resolve an individual account through `/v1/admin/platform/users/<userId>/account-review`.
- [ ] Update SAML/OIDC initiation and metadata URLs to include `organizationId`; callback state is organization-bound and existing enterprise users must already be organization members.
- [ ] Update clients using `/v1/authz/check` to send `organizationId`.
- [ ] Ensure users are organization members before using organization-bound OAuth/OIDC clients; cross-tenant client context no longer adds an organization claim.
- [ ] Send the bound `client_id` when rotating application-bound refresh tokens; mismatches and inactive/unauthorized applications are rejected.
- [ ] Keep OIDC endpoints on approved public HTTPS hosts. Private endpoints require the explicit `ALLOW_PRIVATE_SSO_ENDPOINTS=true` deployment decision.
- [ ] Configure `SCIM_BEARER_TOKEN` together with `SCIM_ORG_ID`; the bearer credential is scoped to that one organization and cannot administer platform users globally.
- [ ] Existing users must have an explicit enterprise SSO identity link before tenant SSO can issue a token; platform owners are rejected from tenant SSO.
- [ ] Move platform-role mutations to the dedicated endpoint.
- [ ] Treat platform-user deactivation as irreversible account disablement; sessions, refresh tokens, and user API keys are revoked.
- [ ] Move organization-role mutations to `/members/:userId`.
- [ ] Review audit consumers for the new authorization event names.
- [ ] Verify no client depends on internal user fields in organization responses.
- [ ] Review the documented dependency-audit exception before publishing.
