# Keystone Comprehensive Improvement Plan

**Goal:** Make Hilbras Keystone the simplest identity platform for beginners and the most capable platform for advanced users — while staying secure, fast, and mobile-friendly.

**Principles:**
- *Progressive disclosure* — show only what is needed, never hide the path to more control.
- *Secure by default* — every feature ships with safe defaults.
- *Mobile-first* — every screen must be usable on a phone.
- *API-first* — every UI action is backed by a documented, automatable API.

---

## 1. Mobile Responsiveness & Accessibility

### 1.1 Complete responsive audit
Audit every panel and fix overflow, truncation, and unreachable controls on screens < 640 px.

Priority files:
- `frontend/src/components/ApplicationsPanel.tsx`
- `frontend/src/components/OrganizationsPanel.tsx`
- `frontend/src/components/EnterpriseSsoPanel.tsx`
- `frontend/src/components/WorkflowPanel.tsx`
- `frontend/src/components/BillingPanel.tsx`
- `frontend/src/components/ui/DataTable.tsx`
- `frontend/src/components/wizard/SimpleWizard.tsx`
- `frontend/src/components/wizard/Wizard.tsx`

Concrete rules:
- All button groups use `flex-col sm:flex-row` and `w-full sm:w-auto`.
- All tables become horizontal-scroll cards on mobile or switch to a stacked row layout.
- Forms use full-width inputs with labels above.
- Modals/dialogs become bottom sheets on mobile.

### 1.2 Mobile navigation redesign
Replace the desktop sidebar with a responsive pattern:
- Desktop: collapsible sidebar.
- Tablet: icon-only rail.
- Mobile: bottom tab bar for top-level sections plus a hamburger menu for the rest.

Files to update:
- `frontend/src/components/layout/Sidebar.tsx`
- `frontend/src/components/layout/MobileNav.tsx`
- `frontend/src/components/layout/AppShell.tsx`

### 1.3 Touch-friendly components
- Minimum tap target 44 × 44 px.
- Larger checkboxes, toggles, and select controls on mobile.
- Pull-to-refresh on data tables.
- Swipe gestures on cards (e.g., delete with confirmation).

### 1.4 Accessibility (a11y)
- Add `aria-label`, `aria-describedby`, and `role` attributes to all icon buttons.
- Ensure focus order is logical in modals and wizards.
- Add keyboard shortcuts documentation panel.
- Run automated a11y checks with `axe-core` in CI.
- Support reduced-motion preferences.

---

## 2. Security Hardening

### 2.1 Session security
- Enforce `SameSite=strict` for cookies in production unless cross-origin login is explicitly enabled.
- Add session binding to IP + user-agent fingerprint with optional strict mode.
- Implement idle timeout and absolute session lifetime with configurable defaults (30 min idle, 7 days absolute).
- Add concurrent session limits per user.

### 2.2 Authentication hardening
- Enable password breach detection via Have I Been Pwned (or self-hosted `hibp` service) by default.
- Add account lockout after failed attempts with exponential backoff.
- Require email verification before owner/admin actions.
- Add device trust: prompt for MFA when a new device is detected.

### 2.3 API and token security
- Rotate JWT signing keys automatically on a schedule (daily check, rotate if older than 90 days).
- Add key version metadata to the JWKS endpoint.
- Enforce strict audience (`aud`) and issuer (`iss`) validation.
- Scope API keys to organizations and applications with fine-grained permissions.
- Add API key usage quotas and expiration warnings.
- Implement signed webhook payloads so consumers can verify authenticity.

### 2.4 Secrets provider hardening
- Default to `EnvironmentSecretsProvider` in production instead of `DatabaseSecretsProvider`.
- Add built-in providers for AWS KMS, HashiCorp Vault, Azure Key Vault, and Google Cloud KMS.
- Encrypt all secrets at rest with AES-256-GCM.
- Audit every secret read/write/rotate event.

### 2.5 Audit and compliance
- Make audit logs tamper-evident with a hash chain or append-only stream.
- Add export formats: CSV, JSON, NDJSON, and CEF for SIEMs.
- Add retention policies and automatic archiving.
- Add GDPR-style data export and deletion workflows.

