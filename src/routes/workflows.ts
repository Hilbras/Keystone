import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, orgMemberships } from "../db/schema.js";
import { registerWorkflow, listWorkflowRuns } from "../services/workflows/engine.js";
import { isBlockedWorkflowStep } from "../services/workflows/steps.js";

const WorkflowStepSchema = z
  .object({
    type: z.string(),
    name: z.string().optional(),
  })
  .passthrough()
  .refine((step) => !isBlockedWorkflowStep(step), {
    message: "This workflow step is not allowed for organization workflows",
  });

const CreateWorkflowSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  trigger: z.enum(["user_registered", "user_login", "organization_created"]),
  definition: z.object({
    steps: z.array(WorkflowStepSchema),
  }),
  isActive: z.boolean().optional(),
});

async function requireOrgMembership(request: FastifyRequest, reply: FastifyReply, orgId: string) {
  await request.server.authenticate(request, reply);
  if (reply.sent) return false;

  const userId = request.user!.id;
  const [membership] = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1);

  if (!membership) {
    reply.status(403).send({ error: "Forbidden: not a member of this organization" });
    return false;
  }
  return true;
}

export default async function workflowRoutes(app: FastifyInstance) {
  app.get("/workflows", { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = request.query as { orgId?: string };
    const orgId = query?.orgId;

    if (!orgId) {
      return reply.status(400).send({ error: "orgId query parameter is required" });
    }

    // Verify org membership
    const userId = request.user!.id;
    const [membership] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    if (!membership) {
      return reply.status(403).send({ error: "Forbidden: not a member of this organization" });
    }

    const all = await db.select().from(workflows).where(eq(workflows.orgId, orgId));
    return { workflows: all };
  });

  app.post("/workflows", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = CreateWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid workflow", details: parsed.error.issues });
    }
    const body = parsed.data;

    // Verify org membership
    const userId = request.user!.id;
    const [membership] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, body.orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    if (!membership) {
      return reply.status(403).send({ error: "Forbidden: not a member of this organization" });
    }

    const workflow = await registerWorkflow({
      orgId: body.orgId,
      name: body.name,
      trigger: body.trigger,
      definition: body.definition,
    });
    await request.audit("workflow_created", { workflowId: workflow.id, trigger: body.trigger, orgId: body.orgId });
    return reply.status(201).send(workflow);
  });

  app.get("/workflows/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });

    // Verify org membership
    if (workflow.orgId) {
      const userId = request.user!.id;
      const [membership] = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, workflow.orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!membership) {
        return reply.status(403).send({ error: "Forbidden" });
      }
    }

    return { workflow };
  });

  app.delete("/workflows/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    // Find the workflow and verify org membership
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });

    // Verify org membership
    if (workflow.orgId) {
      const [membership] = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, workflow.orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!membership) {
        return reply.status(403).send({ error: "Forbidden" });
      }
    }

    const [record] = await db.delete(workflows).where(eq(workflows.id, id)).returning();
    if (!record) return reply.status(404).send({ error: "Workflow not found" });
    await request.audit("workflow_deleted", { workflowId: record.id });
    return { success: true };
  });

  app.get("/workflows/:id/runs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });

    // Verify org membership
    if (workflow.orgId) {
      const userId = request.user!.id;
      const [membership] = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, workflow.orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!membership) {
        return reply.status(403).send({ error: "Forbidden" });
      }
    }

    const runs = await listWorkflowRuns(id);
    return { runs };
  });
}
