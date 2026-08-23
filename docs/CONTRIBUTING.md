# Contributing to Keystone

Thank you for contributing to Hilbras Keystone. This guide covers the development workflow, conventions, and how to submit changes.

## Development setup

1. Start Postgres and Redis:
   ```bash
   docker compose -f docker-compose.test.yml up -d
   ```
2. Copy `.env.example` to `.env` and set at least `DATABASE_URL`.
3. Install dependencies:
   ```bash
   npm install
   cd frontend && npm install
   ```
4. Run migrations:
   ```bash
   npm run db:migrate
   ```
5. Start the dev server:
   ```bash
   npm run dev
   ```

## Testing

- `npm run typecheck` — TypeScript type checking.
- `npm run build` — Compile and copy migration files.
- `npm test` — Run the test suite.
- `npm run test:e2e` (from `frontend/`) — Run Playwright E2E tests.

Integration tests require Postgres and Redis. They skip gracefully when services are unavailable, but CI runs them against real services.

## Code conventions

- Write TypeScript with `strict: true`.
- Keep routes thin; business logic belongs in application and domain services.
- Prefer repository interfaces over direct SQL in domain services.
- Return `Result<T>` from internal services instead of throwing for expected failures.
- Add tests for new behavior.
- Update relevant documentation (`README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`) when architecture changes.

## Architecture decisions

Significant design changes should be recorded as an ADR in `docs/adrs/`. Use the format `NNNN-short-title.md` and include:

- Context
- Decision
- Consequences

## Submitting changes

1. Open a pull request against `main`.
2. Ensure CI passes (`typecheck`, `build`, `test`).
3. Request review from a maintainer.
4. Squash commits if requested.

## Code of conduct

Be respectful, constructive, and inclusive. All contributions are subject to the project's license.
