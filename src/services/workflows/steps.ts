import { createOrganization, addOrgMembership, findOrganizationBySlug } from "../organizations.js";
import { findApplicationByClientId } from "../applications.js";
import { updateUser } from "../users.js";
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

  switch (step.type) {
    case "assign_role": {
      const role = String(step.role || "user");
      if (context.user) {
        await updateUser(context.user.id, { role });
        log(`assigned role ${role} to ${context.user.id}`);
      }
      return {};
    }

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

    case "add_membership": {
      const userId = context.user?.id;
      if (!userId) return { error: "missing user" };
      const orgRef = String(step.orgRef || "personalOrgId");
      const orgId = context.outputs[orgRef];
      if (!orgId) return { error: `missing output ${orgRef}` };
      const role = String(step.role || "member");
      await addOrgMembership({ orgId, userId, role: role as import("../organizations.js").OrgRole });
      log(`added membership ${userId} -> ${orgId} as ${role}`);
      return {};
    }

    case "add_app_membership": {
      const userId = context.user?.id;
      if (!userId) return { error: "missing user" };
      const clientId = String(step.clientId || context.payload.client_id || "");
      if (!clientId) return { error: "missing client_id" };
      const app = await findApplicationByClientId(clientId);
      if (!app) return { error: "application not found" };
      await addOrgMembership({ orgId: app.orgId, userId, role: "member" });
      log(`added app membership ${userId} -> ${app.orgId}`);
      return {};
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
