# Keystone UI Simplification Improvement Plan

**Goal:** Make Keystone feel simple enough for a first-time user, while keeping every advanced capability one click away for power users.

**Principle:** *Progressive disclosure* — show only what is needed for the current task, but never hide the path to more control.

---

## 1. Unified "Simple / Advanced" Mode

Introduce a global toggle in the dashboard header and setup wizard.

- **Simple mode:**
  - Hides optional fields.
  - Uses plain-language labels ("App name" instead of "Client ID").
  - Shows guided steps with defaults selected.
  - Surfaces only the most common actions.
- **Advanced mode:**
  - Reveals all fields, raw IDs, scopes, claims, policies, webhooks.
  - Shows JSON payloads, raw event logs, and migration details.
  - Allows direct editing of configuration files.

**Implementation:**
- Store preference in `localStorage` (`keystone:ui-mode`).
- Wrap advanced sections with `<Advanced>` component that reads the preference.
- Default to **Simple** for the first login, prompt to switch when an action needs advanced fields.

---

## 2. Simplified Navigation & Home Dashboard

Replace the current sidebar-heavy layout with a goal-oriented home screen.

### Home cards (one-click actions)

1. **Add login to my website** → opens Connect Project panel.
2. **Create an organization** → opens a one-field modal.
3. **Invite a team member** → opens invite modal.
4. **View active users** → opens Users panel with default filter.
5. **Enable Google sign-in** → opens Identity Providers with Google pre-selected.

### Navigation redesign

- Collapse secondary items into grouped menus:
  - **Home**
  - **Authentication** (users, apps, identity providers)
  - **Access Control** (roles, permissions, organizations)
  - **Platform** (audit, workflows, secrets, plugins, settings)
- Add a global search bar (Cmd+K) to jump to any page, user, app, or setting.

---

## 3. Contextual Help & Inline Education

Every screen should teach without forcing the user to read docs.

- **Tooltips:** Explain every field on hover/focus. Examples:
  - "Redirect URI" → "Where users land after signing in with Google."
  - "Allowed Origins" → "Websites allowed to talk to Keystone from the browser."
- **Inline examples:** Show a live example value next to each input.
- **"Why do I need this?"** expandable help blocks for complex sections.
- **Toast guidance:** After creating an app, show: "Next, copy the drop-in script to your website."

---

## 4. Setup Wizard 2.0 — Guided First Run

The current setup wizard should become a clear, linear, 4-step flow.

### Step 1: Welcome
- One sentence value prop.
- "Start with Docker (recommended)" vs "I already have PostgreSQL/Redis".
- Profile selector (Development, Production, Docker Compose).

### Step 2: Dependencies
- Auto-detect Docker, PostgreSQL, Redis.
- Big green checkmarks when each is ready.
- One "Start services for me" button if Docker is available.
- Plain error messages with a "Fix it for me" suggestion when possible.

### Step 3: Owner Account
- Email + password + confirm password.
- Password strength meter.
- Optional: "Generate a strong password for me".

### Step 4: First Application
- Ask for a website name and URL.
- Auto-create the organization and application behind the scenes.
- Generate the drop-in script immediately.
- Final screen: "Your setup is complete. Here is your one-line install code."

---

## 5. Smart Defaults & Wizards for Complex Features

Instead of empty forms, offer presets and guided creation.

### Application templates
- **Single-page app (React/Vue/Angular)**
- **Server-rendered app (Next.js/Nuxt/Django)**
- **Mobile app**
- **Machine-to-machine API**

Each template pre-fills:
- Redirect URIs
- Allowed origins
- Token lifetime
- Recommended scopes

### Identity provider presets
- Google
- GitHub
- Microsoft
- Apple
- Custom OIDC

Each preset shows:
- Link to provider docs
- Exact callback URL to paste
- Fields needed (Client ID, Client Secret)

### Role templates
- **Admin** — full access
- **Editor** — read + write
- **Viewer** — read only
- **Member** — default user

---

