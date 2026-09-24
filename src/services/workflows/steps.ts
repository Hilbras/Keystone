import { queue } from "../queue/index.js";
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

export const SAFE_WORKFLOW_STEP_TYPES = new Set(["send_email", "send_welcome_email"]);

export function isBlockedWorkflowStep(step: WorkflowStep): boolean {
  return !SAFE_WORKFLOW_STEP_TYPES.has(step.type);
}

export interface StepResult {
  output?: Record<string, string>;
  error?: string;
}

export async function executeStep(step: WorkflowStep, context: StepContext): Promise<StepResult> {
  const log = (msg: string) => console.log(`[workflow] step ${step.type}: ${msg}`);

  if (isBlockedWorkflowStep(step)) {
    return { error: `workflow step ${step.type} is not allowed for tenant workflows` };
  }

  switch (step.type) {
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

    default:
      return { error: `workflow step ${step.type} is not allowed` };
  }
}
