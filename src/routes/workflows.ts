import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { registerWorkflow, listWorkflowRuns } from "../services/workflows/engine.js";

const WorkflowStepSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
});

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  trigger: z.enum(["user_registered", "user_login", "organization_created"]),
  definition: z.object({
    steps: z.array(WorkflowStepSchema.and(z.record(z.unknown()))),
  }),
  isActive: z.boolean().optional(),
});

export default async function workflowRoutes(app: FastifyInstance) {
  app.get("/workflows", { preHandler: [app.authenticate] }, async (request) => {
    const query = request.query as { orgId?: string } | undefined;
    const orgId = query?.orgId;

    const all = orgId
      ? await db.select().from(workflows).where(eq(workflows.orgId, orgId))
      : await db.select().from(workflows);
    return { workflows: all };
  });

  app.post("/workflows", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = CreateWorkflowSchema.parse(request.body);
    const workflow = await registerWorkflow({
      name: body.name,
      trigger: body.trigger,
      definition: body.definition,
    });
    await request.audit("workflow_created", { workflowId: workflow.id, trigger: body.trigger });
    return reply.status(201).send(workflow);
  });

  app.get("/workflows/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    return { workflow };
  });

  app.delete("/workflows/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [record] = await db.delete(workflows).where(eq(workflows.id, id)).returning();
    if (!record) return reply.status(404).send({ error: "Workflow not found" });
    await request.audit("workflow_deleted", { workflowId: record.id });
    return { success: true };
  });

  app.get("/workflows/:id/runs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    const runs = await listWorkflowRuns(id);
    return { runs };
  });
}
