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

## The gates

Seventeen checks run on every pull request, in the `gates` job, and all of them are
required on `main`. They are the reason a control here can be trusted: most of the
findings in the security registry came from one of them failing, not from a review
noticing.

```
npm run lint                 no warnings, over src, packages and scripts
npm run registry:check       every finding names a test and a document that exist
npm run verify:changelog     the version being released has a dated entry, and
                             every version on the npm registry has one too
npm run check:docs           relative links resolve
npm run reaudit:check        the re-audit matrix regenerates and every claim holds
npm run review:api --strict  every route has an authentication guard, and every
                             guard name resolves
npm run dashboard:auth       every panel names a series that is registered
npm run verify:secrets-cipher  no secrets provider writes an unauthenticated cipher,
                             and the legacy reads that must survive the migration
                             are counted
npm run verify:node          the Node version is stated once — .nvmrc, engines,
                             the Dockerfile and setup-node all agree
npm run verify:action-pins   every third-party action is pinned to a commit SHA
npm run verify:image         the Docker build context carries no credentials
npm run verify:doc-samples   every documentation sample compiles and its imports
                             resolve against the published package
npm run verify:sdk           the five SDK packages share the server version and
                             declare which server versions they support
npm run verify:k8s           the manifests match the running software
```

Two more that are not gates but are worth knowing:

```
npm run registry:render      regenerate docs/security/registry.md from the JSON
npm run bump:version <x.y.z> move the release version everywhere it is written
npm run sync:sdk             put the five packages back on the server version
```

### Adding one

A gate earns its place by failing on a defect that is real, and it earns its
*place* by being verified: plant the defect, watch it fail, put it back, watch it
pass. A gate nobody has seen fail is a gate nobody knows works.

Two habits that came out of the ones above:

- **A gate that reports success for the thing it exists to catch is worse than no
  gate.** `verify-k8s-manifests.mjs` printed "manifest image tag matches
  package.json" for weeks while the image was `:latest` — the code doing the check
  was unreachable. `verify:node`'s range check accepted every value it did not
  recognise, so the one case it existed for passed.
- **Check the claim against the file it is about.** A `str.replace` that matches
  nothing is a silent no-op that looks exactly like a success, and
  `scripts/lib/patch.mjs` exists because a migration reported "pinned" for a
  pattern indented two spaces off.

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
