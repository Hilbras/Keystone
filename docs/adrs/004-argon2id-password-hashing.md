# ADR 004: Argon2id Password Hashing

## Status

Accepted

## Context

Keystone originally hashed passwords with scrypt. While scrypt is still secure, argon2id is the current OWASP recommendation and provides stronger resistance to GPU attacks with simpler parameter tuning.

## Decision

New password hashes use argon2id with parameters `m=65536, t=3, p=4`. Existing scrypt hashes remain verifiable through a legacy verifier so no user passwords are invalidated.

## Consequences

- New hashes follow modern best practices.
- No password migration is required.
- The project gains a native dependency (`argon2`) that must compile on target platforms.
