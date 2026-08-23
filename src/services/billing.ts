import { eq, and, gte, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations, auditLog, orgMemberships, applications } from "../db/schema.js";
import { getBillingProviderFactory } from "./plugins/registry.js";

const DEFAULT_PLANS = ["free", "starter", "growth", "enterprise"];

export function listPlans(): Array<{ id: string; name: string; description: string }> {
  return [
    { id: "free", name: "Free", description: "Core authentication for small projects." },
    { id: "starter", name: "Starter", description: "Email delivery, workflows, and API keys." },
    { id: "growth", name: "Growth", description: "SSO, SCIM, and priority queue workers." },
    { id: "enterprise", name: "Enterprise", description: "Custom SLAs, dedicated support, and advanced audit." },
  ];
}

export function isValidPlan(plan: string): boolean {
  return DEFAULT_PLANS.includes(plan);
}

export interface BillingSummary {
  plan: string;
  provider?: string;
  subscription?: Record<string, unknown>;
  usage?: {
    users: number;
    applications: number;
    logins30d: number;
    signups30d: number;
  };
}

export async function getBillingSummary(orgId: string): Promise<BillingSummary> {
  const [org] = await db.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) {
    throw Object.assign(new Error("Organization not found"), { statusCode: 404 });
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [[memberRow], [appRow], [loginRow], [signupRow]] = await Promise.all([
    db.select({ total: count() }).from(orgMemberships).where(eq(orgMemberships.orgId, orgId)),
    db.select({ total: count() }).from(applications).where(eq(applications.orgId, orgId)),
    db
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.event, "user_login"), gte(auditLog.createdAt, since))),
    db
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.event, "user_registered"), gte(auditLog.createdAt, since))),
  ]);

  const usage = {
    users: memberRow?.total ?? 0,
    applications: appRow?.total ?? 0,
    logins30d: loginRow?.total ?? 0,
    signups30d: signupRow?.total ?? 0,
  };

  const factory = getBillingProviderFactory(process.env.KEYSTONE_BILLING_PROVIDER || "none");
  if (!factory) {
    return { plan: org.plan, usage };
  }
  const provider = factory();
  const subscription = await provider.getSubscription(orgId).catch(() => null);
  return { plan: org.plan, provider: provider.name, subscription: subscription ?? undefined, usage };
}

export async function setOrganizationPlan(orgId: string, plan: string): Promise<{ plan: string }> {
  if (!isValidPlan(plan)) {
    throw Object.assign(new Error("Invalid plan"), { statusCode: 400 });
  }
  const [org] = await db.update(organizations).set({ plan, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
  if (!org) {
    throw Object.assign(new Error("Organization not found"), { statusCode: 404 });
  }
  return { plan: org.plan };
}

export async function provisionBillingCustomer(orgId: string, email: string): Promise<Record<string, unknown>> {
  const factory = getBillingProviderFactory(process.env.KEYSTONE_BILLING_PROVIDER || "none");
  if (!factory) {
    return { ok: false, reason: "No billing provider configured" };
  }
  const provider = factory();
  return provider.createCustomer(orgId, email);
}
