import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { workflows, workflowRuns, type Workflow, type WorkflowRun } from "../../db/schema.js";
import { findUserById } from "../users.js";
import { subscribe } from "../events/bus.js";
import type { KeystoneEvent } from "../events/types.js";
import { queue } from "../queue/index.js";
import { executeStep, type WorkflowStep } from "./steps.js";

export interface WorkflowDefinition {
  steps: WorkflowStep[];
  [key: string]: unknown;
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
  orgId?: string;
  name: string;
  trigger: string;
  definition: WorkflowDefinition;
}): Promise<Workflow> {
  const [workflow] = await db
    .insert(workflows)
    .values({
      orgId: input.orgId ?? null,
      name: input.name,
      trigger: input.trigger,
      definition: input.definition,
    })
    .returning();
  subscribe(workflow.trigger, async (event) => {
    await triggerWorkflowRun(workflow, event);
  });
  return workflow;
}

export async function triggerWorkflowRun(workflow: Workflow, event: KeystoneEvent): Promise<WorkflowRun> {
  const [run] = await db
    .insert(workflowRuns)
    .values({
      workflowId: workflow.id,
      triggerEvent: event.type,
      payload: event.payload as Record<string, unknown>,
      status: "running",
      startedAt: new Date(),
    })
    .returning();

  // Dispatch to the background queue so the HTTP response is not blocked.
  await queue.enqueue({
    type: "workflow_run",
    payload: { runId: run.id, workflowId: workflow.id },
  });

  return run;
}

export async function executeRunById(runId: string, workflowId: string): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!run || !workflow) {
    console.error(`[workflow-engine] run or workflow not found: ${runId}, ${workflowId}`);
    return;
  }
  await executeRun(run, workflow);
}

async function executeRun(run: WorkflowRun, workflow: Workflow): Promise<void> {
  const definition = (workflow.definition ?? { steps: [] }) as WorkflowDefinition;
  const payload = (run.payload ?? {}) as Record<string, unknown>;
  const userId = payload.userId as string | undefined;
  const user = userId ? await findUserById(userId) : undefined;
  const outputs: Record<string, string> = {};
  const log: Array<{ step: string; status: string; output?: Record<string, string>; error?: string }> = [];

  for (const step of definition.steps ?? []) {
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
