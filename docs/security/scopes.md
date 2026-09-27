# API key scopes and machine principals

Covers SEC-023, SEC-024 and SEC-025.

## The scope registry is the authority

`src/services/scopes.ts` holds every scope the API recognises, who may hold it,
and which principals are permitted to exercise it. Nothing outside that file
decides what a credential may do.

## There is no wildcard

The registry contained a `service_account` entry that any key carrying could
present against every scope check. A narrowly scoped key therefore behaved as a
fully privileged one — the scope list on the key was advisory rather than
binding.

It is gone. Every scope must be named, and `hasScopes` compares explicitly.

## Enforcement fails closed

`requireScopes` returned early when `request.apiKeyId` was absent, so any
authenticated path reaching a scoped route without going through key
authentication skipped the check entirely. A missing key is now treated as *no
authority*, not as *no restriction*.

## Some operations are human-only

A service account is a machine. It has no password, no second factor and no
browser, so operations that require a person present are refused to it:
`profile:*` and `mfa:manage`.

The guard is `requireHumanPrincipal` in `src/plugins/machinePrincipal.ts`.

> **Placement matters.** It must come **after** `app.authenticate` in a
> `preHandler`, because that is what populates `request.serviceAccount`. Placed
> before, it never sees a service account and silently permits everything — the
> guard appears to work and does nothing.

## Migration from 2.4.0

Scope names changed in v2.6.0. The `service_account` wildcard no longer exists,
so a key that relied on it must be reissued with explicit scopes. Keys whose
scopes are no longer recognised are rejected at creation rather than accepted and
silently ignored.
