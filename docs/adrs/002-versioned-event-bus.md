# ADR 002: Versioned Event Bus

## Status

Accepted

## Context

Keystone emits events for audit logging, webhooks, analytics, anomaly detection, and workflow triggers. Without versioning, a change to an event payload could break external subscribers or downstream internal consumers.

## Decision

Every event emitted by the event bus includes a monotonic version number:

```json
{
  "type": "user.login",
  "version": 1,
  "timestamp": "...",
  "payload": {}
}
```

Subscribers are expected to handle versions they understand and ignore or reject unknown versions.

## Consequences

- Events can evolve without breaking existing integrations.
- Consumers must document the versions they support.
- Event producers must increment the version for backward-incompatible payload changes.
