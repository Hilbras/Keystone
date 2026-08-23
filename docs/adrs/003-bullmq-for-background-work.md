# ADR 003: BullMQ for Background Work

## Status

Accepted

## Context

Sending emails, delivering webhooks, running analytics, and executing workflow actions synchronously would slow API responses and reduce reliability. The project started with an in-process event bus for simplicity.

## Decision

Introduce a BullMQ-backed queue as the production default when Redis is available, falling back to an in-process queue for local development. The queue abstraction (`src/services/queue/types.ts`) keeps core code independent of BullMQ specifics.

## Consequences

- API responses stay fast.
- Failed jobs are retried with exponential backoff.
- Redis becomes a runtime dependency for production queues.
- Local development can still run without Redis.
