# Multi-tenancy

Keystone is multi-tenant by organization. One deployment serves many
organizations, and every authenticated request is resolved to the principals and
tenants it may act for before a route handler runs.

## Model

```text
Platform
  └── Organization (tenant)
        ├── Membership (user + role: owner | admin | member)
        ├── Application (OAuth client, redirect URIs, scopes, IP controls)
        │     └── API keys (org/app-bound, scoped)
        ├── Enterprise SSO connections (SAML, OIDC)
        ├── SCIM connection and groups
        ├── Audit log
        └── Workflows and webhooks
```

- **User** — a platform-level identity; one user may belong to several
  organizations.
- **Organization** — the tenant boundary. Data that carries `orgId` is scoped to
  it.
- **Application** — a client registered under one organization. Its `client_id`
  is what OAuth flows present; its membership check decides whether a user may
  consent.
- **Membership** — the join between a user and an organization, carrying the role.
- **API key** — optional `orgId`/`appId` binding plus scopes. A key minted in an
  organization cannot act on another.

The **platform owner** role (`users.platform_role`) is separate from organization
membership: it is the operator of the deployment, not a tenant role.

## Isolation rules

| Surface | Rule |
| --- | --- |
| `/v1/admin/organizations/:id/**` | Caller must hold a membership in `:id`, or be a platform owner. A non-member receives `404` for a resource in another tenant rather than a list of what exists. |
| `/v1/admin/platform/**` | Platform owner only. |
| `/scim/v2/**` | Resolved from the SCIM bearer token to one organization; the token cannot cross tenants. |
| `/sso/*` | Connection is resolved by id and its `orgId` is checked against the initiating application. |
| OAuth consent | The user must be a member of the application's organization. |
| API keys | Lookup yields the key's `orgId`/`appId`; a key cannot widen its own scope. |
| Audit | Rows carry `orgId` when the action was tenant-scoped; tenant listings filter on it. |
| Caches and rate limits | Keys include the tenant or the principal, never only the IP where a tenant exists. |

Authorization is enforced in pre-handlers (`requireAuthAndRole`,
`requireOrganizationRole`, `requirePlatformRole`) and in domain services. A route
that reads `:id` from the path must call the guard — `npm run review:api --strict`
fails the build when a route has no authentication guard.

## Roles inside an organization

| Role | Typical capabilities |
| --- | --- |
| `owner` | Everything, including organization deletion and role changes |
| `admin` | Members, applications, SSO, audit; cannot transfer ownership |
| `member` | Own profile, own sessions; access only to applications they are entitled to |

Organization owners are protected: a role change cannot strip the last owner,
and an owner cannot be removed by an admin.

## Scopes

Personal API keys carry scopes (`profile:read`, `sessions:read`,
`api_keys:read`, …). Organization and service-account keys are validated against
the same registry. An unknown scope is refused at creation rather than silently
dropped, so a typo cannot leave a key that looks narrower than it is.

The API-key scope set is documented in `docs/security/scopes.md`.

## Tenant-scoped client usage

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({
  baseUrl: "https://auth.example.com",
  apiKey: "ks_live_organization_key",
});

const { users } = await keystone.organizations.listUsers("organization-uuid", {
  limit: 50,
  offset: 0,
});

const { logs } = await keystone.organizations.listAuditLogs("organization-uuid", {
  event: "user.login",
  limit: 100,
});
```

Always pass the organization id explicitly. The client does not remember a
"current tenant": a long-lived process should not silently inherit one from a
previous request.

## Applications and OAuth clients

- `clientType: "public"` — SPA or native app; no secret, PKCE required.
- `clientType: "confidential"` — server-side app; secret required at the token
  endpoint.
- `redirectUris` are validated at registration **and** at authorization time;
  they must be absolute `http`/`https` URLs without fragments.
- `allowedOrigins` gates browser CORS for the application.
- `allowedIps` / `blockedIps` gate authentication by client address.
- `allowedScopes` bounds what the application may request.

A client id belongs to exactly one organization. Reusing a client id across
tenants is not supported; register a separate application per tenant.

## Provisioning a tenant

1. Platform owner creates the organization (`POST /v1/admin/organizations`).
2. Add the first owner as a member and set the role.
3. Create the application (`POST /v1/admin/organizations/:id/applications`),
   record the returned client secret once.
4. Configure redirect URIs, origins and scopes.
5. Optionally configure SSO (`/v1/admin/organizations/:id/sso`) and SCIM.
6. Mint an organization API key for automation.
7. Verify with `GET /v1/admin/organizations/:id` and a read of the audit log.

## Operational notes

- **One database, one schema.** Isolation is enforced by predicates and guards,
  not by separate databases. A bug in a guard is a cross-tenant bug, which is why
  `review:api --strict` and the tenant-isolation tests are release gates.
- **Backups are whole-deployment.** Restoring one tenant in isolation is not a
  supported operation; see `docs/OPERATIONS/backup-restore.md`.
- **Metrics are aggregate.** Per-tenant metrics are available through the audit
  log and `GET /v1/admin/platform/metrics/usage`, not through Prometheus labels,
  to avoid unbounded cardinality.
- **Deleting an organization** removes its memberships and applications; audit
  rows are retained according to the deployment's retention policy.

## Testing checklist

- A member of organization A receives `404` for a resource in organization B.
- A platform owner can read both; tenant listings still filter by `orgId`.
- An organization API key cannot read another organization's users.
- A public client cannot authenticate with a secret; a confidential client
  cannot exchange a code without one.
- A SCIM token resolves to one organization and rejects a second group id.
- An audit export is filtered by tenant unless requested by a platform owner.
