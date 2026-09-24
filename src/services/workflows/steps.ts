import { createOrganization, findOrganizationBySlug } from "../organizations.js";
import { queue } from "../queue/index.js";
import { getPluginWorkflowStep } from "../plugins/registry.js";
import type { EmailMessage } from "../email.js";
import type { User } from "../../db/schema.js";

export interface StepContext {
  payload: Record<string, unknown>;
  outputs: Record<string, string>;
  user?: User;
}

export interface WorkflowStep {
  type: string;
  name?: string;
  [key: string]: unknown;
}

export const BLOCKED_WORKFLOW_STEP_TYPES = new Set(["assign_role", "add_membership", "add_app_membership"]);

export function isBlockedWorkflowStep(step: WorkflowStep): boolean {
  return BLOCKED_WORKFLOW_STEP_TYPES.has(step.type);
}

export interface StepResult {
  output?: Record<string, string>;
  error?: string;
}

function interpolate(template: string, context: StepContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = context.payload[key] ?? context.outputs[key] ?? "";
    return String(value);
  });
}

export async function executeStep(step: WorkflowStep, context: StepContext): Promise<StepResult> {
  const log = (msg: string) => console.log(`[workflow] step ${step.type}: ${msg}`);

  if (isBlockedWorkflowStep(step)) {
    return { error: `workflow step ${step.type} is not allowed for tenant workflows` };
  }

  switch (step.type) {
    case "create_organization": {
      const nameTemplate = String(step.orgName || "{{username}}-personal");
      const name = interpolate(nameTemplate, context);
      const slugTemplate = String(step.slug || "{{username}}-personal");
      const slug = interpolate(slugTemplate, context);
      const existing = await findOrganizationBySlug(slug);
      if (existing) {
        return { output: { [String(step.outputKey || "orgId")]: existing.id } };
      }
      const org = await createOrganization({ name, slug });
      log(`created organization ${org.id}`);
      return { output: { [String(step.outputKey || "orgId")]: org.id } };
    }

    case "send_email": {
      const to = String(step.to || context.user?.email || "");
      if (!to) return { error: "missing email" };
      const message: EmailMessage = {
        to,
        subject: String(step.subject || "Hilbras notification"),
        text: String(step.text || ""),
      };
      await queue.enqueue({ type: "email", payload: { message } });
      log(`enqueued email to ${to}`);
      return {};
    }

    case "send_welcome_email": {
      const to = context.user?.email;
      if (!to || !context.user) return { error: "missing user email" };
      const message: EmailMessage = {
        to,
        subject: "Welcome to Hilbras",
        text: `Hi ${context.user.name || context.user.username},\n\nWelcome to Hilbras! Your account has been created.`,
      };
      await queue.enqueue({ type: "email", payload: { message } });
      log(`enqueued welcome email to ${to}`);
      return {};
    }

    case "webhook": {
      const url = String(step.url || "");
      if (!url) return { error: "missing webhook url" };
      await queue.enqueue({
        type: "webhook",
        payload: { url, method: String(step.method || "POST"), body: context.payload },
      });
      log(`enqueued webhook ${url}`);
      return {};
    }

    default: {
      const pluginExecutor = getPluginWorkflowStep(step.type);
      if (pluginExecutor) {
        return pluginExecutor(step, context);
      }
      return { error: `unknown step type ${step.type}` };
    }
  }
}