## 6. Connect Project Panel — Beginner Path

The Connect Project panel should have two views:

### Simple view (default)
- Ask: "What framework are you using?" (HTML, React, Vue, Next.js, etc.)
- Ask: "What is your website URL?"
- Show exactly one code block to copy.
- Show a "Test login" button that opens a popup to verify the integration.
- Hide client IDs, callback URLs, and allowed origins unless the user expands them.

### Advanced view
- Full control over all script attributes.
- Custom callback paths.
- Manual origin/redirect URI management.
- Raw SDK API reference.

---

## 7. Plain-Language Error Handling

Every error in the UI should answer three questions:
1. What went wrong?
2. Why did it happen?
3. What should I do now?

### Examples

| Technical error | Plain message | Action |
|---|---|---|
| `401 Unauthorized` | "You are not signed in." | "Sign in" button |
| `Invalid or missing setup token` | "Setup token is missing or has expired." | "Show token from server logs" |
| `relation "secrets" does not exist` | "Database is not ready. Run migrations first." | "Run migrations" button |
| CORS error | "This website is not allowed to talk to Keystone." | "Add origin to Allowed Origins" |

---

## 8. Live Status & Health Indicators

Add a persistent status bar or footer showing:
- Database connection: ✅ / ❌
- Redis connection: ✅ / ❌
- Setup complete: ✅ / ❌
- API reachable: ✅ / ❌

Clicking an indicator opens diagnostics with a "Fix issue" suggestion.

---

## 9. Onboarding Checklist

After first login, show a dismissible checklist:

- [ ] Create an organization
- [ ] Register an application
- [ ] Connect my website
- [ ] Enable at least one login method
- [ ] Invite a team member
- [ ] Review audit logs

Each item links directly to the action. Progress gives a sense of accomplishment.

---

## 10. Mobile-First Responsive Design

The dashboard should work well on tablets and phones.

- Collapsible sidebar into a bottom sheet or hamburger menu.
- Stacked cards on small screens.
- Touch-friendly buttons and inputs.
- Reduce padding and font size on mobile (already partially done).

---

## 11. Consistent Design Tokens & Animations

Polish the visual experience:
- Consistent spacing scale (4px grid).
- Subtle entrance animations for cards and modals.
- Loading skeletons instead of spinners where appropriate.
- Hover states on all interactive elements.
- Empty states with illustrations and clear next steps.

---

## 12. Feedback & Confirmation Flows

Any destructive or important action should be clear.

- Deleting an app → confirmation modal with the app name typed.
- Creating credentials → show a one-time copy dialog.
- Saving settings → toast confirmation.
- Long operations → progress indicator.

---

## Implementation Phases

### Phase 1 — Foundation (1 week)
- Add Simple/Advanced toggle.
- Redesign navigation and home dashboard.
- Add global search (Cmd+K).

### Phase 2 — Setup Wizard (1 week)
- Rewrite setup wizard as 4-step guided flow.
- Add dependency auto-detection and "Fix it" helpers.
- Add onboarding checklist.

### Phase 3 — Contextual Help (1 week)
- Add tooltips and inline examples everywhere.
- Create reusable `<FieldHelp>` component.
- Rewrite error messages into plain language.

### Phase 4 — Smart Defaults (1 week)
- Add application templates.
- Add identity provider presets.
- Add role templates.
- Simplify Connect Project panel with framework selector.

### Phase 5 — Polish (1 week)
- Mobile responsiveness pass.
- Animations and transitions.
- Empty states and loading skeletons.
- User testing with beginners.

---

## Success Metrics

- A new user can complete setup in under 10 minutes without reading docs.
- First login-to-connected-website flow takes under 5 minutes.
- Support questions about "what is a redirect URI" drop by 50%.
- Advanced users report no loss of control.

---

## Notes

- Keep all existing APIs unchanged. These are frontend-only improvements.
- Maintain dark mode support throughout.
- Add feature flags for wizard steps so they can be iterated safely.
