import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { workflows, workflowRuns, orgMemberships, users, permissions, rolePermissions, type Workflow, type WorkflowRun } from "../../db/schema.js";
import { findUserById } from "../users.js";
import { subscribe, emit } from "../events/bus.js";
import type { KeystoneEvent } from "../events/types.js";
import { queue } from "../queue/index.js";
import { executeStep, isBlockedWorkflowStep, type WorkflowStep } from "./steps.js";

export interface WorkflowDefinition {
  steps: WorkflowStep[];
  [key: string]: unknown;
}

function readWorkflowSteps(definition: unknown): WorkflowStep[] | null {
  if (!definition || typeof definition !== "object") return null;
  const steps = (definition as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  if (!steps.every((step) => step && typeof step === "object" && typeof (step as { type?: unknown }).type === "string")) {
    return null;
  }
  return steps as WorkflowStep[];
}

async function hasWorkflowPermission(actorId: string, orgId: string): Promise<boolean> {
  const [membership] = await db
    .select({ role: orgMemberships.role, isActive: users.isActive })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, actorId)))
    .limit(1);
  if (!membership?.isActive || (membership.role !== "owner" && membership.role !== "admin")) return false;
  const [permission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .innerJoin(rolePermissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        eq(permissions.resource, "organization"),
        eq(permissions.action, "update"),
        eq(rolePermissions.role, membership.role)
      )
    )
    .limit(1);
  return Boolean(permission);
}

let loaded = false;

export async function loadWorkflows(): Promise<void> {
  if (loaded) return;
  loaded = true;

  const activeWorkflows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.isActive, true)));

  for (const workflow of activeWorkflows) {
    subscribe(workflow.trigger, async (event) => {
      await triggerWorkflowRun(workflow, event);
    });
  }
}

export async function registerWorkflow(input: {
  actorId: string;
  orgId: string;
  name: string;
  trigger: string;
  definition: WorkflowDefinition;
  isActive?: boolean;
}): Promise<Workflow> {
  const steps = readWorkflowSteps(input.definition);
  if (!input.orgId) {
    throw new Error("Organization-scoped workflows require an organization ID");
  }
  const [membership] = await db
    .select({ role: orgMemberships.role, isActive: users.isActive })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.userId, input.actorId)))
    .limit(1);
  if (!membership?.isActive || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new Error("Only organization owners or admins can register workflows");
  }
  const [permission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .innerJoin(rolePermissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        eq(permissions.resource, "organization"),
        eq(permissions.action, "update"),
        eq(rolePermissions.role, membership.role)
      )
    )
    .limit(1);
  if (!permission) {
    throw new Error("Organization role lacks workflow registration permission");
  }
  if (!steps || steps.some(isBlockedWorkflowStep)) {
    throw new Error("Workflow contains an invalid or blocked step");
  }

  const [workflow] = await db
    .insert(workflows)
    .values({
      orgId: input.orgId,
      name: input.name,
      trigger: input.trigger,
      definition: input.definition,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (workflow.isActive) {
    subscribe(workflow.trigger, async (event) => {
      await triggerWorkflowRun(workflow, event);
    });
  }
  return workflow;
}

export async function triggerWorkflowRun(workflow: Workflow, event: KeystoneEvent): Promise<WorkflowRun | undefined> {
  const definition = (workflow.definition ?? { steps: [] }) as WorkflowDefinition;
  const steps = readWorkflowSteps(definition);
  const eventOrgId = typeof event.payload.orgId === "string" ? event.payload.orgId : undefined;
  const hasBlockedStep = steps === null || steps.some(isBlockedWorkflowStep);
  const inactiveWorkflow = workflow.isActive === false;
  const triggerMismatch = workflow.trigger !== event.type;
  let isOutOfScope = triggerMismatch || Boolean(workflow.orgId && eventOrgId !== workflow.orgId);
  if (!isOutOfScope && workflow.orgId && typeof event.payload.userId === "string") {
    const [membership] = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, workflow.orgId), eq(orgMemberships.userId, event.payload.userId)))
      .limit(1);
    isOutOfScope = !membership;
  }
  const eventUserId = typeof event.payload.userId === "string" ? event.payload.userId : undefined;
  if (inactiveWorkflow || triggerMismatch || isOutOfScope || (workflow.orgId && (!eventUserId || !(await hasWorkflowPermission(eventUserId, workflow.orgId))))) {
    const reason = inactiveWorkflow
      ? "Workflow is inactive"
      : triggerMismatch
        ? "Workflow trigger does not match the emitted event"
        : isOutOfScope
          ? "Workflow event does not belong to the workflow organization"
          : "Workflow actor lacks current organization permission";
    await emit({
      type: "workflow_blocked",
      payload: {
        orgId: workflow.orgId ?? undefined,
        metadata: { workflowId: workflow.id, reason },
      },
    });
    return undefined;
  }
  const blockedReason = inactiveWorkflow
    ? "Workflow is inactive"
    : hasBlockedStep
      ? "Workflow contains a blocked authorization step"
      : triggerMismatch
        ? "Workflow trigger does not match the emitted event"
        : isOutOfScope
          ? "Workflow event does not belong to the workflow organization"
          : undefined;
  const now = new Date();
  const [run] = await db
    .insert(workflowRuns)
    .values({
      workflowId: workflow.id,
      triggerEvent: event.type,
      payload: event.payload as Record<string, unknown>,
      status: blockedReason ? "blocked" : "running",
      startedAt: now,
      finishedAt: blockedReason ? now : null,
      log: blockedReason ? [{ status: "blocked", error: blockedReason }] : [],
    })
    .returning();

  if (blockedReason) {
    await emit({
      type: "workflow_blocked",
      payload: {
        orgId: workflow.orgId ?? undefined,
        metadata: { workflowId: workflow.id, runId: run.id, reason: blockedReason },
      },
    });
    return run;
  }

  // Dispatch to the background queue so the HTTP response is not blocked.
  await queue.enqueue({
    type: "workflow_run",
    payload: { runId: run.id, workflowId: workflow.id },
  });

  return run;
}

