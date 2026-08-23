import type { IdentityConnector } from "../connectors/types.js";
import type { EmailProvider } from "../email.js";
import type { SmsProvider } from "../sms.js";
import type { WorkflowStep, StepContext, StepResult } from "../workflows/steps.js";
import type { Result, KeystoneError } from "../../lib/result.js";

export type WorkflowStepExecutor = (step: WorkflowStep, context: StepContext) => Promise<StepResult> | StepResult;

export interface PluginMetadata {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  username?: string;
  roles?: string[];
}

export interface AuthenticationMethodContext {
  body: Record<string, unknown>;
  ip: string;
  userAgent?: string;
}

export interface AuthenticationMethod {
  id: string;
  name: string;
  description?: string;
  authenticate(ctx: AuthenticationMethodContext): Promise<Result<AuthenticatedUser>>;
}

export interface AnalyticsEvent {
  type: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export interface AnalyticsProvider {
  id: string;
  name: string;
  track(event: AnalyticsEvent): Promise<void>;
  identify?(userId: string, traits?: Record<string, unknown>): Promise<void>;
  page?(name: string, properties?: Record<string, unknown>): Promise<void>;
}

export interface BillingProvider {
  id: string;
  name?: string;
  createCustomer(tenantId: string, email: string): Promise<Record<string, unknown>>;
  subscribe(tenantId: string, planId: string): Promise<Record<string, unknown>>;
  getSubscription(tenantId: string): Promise<Record<string, unknown> | null>;
}

export interface AuthorizationPolicyContext {
  subjectId: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

export interface AuthorizationPolicy {
  id: string;
  name: string;
  evaluate(ctx: AuthorizationPolicyContext): Promise<Result<boolean>> | Result<boolean>;
}

export interface KeystonePlugin {
  metadata: PluginMetadata;
  connectors?: Record<string, (config?: Record<string, unknown>) => IdentityConnector>;
  emailProvider?: EmailProvider;
  smsProvider?: SmsProvider;
  workflowSteps?: Record<string, WorkflowStepExecutor>;
  authenticationMethods?: Record<string, (config?: Record<string, unknown>) => AuthenticationMethod>;
  analyticsProviders?: Record<string, (config?: Record<string, unknown>) => AnalyticsProvider>;
  billingProviders?: Record<string, (config?: Record<string, unknown>) => BillingProvider>;
  authorizationPolicies?: Record<string, (config?: Record<string, unknown>) => AuthorizationPolicy>;
  onRegister?(): Promise<void> | void;
  onUnregister?(): Promise<void> | void;
}

export interface RegisteredPluginSummary {
  metadata: PluginMetadata;
  extensionPoints: string[];
}

export interface ExtensionPointSummary {
  name: string;
  description: string;
  registered: string[];
}
