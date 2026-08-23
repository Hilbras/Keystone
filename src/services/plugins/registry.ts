import type {
  KeystonePlugin,
  PluginMetadata,
  WorkflowStepExecutor,
  AuthenticationMethod,
  AnalyticsProvider,
  BillingProvider,
  AuthorizationPolicy,
  RegisteredPluginSummary,
  ExtensionPointSummary,
} from "./types.js";
import type { IdentityConnector } from "../connectors/types.js";
import type { EmailProvider } from "../email.js";
import type { SmsProvider } from "../sms.js";

const plugins: KeystonePlugin[] = [];
const connectorFactories = new Map<string, (config?: Record<string, unknown>) => IdentityConnector>();
const workflowStepExecutors = new Map<string, WorkflowStepExecutor>();
const authenticationMethodFactories = new Map<string, (config?: Record<string, unknown>) => AuthenticationMethod>();
const analyticsProviderFactories = new Map<string, (config?: Record<string, unknown>) => AnalyticsProvider>();
const billingProviderFactories = new Map<string, (config?: Record<string, unknown>) => BillingProvider>();
const authorizationPolicyFactories = new Map<string, (config?: Record<string, unknown>) => AuthorizationPolicy>();
let emailProvider: EmailProvider | undefined;
let smsProvider: SmsProvider | undefined;

function collectExtensionPoints(plugin: KeystonePlugin): string[] {
  const points: string[] = [];
  if (plugin.connectors) points.push("connectors");
  if (plugin.emailProvider) points.push("emailProvider");
  if (plugin.smsProvider) points.push("smsProvider");
  if (plugin.workflowSteps) points.push("workflowSteps");
  if (plugin.authenticationMethods) points.push("authenticationMethods");
  if (plugin.analyticsProviders) points.push("analyticsProviders");
  if (plugin.billingProviders) points.push("billingProviders");
  if (plugin.authorizationPolicies) points.push("authorizationPolicies");
  return points;
}

export function registerPlugin(plugin: KeystonePlugin): void {
  plugins.push(plugin);

  if (plugin.connectors) {
    for (const [type, factory] of Object.entries(plugin.connectors)) {
      connectorFactories.set(type, factory);
    }
  }

  if (plugin.emailProvider) {
    emailProvider = plugin.emailProvider;
  }

  if (plugin.smsProvider) {
    smsProvider = plugin.smsProvider;
  }

  if (plugin.workflowSteps) {
    for (const [type, executor] of Object.entries(plugin.workflowSteps)) {
      workflowStepExecutors.set(type, executor);
    }
  }

  if (plugin.authenticationMethods) {
    for (const [type, factory] of Object.entries(plugin.authenticationMethods)) {
      authenticationMethodFactories.set(type, factory);
    }
  }

  if (plugin.analyticsProviders) {
    for (const [type, factory] of Object.entries(plugin.analyticsProviders)) {
      analyticsProviderFactories.set(type, factory);
    }
  }

  if (plugin.billingProviders) {
    for (const [type, factory] of Object.entries(plugin.billingProviders)) {
      billingProviderFactories.set(type, factory);
    }
  }

  if (plugin.authorizationPolicies) {
    for (const [type, factory] of Object.entries(plugin.authorizationPolicies)) {
      authorizationPolicyFactories.set(type, factory);
    }
  }

  if (plugin.onRegister) {
    Promise.resolve(plugin.onRegister()).catch((err) => {
      console.error(`Plugin ${plugin.metadata.name} onRegister failed:`, err);
    });
  }
}

