# Migrating to Keystone 1.9.0

Keystone 1.9.0 makes SCIM provisioning organization-scoped. In 1.8.x, SCIM was a
pair of environment variables, which allowed exactly one organization in a
deployment to be provisioned, stored the bearer token in plaintext, and reached
through global user methods.

Review this page before upgrading a production deployment.

---

## 1. SCIM credentials are now per organization

| 1.8.x | 1.9.0 |
| --- | --- |
| `SCIM_BEARER_TOKEN` — one plaintext token, process-wide | A `scim_connections` row per organization, storing a SHA-256 digest |
| `SCIM_ORG_ID` — one organization, process-wide | `org_id` on the connection, enforced by a foreign key |
| No rotation, revocation, or expiry | Rotate, revoke, and expire through the connection API |
| Token compared with `!==` in application code | Token resolved by digest lookup, so no timing signal |

### What happens to your existing configuration automatically

If `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are still set at startup, Keystone adopts
them **once** into a connection for `SCIM_ORG_ID` and logs a deprecation notice.
Your existing identity provider keeps working with no downtime.

Adoption is one-time. Once a connection exists for the organization, the
environment variables are ignored — including after a revocation, so a restart
cannot resurrect a credential you revoked.

### Move to the connection API

Remove the environment variables once the connection exists, then manage
credentials through the API or the admin dashboard:

```bash
ORG=<organization-id>
ADMIN_TOKEN=<platform owner access token>

# Create (returns the bearer token once)
curl -X POST "https://keystone.example.com/v1/admin/organizations/$ORG/scim-connections" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Okta","expiresInDays":365}'

# Rotate
curl -X POST "https://keystone.example.com/v1/admin/organizations/$ORG/scim-connections/$ID/rotate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{}'

# Revoke
curl -X DELETE "https://keystone.example.com/v1/admin/organizations/$ORG/scim-connections/$ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Creating, rotating, and revoking are **owner-only**. A SCIM token can provision
and deactivate tenant users, so a mere admin or member cannot mint one.

The bearer token is shown exactly once. It is not recoverable afterwards, and
listings show a four-character hint.

---

## 2. Deprovisioning no longer deactivates shared accounts

This is the most important behavioural change for multi-tenant deployments.

A user row is global. In 1.8.x, `DELETE /scim/v2/Users/:id` called the global
`deactivate`, which revoked that person's sessions, refresh tokens, and API keys
**in every organization they belonged to** — including organizations that
credential had no relationship with.

In 1.9.0:

| Situation | Result |
| --- | --- |
| The organization was the user's only membership | Membership removed, account deactivated, sessions revoked |
| The user also belongs to another organization | Membership removed from **this** organization only; the shared account is untouched |

If your process relied on SCIM deletion disabling an account everywhere, you now
need to remove the membership in each organization, or have a platform owner
deactivate the account.

### Writing global attributes of a shared user

A user who belongs to more than one organization cannot have their global
attributes changed through SCIM, because that would change what the other
organizations see without their authorization. `PUT`, `PATCH`, and reactivation
return `409` with `scimType: "mutability"`.

Remove the membership from this organization instead.

---

## 3. Response codes

| Case | 1.8.x | 1.9.0 |
| --- | --- | --- |
| Target belongs to another organization | `404` | `404` |
| Target is a platform owner | `409` | `409` |
| `userName` already exists elsewhere | `409` (named the other organization) | `409` (generic) |
| Target is the last owner of the organization | `204` | `409` |
| Target is a shared user being modified | `200` | `409` |
| Malformed id in the path | `500` | `404` |
| Invalid body | generic Fastify error | SCIM `Error` object |

The conflict message no longer says which organization holds the account, so the
endpoint is not a tenant oracle.

---

## 4. New endpoints

### Users

`PATCH /scim/v2/Users/:userId` and `POST /scim/v2/Users/.search` are new.
`GET /Users` and `POST /Users/.search` accept `startIndex` and `count`, and
`filter` supports the single-attribute `eq` form.

`POST /Users` is now create-or-update: provisioning an existing member of the
organization applies the profile fields in the body, which 1.8.x silently
dropped.

An unsupported filter is rejected with `400 invalidFilter` rather than ignored.
Supported attributes are `userName` for users, and `displayName` and `externalId`
for groups. `externalId` is **not** supported for users.

### Groups

`GET /scim/v2/Groups` previously returned a synthetic projection of organization
roles, with ids of the form `<orgId>:<role>`. Those endpoints are removed.

Groups are now real records scoped to the organization, with:

```
GET    /scim/v2/Groups
POST   /scim/v2/Groups
GET    /scim/v2/Groups/:groupId
PUT    /scim/v2/Groups/:groupId
PATCH  /scim/v2/Groups/:groupId
DELETE /scim/v2/Groups/:groupId
GET    /scim/v2/Groups/:groupId/members
POST   /scim/v2/Groups/:groupId/members
DELETE /scim/v2/Groups/:groupId/members/:userId
```

If an identity provider was reading the old role projection, it must be
reconfigured to push its own groups.

### Service discovery

`GET /scim/v2/ServiceProviderConfig` and `GET /scim/v2/ResourceTypes` are new.

---

## 5. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCIM_ROTATION_GRACE_SECONDS` | `0` | Grace window for a rotated token |
| `SCIM_RATE_LIMIT_MAX` | `600` | Requests per credential per window |
| `SCIM_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window for the above |
| `SCIM_AUTH_FAILURE_MAX` | `60` | Unauthenticated requests per address per window |
| `SCIM_AUTH_FAILURE_WINDOW_SECONDS` | `60` | Window for the above |

`SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are deprecated and can be removed.

Rotation revokes the previous token immediately. `rotationGraceSeconds` keeps it
valid for a window, which avoids dropping in-flight provisioning — but it is not
a revocation mechanism, so do not use a grace window when rotating in response to
a leak. Revoke instead.

---

## 6. Operational notes

- The connection's `lastUsedAt` is updated on every authenticated SCIM request,
  which makes an unused or abandoned credential visible.
- Revoked connections are retained as an audit trail and do not block a
  replacement; a partial unique index enforces at most one live connection per
  organization.
- Every mutation records the connection id and organization in the audit row.
  Credential lifecycle transitions emit `scim_connection_created`,
  `scim_connection_rotated`, and `scim_connection_revoked`.

---

## Deployment checklist

- [ ] Run `npm run db:migrate` before starting the new version.
- [ ] Confirm SCIM still works with the automatically adopted connection.
- [ ] Create a managed connection, move your identity provider onto it, then
      remove `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID`.
- [ ] Set `expiresInDays` so credentials rotate on a schedule.
- [ ] Check whether any process relied on SCIM deletion disabling an account
      across all of that user's organizations.
- [ ] Reconfigure any identity provider that read the old role-based group
      projection.
- [ ] Confirm your identity provider's filter attributes are supported
      (`userName` for users; `displayName` and `externalId` for groups).
