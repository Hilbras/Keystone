# Migrating to Keystone 1.8.0

Keystone 1.8.0 makes multi-factor authentication enforceable. In 1.7.x, TOTP
was advisory: a user with `totpEnabled = true` could sign in with only a
password, and when a code was supplied it was checked *after* tokens had already
been minted. 1.8.0 removes both behaviours.

Review this page before upgrading a production deployment.

---

## What changes for clients

### `POST /auth/login` and `POST /auth/token-login`

The request body is unchanged, except that the undocumented `totp_code` field is
gone and is now ignored.

For accounts **without** MFA, the response is unchanged.

For accounts **with** MFA, the response changes from `200` to `401`:

```diff
- 200 OK
- { "user": { ... } }
+ 401 Unauthorized
+ {
+   "error": "Multi-factor authentication required",
+   "code": "MFA_REQUIRED",
+   "mfaRequired": true,
+   "challenge": "0hV3...",
+   "expiresAt": "2026-01-01T00:05:00.000Z",
+   "methods": ["totp", "backup_code"]
+ }
```

No access token, refresh token, or session cookie is issued at this point.

### `POST /auth/mfa/verify` (new)

```http
POST /auth/mfa/verify
{ "challenge": "0hV3...", "code": "123456", "factor": "totp" }
```

On success it returns the same shape as a completed login, plus the factor that
was used. From a `login` flow, session cookies are also set.

| Code | Meaning |
| --- | --- |
| `MFA_CHALLENGE_INVALID` | Unknown challenge |
| `MFA_CHALLENGE_EXPIRED` | Past `expiresAt` |
| `MFA_CHALLENGE_REPLAYED` | Already consumed |
| `MFA_CHALLENGE_LOCKED` | Attempt budget exhausted |
| `MFA_INVALID_CODE` | Factor did not match |
| `MFA_NOT_REQUIRED` | Factor disabled while the challenge was open |

### `POST /auth/totp/*`

| Endpoint | 1.7.x | 1.8.0 |
| --- | --- | --- |
| `POST /auth/totp/enroll` | `{ }` | `{ password }` — step-up required |
| `POST /auth/totp/verify` | `{ code }` | `{ password, code }` — step-up required; also revokes existing sessions and refresh tokens |
| `POST /auth/totp/backup` | Consumed a backup code | **Regenerates** backup codes; requires `{ password, code }` |
| `POST /auth/totp/disable` | `{ code }` | `{ password, code }` — step-up required; also destroys backup codes |
| `POST /auth/totp/backup/verify` | — | New. Consumes a backup code without establishing a session |
| `POST /auth/webauthn/register/verify` | `{ response }` | `{ response, password? }` — password required when TOTP is enabled |

### Step-up on factor management

Every endpoint that changes how an account proves its identity now requires the
account **password** in the body in addition to a valid session. This closes a
gap where a leaked 15-minute access token was enough to enroll an attacker's own
authenticator and take permanent control of the account's second factor.

Step-up failures return `401 STEP_UP_REQUIRED` (no password supplied) or
`401 INVALID_CREDENTIALS` (wrong password), and count toward the account lockout.

Update any UI that enrolls or disables MFA to prompt for the password.

If your integration used `POST /auth/totp/backup` to burn a recovery code, move
to `POST /auth/totp/backup/verify`.

### Access-token claims

Sessions that completed MFA carry three additional claims:

```json
{
  "mfa_verified": true,
  "mfa_factor": "totp",
  "amr": ["password", "totp"]
}
```

`mfa_factor` is one of `totp`, `backup_code`, `webauthn`, or `session`.
Claims are only additive; existing verifiers that ignore unknown claims are
unaffected.

---

## What changes for operators

### Enforcing MFA on existing accounts

Migrations do **not** enable MFA automatically. To require a second factor for
an account:

1. The user enrolls via `POST /auth/totp/enroll` and confirms with
   `POST /auth/totp/verify`.
2. Confirming revokes every existing refresh token and session for that account.

Existing access tokens remain valid until they expire
(`ACCESS_TOKEN_TTL_SECONDS`, default 900s). Shorten that value before a rollout
if you need immediate revocation.

### New configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MFA_CHALLENGE_TTL_SECONDS` | `300` | Lifetime of a login MFA challenge |
| `MFA_MAX_ATTEMPTS` | `5` | Factor attempts allowed per challenge |
| `TOTP_BACKUP_CODE_TTL_SECONDS` | `7776000` (90 days) | Backup-code lifetime |

### Behavior of alternate login methods

| Method | Result for an MFA-enabled account |
| --- | --- |
| Password (`/auth/login`, `/auth/token-login`) | Challenge required |
| WebAuthn / passkey | Succeeds; the assertion is itself a possession factor |
| Magic link | `403 MFA_REQUIRED` — does not downgrade to mailbox-only access |
| SAML ACS | `403 mfa_required`; use password + factor |
| Enterprise OIDC, federation, social OAuth | `mfa_required` error; use password + factor |
| Passkey registered after TOTP was enabled | `403 MFA_REQUIRED` — treated as a single factor |
| OAuth2 code exchange | `mfa_required` if the approving session had no recorded factor |

A session created **before** MFA was enabled carries no factor, so it cannot be
refreshed into a new session. Users must complete a fresh password + factor
login.

### Backup codes

Backup codes are regenerated in a new format on the next enrollment or
regeneration: 20 hex characters grouped as `XXXXX-XXXXX-XXXXX-XXXXX` (80 bits),
stored as a keyed (peppered) hash, and expiring after 90 days.

Existing 8-character backup codes were stored as a bare SHA-256 digest and
cannot be read by the new keyed lookup. Users must regenerate their codes:

```bash
curl -X POST https://keystone.example.com/auth/totp/backup \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"code":"123456"}'
```

If your deployment used the default encryption key, plan a re-enrollment
window. `KEYSTONE_TOTP_ENCRYPTION_KEY` (or `KEYSTONE_INTERNAL_API_KEY`) is the
key for both TOTP secrets and the backup-code pepper; **changing it invalidates
all enrolled authenticators and backup codes**.

### TOTP secret encryption

New secrets are written with AES-256-GCM. Secrets written by earlier versions
used AES-256-CBC and remain readable, so no action is required. Secrets are
re-encrypted to the GCM format the next time they are written.

---

## Deployment checklist

- [ ] Run `npm run db:migrate` before starting the new version.
- [ ] Review `MFA_CHALLENGE_TTL_SECONDS` and `MFA_MAX_ATTEMPTS` for your
      threat model.
- [ ] Confirm `KEYSTONE_TOTP_ENCRYPTION_KEY` (or `KEYSTONE_INTERNAL_API_KEY`) is
      set and stable. Without it, Keystone derives a predictable default.
- [ ] Update clients that call `/auth/login`, `/auth/token-login`, or
      `/auth/totp/backup`.
- [ ] Ask existing TOTP users to regenerate their backup codes.
- [ ] Confirm no alternate sign-in path is expected to work for
      MFA-enabled accounts (SAML, OIDC, federation, magic link).
- [ ] Shorten `ACCESS_TOKEN_TTL_SECONDS` if you need pre-enrollment access
      tokens to die quickly.
