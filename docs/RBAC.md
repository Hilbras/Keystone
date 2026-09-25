# Keystone RBAC and Authorization Boundaries

## Role namespaces

Keystone maintains two independent role namespaces.

| Namespace | Stored in | Values | Scope |
| --- | --- | --- | --- |
| Platform role | `users.role` | `owner`, `user` | The entire Keystone installation |
| Organization role | `org_memberships.role` | `owner`, `admin`, `member` | One organization membership |

An organization `owner` is not a platform `owner`. Organization membership roles are never copied into `users.role`, and organization APIs cannot modify platform roles.

## Platform administration

Only a platform owner can:

- Change a platform role through `PATCH /v1/admin/platform/users/:userId/role`.
- Administer platform users, applications, webhooks, configuration, and global audit logs.
- Change role-permission mappings.

The platform role endpoint accepts only:

```json
{ "role": "owner" }
```

or:

```json
{ "role": "user" }
```

The last platform owner cannot be demoted. Generic user profile updates do not accept a `role` field.

## Organization membership

Organization membership is always resolved by the pair `(organizationId, userId)`.

- `owner` can manage memberships and grant organization-owner access.
- `admin` can manage members and administrators, but cannot grant or modify `owner` access.
- `member` cannot manage memberships.
- The sole organization owner cannot be demoted or removed.
- Membership reads and writes never grant platform privileges.

Use the membership endpoints for organization roles:

```text
PATCH /v1/admin/organizations/:organizationId/members/:userId
DELETE /v1/admin/organizations/:organizationId/members/:userId
```

The legacy organization user PATCH/DELETE routes do not mutate global accounts. Use the platform user administration route for account-wide changes.

## Authorization evaluation

Organization permission checks resolve the authenticated actor and route organization explicitly. The internal authorization SDK also requires `userId` and `organizationId`; a bare role string is not a valid cross-tenant authorization decision. Client-supplied application or origin context is not sufficient to establish membership.

For `/v1/authz/check`, provide the organization being evaluated:

```json
{
  "organizationId": "00000000-0000-0000-0000-000000000000",
  "resource": "application",
  "action": "read"
}
```

A user who is not a member of that organization receives `403`; an absent or invalid organization context is not treated as authorization. OAuth/OIDC client context never grants organization claims unless the authenticated user is a member of the application's organization.

## Tenant workflows

Organization workflows may use safe notification and email steps. They cannot:

- Assign a platform or organization role.
- Add a user to an arbitrary organization.
- Add a user through an arbitrary application client ID.
- Send tenant data to arbitrary webhook URLs.

Unsafe or malformed persisted workflow definitions fail closed and are recorded as blocked runs.

## Audit records

Security-relevant transitions emit versioned events with structured metadata, including:

- Actor and target user.
- Organization and application context.
- Previous and new state.
- Request ID, IP address, and user agent where available.

Role, membership, permission, and denied-authorization changes are retained in the audit log. Audit records are asynchronous and should be monitored for subscriber failures in production.

## Migration from v1.6.x

1. Replace organization user PATCH calls that intended to change a platform role with the dedicated platform role endpoint.
2. Replace organization user deactivation calls with a platform-owner workflow.
3. Use `/members/:userId` for organization role changes.
4. Remove workflow definitions containing `assign_role`, `add_membership`, or `add_app_membership` before deployment.
5. Include `organizationId` in authorization-check requests.
6. Review existing organization user clients for reliance on password hashes, TOTP secrets, or other internal user fields; those fields are no longer returned.
