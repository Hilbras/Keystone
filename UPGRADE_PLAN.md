# Dependency Upgrade Plan

> Target: Upgrade all dependencies across root and frontend packages.
> Strategy: Phased approach with version bumps, changelog updates, GitHub releases, and npm publishes after each phase.

## Version Plan

| Phase | Version | Description |
|-------|---------|-------------|
| Current | 1.1.0 | Security hardening (released) |
| Phase 1 | 1.2.0 | Safe patches/minors |
| Phase 2 | 1.3.0 | Core tooling (TypeScript, Zod, Drizzle) |
| Phase 3 | 1.4.0 | Fastify ecosystem |
| Phase 4 | 1.5.0 | Auth & infra (jose, ioredis, bullmq, etc.) |
| Phase 5 | 1.6.0 | Frontend (React 19, Vite 8, Tailwind 4) |

---

## Phase 1 — Safe patches/minors (v1.2.0)

No code changes expected. Pure version bumps.

### Root `package.json`
| Package | From | To |
|---|---|---|
| fastify | 5.10.0 | latest 5.x |
| @fastify/swagger | 9.8.0 | latest 9.x |
| argon2 | 0.44.0 | latest 0.x |
| otpauth | 9.5.1 | latest 9.x |
| @opentelemetry/sdk-node | 0.220.0 | latest 0.x |
| @opentelemetry/auto-instrumentations-node | 0.78.0 | latest 0.x |

### Frontend `package.json`
| Package | From | To |
|---|---|---|
| autoprefixer | 10.5.2 | latest 10.x |
| postcss | 8.5.19 | latest 8.x |
| lucide-react | 1.24.0 | latest 1.x |
| @playwright/test | 1.61.1 | latest 1.x |

### Post-phase tasks
- [ ] `npm install` + `npm run typecheck`
- [ ] `cd frontend && npm install`
- [ ] Bump version to 1.2.0 in `package.json`
- [ ] Add v1.2.0 section to `CHANGELOG.md`
- [ ] Update "What's new" in `README.md`
- [ ] Commit, push to `release/v1.2.0`, create PR
- [ ] Create GitHub release `v1.2.0`
- [ ] `npm publish --access public`
- [ ] `npm publish --registry https://npm.pkg.github.com`

---

## Phase 2 — Core tooling (v1.3.0)

High-impact changes. Will require code modifications.

### Root `package.json`
| Package | From | To | Breaking? |
|---|---|---|---|
| typescript | 5.9.3 | 7.0.2 | Yes — check tsconfig, new syntax |
| zod | 3.25.76 | 4.6.5 | Yes — API redesign, affects all routes |
| drizzle-orm | 0.31.4 | 0.45.2 | Likely — schema/migration changes |
| drizzle-kit | 0.22.8 | 0.31.10 | Likely — CLI/config changes |
| commander | 12.1.0 | 15.0.0 | Yes — CLI API changes |
| dotenv | 16.6.1 | 18.0.1 | Yes — API changes |

### Code changes needed
- **Zod 3→4**: Update all `z.object()`, `z.string()`, etc. calls across every route file. Check for `z.infer` usage.
- **TypeScript 5→7**: Update `tsconfig.json` if needed. Fix any new strictness errors.
- **Drizzle 0.31→0.45**: Check schema definitions, update `drizzle-kit` config, regenerate migrations.
- **Commander 12→15**: Update `src/cli.ts` for new API.
- **Dotenv 16→18**: Check `src/config.ts` for API changes.

### Post-phase tasks
- [ ] Fix all typecheck errors after each package upgrade
- [ ] Bump version to 1.3.0
- [ ] Update CHANGELOG.md and README.md
- [ ] Commit, PR, release, npm publish

---

## Phase 3 — Fastify ecosystem (v1.4.0)

### Root `package.json`
| Package | From | To | Breaking? |
|---|---|---|---|
| fastify-plugin | 5.1.0 | 6.0.0 | Yes — plugin API changes |
| @fastify/cookie | 10.0.1 | 11.1.2 | Yes — API changes |
| @fastify/cors | 10.1.0 | 11.3.0 | Yes — API changes |
| @fastify/static | 8.3.0 | 10.1.4 | Yes — API changes |
| @fastify/swagger-ui | 5.2.6 | 6.1.1 | Yes — API changes |