---

## 3. Backend Architecture Improvements

### 3.1 Domain service consolidation
Create explicit orchestration services to reduce coupling:
- `AuthenticationApplicationService`
- `AuthorizationApplicationService`
- `IdentityApplicationService`
- `OrganizationApplicationService`
- `SetupApplicationService`

Move ad-hoc orchestration out of route files and thin services into these application services.

### 3.2 Background job queue productionization
- Default to BullMQ when Redis is available; keep in-process queue for local dev.
- Add job retries with exponential backoff and dead-letter queues.
- Add a jobs dashboard UI to inspect/retry failed jobs.
- Queue categories: emails, webhooks, analytics, workflows, exports.

### 3.3 Plugin architecture GA
- Stabilize the plugin manifest format.
- Add hot-reload for plugins in development.
- Add plugin marketplace UI (list installed, enable/disable, configure).
- Provide official plugin templates for identity providers, email providers, and workflow steps.

### 3.4 Configuration management
- Complete the `ConfigStore` abstraction (`EnvFileConfigStore`, `JsonConfigStore`, `KubernetesSecretConfigStore`, `VaultConfigStore`).
- Add configuration profiles: Development, Production, Docker, Docker Compose, Kubernetes, High Availability.
- Add configuration validation with actionable error messages.
- Add dry-run mode and automatic backup before writes.

### 3.5 Database and migrations
- Add migration status endpoint and UI.
- Add zero-downtime migration strategy documentation.
- Add connection pooling metrics.
- Support read replicas for analytics queries.

### 3.6 Observability
- Add structured health checks with dependency details.
- Add OpenTelemetry tracing (optional, disabled by default).
- Add metrics endpoint (`/metrics`) for Prometheus.
- Add structured logging conventions across all services.

---

## 4. New User-Facing Features

### 4.1 Smart Setup Wizard 2.0
Make first-run setup fully UI-driven with no file editing required.

Steps:
1. **Welcome & profile** — pick environment, auto-fill defaults.
2. **Dependencies** — detect or install PostgreSQL/Redis via Docker, test connections.
3. **URLs & security** — suggest public URLs, generate secrets, set CORS origins.
4. **Owner account** — create first admin with password strength meter.
5. **First application** — ask for project URL/framework, auto-create org + app.
6. **Done** — show one-line drop-in script and "Test login" button.

Add to wizard:
- Configuration change summary before apply.
- Automatic configuration backup.
- Dry-run validation.
- Rollback on failure.
- Final diagnostics report.

### 4.2 One-click project connection
The Connect Project panel should generate a single copy-paste script for any framework.

Supported frameworks in simple view:
- HTML/Vanilla JS
- React / Next.js
- Vue / Nuxt
- Angular
- Svelte / SvelteKit
- Django
- Ruby on Rails
- Go templates

Each template pre-fills:
- Correct redirect URI
- Allowed origin
- Recommended scopes
- Framework-specific initialization code

Add "Test login" button that opens a popup and reports success/failure with clear fixes.

### 4.3 Identity provider presets
Guided setup for:
- Google
- GitHub
- Microsoft / Azure AD
- Apple
- Okta
- Keycloak
- Zitadel
- Custom OIDC

Each preset shows:
- Exact callback URL to paste in the provider
- Link to official provider docs
- Field-by-field guidance
- One-click enable/disable

### 4.4 Role and permission templates
Default roles:
- Owner
- Admin
- Editor
- Viewer
- Member

Each template ships with sensible permissions and is editable. Allow cloning custom roles.

### 4.5 Organization onboarding flow
When a new organization is created:
- Optional wizard to invite members.
- Default application created automatically.
- Quick-start checklist per organization.

### 4.6 User self-service portal
Allow end users to:
- View and update their profile.
- Change password.
- Manage MFA (TOTP, WebAuthn, backup codes).
- View active sessions and revoke them.
- Download their data.
- Request account deletion.

