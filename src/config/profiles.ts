/**
 * §6.2. Security profiles.
 *
 * `NODE_ENV` is a string the process reads and every existing check compares with
 * `=== "production"`. That made three things true and all three were bugs waiting
 * to happen:
 *
 * - `staging` behaved exactly like `development`. Every security default derived
 *   from `NODE_ENV === "production"` silently relaxed for the environment that is
 *   supposed to *prove* the production configuration before it is deployed.
 * - `prod`, `Production` and anything else an operator typed behaved the same way,
 *   with no warning.
 * - There was nowhere to state what "safe" means for a profile, so each check
 *   spelled its own policy out at the point of use.
 *
 * A profile is a small, explicit table of security defaults. It deliberately does
 * **not** replace `NODE_ENV` — every existing `=== "production"` check keeps its
 * behaviour — it answers the question those checks could not: *is this
 * environment production-like, and which defaults follow from that?*
 *
 * Not to be confused with `services/configuration/profiles.ts`, which describes
 * deployment *shapes* (docker, kubernetes, high-availability) for the admin UI.
 * This file describes what an environment is allowed to do.
 */

export type SecurityProfile = "development" | "test" | "staging" | "production";

export interface SecurityDefaults {
  readonly id: SecurityProfile;
  /** Production-like environments get the full configuration validation. */
  readonly productionLike: boolean;
  /** Whether an `error` finding refuses to start. Staging mirrors production. */
  readonly strict: boolean;
  readonly cookieSecure: boolean;
  readonly cookieSameSite: "strict" | "lax";
  /** Outbound HTTP (webhooks, SSO) is refused when this is set. */
  readonly outboundHttpsRequired: boolean;
  /** Whether a missing encryption key is a warning or merely noted. */
  readonly encryptionKeyRequired: boolean;
  /**
   * Whether the in-process queue is acceptable. It is never shared between
   * instances and loses work on restart, so it is an error in production and a
   * warning in staging (a single-node staging deployment is a legitimate use).
   */
  readonly inProcessQueueAllowed: boolean;
  readonly logLevel: string;
}

const PROFILES: Record<SecurityProfile, SecurityDefaults> = {
  development: {
    id: "development",
    productionLike: false,
    strict: false,
    cookieSecure: false,
    cookieSameSite: "lax",
    outboundHttpsRequired: false,
    encryptionKeyRequired: false,
    inProcessQueueAllowed: true,
    logLevel: "debug",
  },
  // Quiet on purpose: a test environment is not a deployment, and a warning that
  // fires in every suite trains people to ignore warnings. The diagnostics
  // contract already promises `warnings: []` under NODE_ENV=test.
  test: {
    id: "test",
    productionLike: false,
    strict: false,
    cookieSecure: false,
    cookieSameSite: "lax",
    outboundHttpsRequired: false,
    encryptionKeyRequired: false,
    inProcessQueueAllowed: true,
    logLevel: "debug",
  },
  // Production's posture, with one concession: a single-node staging deployment
  // may use the in-process queue. Everything that would leak a credential or send
  // traffic in the clear stays fatal, so staging fails the same way production
  // would before the deploy exists.
  staging: {
    id: "staging",
    productionLike: true,
    strict: true,
    cookieSecure: true,
    cookieSameSite: "strict",
    outboundHttpsRequired: true,
    encryptionKeyRequired: true,
    inProcessQueueAllowed: true,
    logLevel: "info",
  },
  production: {
    id: "production",
    productionLike: true,
    strict: true,
    cookieSecure: true,
    cookieSameSite: "strict",
    outboundHttpsRequired: true,
    encryptionKeyRequired: true,
    inProcessQueueAllowed: false,
    logLevel: "info",
  },
};

const KNOWN: readonly SecurityProfile[] = ["development", "test", "staging", "production"];

export function isKnownProfile(value: string): value is SecurityProfile {
  return (KNOWN as readonly string[]).includes(value);
}

/**
 * Map a `NODE_ENV` value onto a profile.
 *
 * An unknown value resolves to **development**, not production: guessing the
 * stricter profile would refuse to start a running system on upgrade, and
 * guessing the looser one is what already happens today. The validator reports
 * the unknown value as a warning so it is visible rather than silent.
 */
export function resolveProfile(nodeEnv: string | undefined): SecurityProfile {
  return nodeEnv && isKnownProfile(nodeEnv) ? nodeEnv : "development";
}

export function securityDefaults(profile: SecurityProfile): SecurityDefaults {
  return PROFILES[profile];
}

/** Every profile, in increasing strictness — used by the error message. */
export function knownProfiles(): readonly SecurityProfile[] {
  return KNOWN;
}