export function unregisterPlugin(name: string): boolean {
  const index = plugins.findIndex((p) => p.metadata.name === name);
  if (index === -1) return false;

  const [plugin] = plugins.splice(index, 1);

  if (plugin.connectors) {
    for (const type of Object.keys(plugin.connectors)) {
      connectorFactories.delete(type);
    }
  }

  if (plugin.workflowSteps) {
    for (const type of Object.keys(plugin.workflowSteps)) {
      workflowStepExecutors.delete(type);
    }
  }

  if (plugin.authenticationMethods) {
    for (const type of Object.keys(plugin.authenticationMethods)) {
      authenticationMethodFactories.delete(type);
    }
  }

  if (plugin.analyticsProviders) {
    for (const type of Object.keys(plugin.analyticsProviders)) {
      analyticsProviderFactories.delete(type);
    }
  }

  if (plugin.billingProviders) {
    for (const type of Object.keys(plugin.billingProviders)) {
      billingProviderFactories.delete(type);
    }
  }

  if (plugin.authorizationPolicies) {
    for (const type of Object.keys(plugin.authorizationPolicies)) {
      authorizationPolicyFactories.delete(type);
    }
  }

  if (plugin.emailProvider && emailProvider === plugin.emailProvider) {
    emailProvider = undefined;
  }

  if (plugin.smsProvider && smsProvider === plugin.smsProvider) {
    smsProvider = undefined;
  }

  if (plugin.onUnregister) {
    Promise.resolve(plugin.onUnregister()).catch((err) => {
      console.error(`Plugin ${plugin.metadata.name} onUnregister failed:`, err);
    });
  }

  return true;
}

export function getConnectorFactory(type: string): ((config?: Record<string, unknown>) => IdentityConnector) | undefined {
  return connectorFactories.get(type);
}

export function getPluginEmailProvider(): EmailProvider | undefined {
  return emailProvider;
}

export function getPluginSmsProvider(): SmsProvider | undefined {
  return smsProvider;
}

export function getPluginWorkflowStep(type: string): WorkflowStepExecutor | undefined {
  return workflowStepExecutors.get(type);
}

export function getAuthenticationMethodFactory(
  type: string
): ((config?: Record<string, unknown>) => AuthenticationMethod) | undefined {
  return authenticationMethodFactories.get(type);
}

export function getAnalyticsProviderFactory(
  type: string
): ((config?: Record<string, unknown>) => AnalyticsProvider) | undefined {
  return analyticsProviderFactories.get(type);
}

export function getBillingProviderFactory(
  type: string
): ((config?: Record<string, unknown>) => BillingProvider) | undefined {
  return billingProviderFactories.get(type);
}

export function getAuthorizationPolicyFactory(
  type: string
): ((config?: Record<string, unknown>) => AuthorizationPolicy) | undefined {
  return authorizationPolicyFactories.get(type);
}

export function listRegisteredPlugins(): RegisteredPluginSummary[] {
  return plugins.map((p) => ({
    metadata: p.metadata,
    extensionPoints: collectExtensionPoints(p),
  }));
}

export function listExtensionPoints(): ExtensionPointSummary[] {
  return [
    {
      name: "connectors",
      description: "Identity provider adapters (OAuth2/OIDC/SAML).",
      registered: Array.from(connectorFactories.keys()),
    },
    {
      name: "emailProvider",
      description: "Transactional email delivery backend.",
      registered: emailProvider?.name ? [emailProvider.name] : [],
    },
    {
      name: "smsProvider",
      description: "SMS delivery backend.",
      registered: smsProvider?.name ? [smsProvider.name] : [],
    },
    {
      name: "workflowSteps",
      description: "Reusable steps for automation workflows.",
      registered: Array.from(workflowStepExecutors.keys()),
    },
    {
      name: "authenticationMethods",
      description: "Alternative authentication mechanisms.",
      registered: Array.from(authenticationMethodFactories.keys()),
    },
    {
      name: "analyticsProviders",
      description: "Analytics and event tracking backends.",
      registered: Array.from(analyticsProviderFactories.keys()),
    },
    {
      name: "billingProviders",
      description: "Subscription and billing integrations.",
      registered: Array.from(billingProviderFactories.keys()),
    },
    {
      name: "authorizationPolicies",
      description: "Custom authorization policy engines.",
      registered: Array.from(authorizationPolicyFactories.keys()),
    },
  ];
}
