# ADR 001: Identity Connectors as Provider Adapters

## Status

Accepted

## Context

Keystone needs to support many external identity providers (Google, GitHub, Azure AD, Okta, Keycloak, Zitadel) without becoming a wrapper around any single one. Early drafts coupled user creation and token issuance directly inside connector code, making connectors hard to test and reuse.

## Decision

Introduce a dedicated **Identity Connectors** layer. Each connector is a pure adapter responsible only for:

- Building authorization URLs
- Exchanging codes for tokens
- Validating identity tokens
- Retrieving and normalizing profile data

User creation, identity linking, Keystone token issuance, and session management remain in higher-level domain services (`AuthenticationDomainService`, `IdentityDomainService`).

## Consequences

- Connectors are small, stateless, and easy to unit test.
- New providers can be added without changing core business logic.
- The platform remains provider-agnostic.
- A small amount of orchestration code is duplicated across domain services, which is acceptable for clarity.