### 4.7 Security dashboard
A dedicated panel showing:
- Recent login activity map.
- Failed login attempts.
- Active sessions.
- MFA adoption rate.
- Password strength distribution.
- Recommended security actions.

### 4.8 Workflow & automation engine improvements
- Visual workflow builder (drag-and-drop nodes).
- Pre-built templates:
  - Post-signup email + default role + organization + workspace.
  - Failed login alert + temporary lockout.
  - New member invite sequence.
- Trigger types: events, schedules, webhooks.
- Action types: email, webhook, role change, notification, custom script.

### 4.9 Billing and plans (if enabled)
- Self-service plan selection.
- Usage dashboards (MAU, API calls, emails, SMS).
- Invoice history.
- Trial reminders.

---

## 5. Developer Experience

### 5.1 SDK improvements
- Publish the browser SDK to npm as `@hilbras/keystone-sdk`.
- Add React/Vue/Angular wrapper hooks.
- Add TypeScript types for all public APIs.
- Add server-side SDKs (Node.js, Python, Go) with examples.

### 5.2 Documentation
- Auto-generated OpenAPI docs from Fastify routes.
- Interactive API explorer in the admin UI.
- Step-by-step integration guides per framework.
- Video walkthroughs for first-time setup.

### 5.3 Local development
- `docker compose up` should start the full stack including PostgreSQL, Redis, and Keystone.
- `npm run dev` starts backend + frontend with hot reload.
- Add seed scripts for demo data.
- Add Playwright E2E tests for critical flows.

### 5.4 CLI improvements
- `keystone setup` — interactive first-run setup.
- `keystone config validate` — validate current configuration.
- `keystone db migrate` / `keystone db rollback`.
- `keystone plugin install <name>`.
- `keystone status` — health and diagnostics.

---

## 6. Implementation Phases

### Phase 1 — Foundation (2 weeks)
- Complete mobile responsive audit and fixes.
- Add hash-based routing improvements and URL persistence.
- Stabilize Simple/Advanced mode across dashboard and wizard.
- Add a11y basics and touch-friendly components.

### Phase 2 — Security & Backend (2 weeks)
- Harden sessions, cookies, and token rotation.
- Implement secrets provider backends (KMS, Vault, Azure Key Vault).
- Add signed webhooks and API key scopes.
- Add structured metrics and health endpoints.

### Phase 3 — Setup & Onboarding (2 weeks)
- Rewrite setup wizard with dependency auto-detection.
- Add configuration profiles, dry-run, backup, and rollback.
- Add onboarding checklist and first-app auto-creation.
- Add final diagnostics report.

### Phase 4 — Connect & Templates (2 weeks)
- Build framework selector in Connect Project panel.
- Add identity provider presets.
- Add role templates.
- Add "Test login" flow.

### Phase 5 — Self-Service & Workflows (2 weeks)
- Build user self-service portal.
- Add security dashboard.
- Add visual workflow builder and templates.
- Add organization onboarding flow.

### Phase 6 — Scale & Polish (2 weeks)
- Productionize background queue with BullMQ dashboard.
- Add plugin marketplace and templates.
- Performance optimization pass.
- E2E test coverage for critical paths.

---

## 7. Success Metrics

- **Onboarding:** A new user completes setup and connects a website in under 10 minutes without reading docs.
- **Mobile:** All dashboard panels are usable on a 375 px wide screen without horizontal overflow.
- **Security:** 100% of security-relevant actions emit versioned audit events; secrets are never logged.
- **Reliability:** Background jobs have < 0.1% failure rate; failed jobs are visible and retryable.
- **Adoption:** 80% of new users enable at least one login method within the first session.
- **Developer satisfaction:** Integration requires one copy-paste script for common frameworks.

---

## Notes

- Keep all existing public APIs backward-compatible.
- Introduce feature flags for every major UI change so they can be rolled out gradually.
- Maintain dark mode and theme consistency.
- Update `docs/SECURITY.md`, `docs/PERFORMANCE.md`, and `docs/ARCHITECTURE.md` as features land.