### Code changes needed
- **fastify-plugin 5→6**: Update all plugin registrations in `src/plugins/`.
- **@fastify/cookie 10→11**: Check cookie parsing in auth plugin.
- **@fastify/cors 10→11**: Check CORS config in `src/index.ts`.
- **@fastify/static 8→10**: Check static file serving config.
- **@fastify/swagger-ui 5→6**: Check Swagger UI config.

### Post-phase tasks
- [ ] Fix all typecheck errors
- [ ] Bump version to 1.4.0
- [ ] Update CHANGELOG.md and README.md
- [ ] Commit, PR, release, npm publish

---

## Phase 4 — Auth & infra (v1.5.0)

### Root `package.json`
| Package | From | To | Breaking? |
|---|---|---|---|
| jose | 5.10.0 | 6.2.12 | Yes — token API changes |
| ioredis | 5.11.1 | 6.0.0 | Yes — Redis client API changes |
| bullmq | 5.80.2 | 6.3.8 | Yes — Queue API changes |
| @simplewebauthn/server | 13.3.2 | 14.0.2 | Yes — WebAuthn API changes |
| nodemailer | 9.0.3 | 10.0.10 | Yes — transport API changes |

### Code changes needed
- **jose 5→6**: Update token signing/verification in `src/services/tokens.ts`.
- **ioredis 5→6**: Update Redis connections in `src/services/redis.ts`, `src/services/cache.ts`.
- **bullmq 5→6**: Update queue workers in `src/services/queue/`.
- **@simplewebauthn 13→14**: Update WebAuthn routes in `src/routes/webauthn.ts`.
- **nodemailer 9→10**: Update email transport in `src/services/email.ts`.

### Post-phase tasks
- [ ] Fix all typecheck errors
- [ ] Bump version to 1.5.0
- [ ] Update CHANGELOG.md and README.md
- [ ] Commit, PR, release, npm publish

---

## Phase 5 — Frontend (v1.6.0)

### Frontend `package.json`
| Package | From | To | Breaking? |
|---|---|---|---|
| react | 18.3.1 | 19.3.0 | Yes — concurrent APIs, component changes |
| react-dom | 18.3.1 | 19.3.0 | Yes — rendering API changes |
| @types/react | 18.3.31 | 19.3.0 | Yes — type changes |
| @types/react-dom | 18.3.7 | 19.3.0 | Yes — type changes |
| vite | 5.4.21 | 8.3.0 | Yes — config/plugin API changes |
| @vitejs/plugin-react | 4.7.0 | 6.1.1 | Yes — must match Vite version |
| tailwindcss | 3.4.19 | 4.3.3 | Yes — complete rewrite |
| @simplewebauthn/browser | 13.3.0 | 14.0.0 | Yes — API changes |

### Code changes needed
- **React 18→19**: Update component patterns, check for deprecated APIs.
- **Vite 5→8**: Update `vite.config.ts`, check plugin API.
- **Tailwind 3→4**: Rewrite `tailwind.config.*`, update CSS, check class names.
- **@simplewebauthn/browser 13→14**: Update WebAuthn client calls.

### Post-phase tasks
- [ ] Fix all typecheck/build errors
- [ ] Bump version to 1.6.0
- [ ] Update CHANGELOG.md and README.md
- [ ] Commit, PR, release, npm publish

---

## Execution Order

Each phase follows this workflow:

1. Update `package.json` version
2. Install dependencies (`npm install`)
3. Fix any code changes needed
4. Run `npm run typecheck` (root) and `cd frontend && npm run build` (frontend)
5. Update `CHANGELOG.md` with new version section
6. Update `README.md` "What's new" section
7. Commit all changes
8. Push to `release/vX.Y.Z` branch
9. Create PR to main
10. Create GitHub release with changelog notes
11. Publish to npm (`npm publish --access public`)
12. Publish to GitHub Packages