export async function executeRunById(runId: string, workflowId: string): Promise<void> {
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workflowId, workflowId)))
    .limit(1);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!run || !workflow) {
    console.error(`[workflow-engine] run or workflow not found: ${runId}, ${workflowId}`);
    return;
  }
  await executeRun(run, workflow);
}

async function executeRun(run: WorkflowRun, workflow: Workflow): Promise<void> {
  if (!workflow.isActive) {
    await db
      .update(workflowRuns)
      .set({
        status: "blocked",
        finishedAt: new Date(),
        log: [{ status: "blocked", error: "Workflow is inactive" }],
      })
      .where(eq(workflowRuns.id, run.id));
    await emit({
      type: "workflow_blocked",
      payload: {
        orgId: workflow.orgId ?? undefined,
        metadata: { workflowId: workflow.id, runId: run.id, reason: "inactive_workflow" },
      },
    });
    return;
  }

  const definition = (workflow.definition ?? { steps: [] }) as WorkflowDefinition;
  const payload = (run.payload ?? {}) as Record<string, unknown>;
  const steps = readWorkflowSteps(definition);
  if (!steps || steps.some(isBlockedWorkflowStep)) {
    await db
      .update(workflowRuns)
      .set({
        status: "blocked",
        finishedAt: new Date(),
        log: [{ status: "blocked", error: "Workflow contains an invalid or blocked authorization step" }],
      })
      .where(eq(workflowRuns.id, run.id));
    await emit({
      type: "workflow_blocked",
      payload: {
        orgId: workflow.orgId ?? undefined,
        metadata: { workflowId: workflow.id, runId: run.id, reason: "invalid_or_blocked_step" },
      },
    });
    return;
  }
  const userId = typeof payload.userId === "string" ? payload.userId : undefined;
  if (workflow.orgId && (!userId || !(await hasWorkflowPermission(userId, workflow.orgId)))) {
    await db
      .update(workflowRuns)
      .set({
        status: "blocked",
        finishedAt: new Date(),
        log: [{ status: "blocked", error: "Workflow actor lacks current organization permission" }],
      })
      .where(eq(workflowRuns.id, run.id));
    await emit({
      type: "workflow_blocked",
      payload: {
        orgId: workflow.orgId ?? undefined,
        metadata: { workflowId: workflow.id, runId: run.id, reason: "actor_permission_revoked" },
      },
    });
    return;
  }
  const user = userId ? await findUserById(userId) : undefined;
  const outputs: Record<string, string> = {};
  const log: Array<{ step: string; status: string; output?: Record<string, string>; error?: string }> = [];

  for (const step of steps) {
    const result = await executeStep(step, { payload, outputs, user });
    if (result.output) {
      Object.assign(outputs, result.output);
      if (step.name) outputs[step.name] = Object.values(result.output)[0] ?? "";
    }
    log.push({
      step: step.type,
      status: result.error ? "failed" : "ok",
      output: result.output,
      error: result.error,
    });
    if (result.error) {
      await db
        .update(workflowRuns)
        .set({ status: "failed", finishedAt: new Date(), log })
        .where(eq(workflowRuns.id, run.id));
      return;
    }
  }

  await db
    .update(workflowRuns)
    .set({ status: "completed", finishedAt: new Date(), log })
    .where(eq(workflowRuns.id, run.id));
}

export async function listWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]> {
  if (workflowId) {
    return db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
  }
  return db.select().from(workflowRuns);
}
