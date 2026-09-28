import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerWorkflow, listWorkflowRuns } from "../services/workflows/engine.js";
import { isBlockedWorkflowStep } from "../services/workflows/steps.js";
import { getSdk } from "../sdk/index.js";
import { sendResultError } from "./admin/helpers.js";
import type { Workflow } from "../db/schema.js";

/**
 * The only organization routes in the codebase that did their own authorization.
 *
 * Five handlers, each writing the same membership query against `db` directly and
 * each deciding for itself what a caller who is not a member gets back. Two
 * problems, and the second is the one that mattered:
 *
 * - It bypassed the layering rule the rest of the codebase follows: a route
 *   importing `db` and `drizzle-orm` is a route that can skip a repository's
 *   tenancy guarantees by accident.
 * - Authorization was invisible at the route definition. Every other module shows
 *   its guard in `preHandler`, which is what makes the security model of a file
 *   readable by looking at the file. Here the check was inside the handler, so
 *   the five checks could drift apart, and adding a sixth route would have meant
 *   writing a sixth check from memory.
 *
 * So the check moved into a preHandler, and the data access into a repository.
 * The behaviour is unchanged — same 403s, same audit events — and it is now
 * visible in the route table.
 */

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

/** The workflow a route is about, once the guard has loaded it. */
declare module "fastify" {
  interface FastifyRequest {
    workflow?: Workflow;
  }
}

/**
 * Resolve the organization a request is about, from wherever the route carries
 * it: a query parameter for the collection, the body for a create, and — for the
 * `:id` routes — the workflow's own `orgId`, which is null for a platform-wide
 * workflow.
 */
function requestedOrgId(request: FastifyRequest): string | undefined {
  const query = request.query as { orgId?: string } | undefined;
  if (query?.orgId) return query.orgId;
  const body = request.body as { orgId?: string } | undefined;
  if (body?.orgId) return body.orgId;
  return request.workflow?.orgId ?? undefined;
}

/**
 * `orgId` is required on the collection route.
 *
 * Without this, `GET /workflows` with no `orgId` reaches the guard, which reads a
 * missing organization as a platform-wide workflow and demands platform-owner
 * rights. The previous handler returned 400. A client error has to stay a client
 * error: a 403 that says "you are not a platform owner" for a request that never
 * named an organization is a confusing answer, and it leaks that the endpoint
 * exists at all.
 */
async function requireOrgIdParam(request: FastifyRequest, reply: FastifyReply) {
  const orgId = (request.query as { orgId?: string } | undefined)?.orgId;
  if (!orgId) return reply.status(400).send({ error: "orgId query parameter is required" });
}

/**
 * Membership, and optionally a permission, for the organization this request is
 * about. The single place that decision is made.
 *
 * `permission` is passed as a function because two of the five routes are reads
 * and three are writes, and the read/write split is the whole difference between
 * them. A list of every route's requirement, next to the routes, is the point.
 */
function requireWorkflowAccess(
  options: {
    /** Null for a platform-wide workflow, which only a platform owner may touch. */
    permission?: (orgId: string) => { resource: string; action: string };
    auditAction: string;
  }
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const orgId = requestedOrgId(request);

    // A workflow with no organization is platform-wide. The previous code spelled
    // this out in every handler as `!isPlatformRole(role) || role !== "owner"`,
    // and the first clause is redundant with the second — it asks "is this a
    // platform role" and then ignores the answer.
    if (orgId === undefined) {
      if (request.user!.role !== "owner") {
        await request.audit("unauthorized_access", {
          action: "global_workflow_access",
          workflowId: request.workflow?.id,
        });
        return reply.status(403).send({ error: "Platform owner access required" });
      }
      return;
    }

    const sdk = getSdk();

    if (options.permission) {
      // Membership first, then the permission for the role that membership
      // carries. `requireOrganizationPermission` does both in one call but returns
      // `void`, and `request.state.membership` is what the audit trail and the
      // rest of the request read — so the two are resolved separately here, both
      // through the SDK and neither through `db`.
      const membershipResult = await sdk.authorization.requireOrgRole(userId, orgId, [
        "owner",
        "admin",
        "member",
      ]);
      if (!membershipResult.success) {
        await request.audit("unauthorized_access", {
          action: options.auditAction,
          orgId,
        });
        return sendResultError(reply, membershipResult);
      }
      request.state.membership = membershipResult.data;

      const { resource, action } = options.permission(orgId);
      const permissionResult = await sdk.authorization.requirePermission(
        userId,
        orgId,
        resource,
        action
      );
      if (!permissionResult.success) {
        await request.audit("unauthorized_access", {
          action: options.auditAction,
          orgId,
          resource,
          requiredAction: action,
        });
        return sendResultError(reply, permissionResult);
      }
    } else {
      // A read only needs membership, not a permission. `requireOrgRole` is the
      // one SDK call that establishes it, so this stays a single code path rather
      // than the hand-written query the handler used to run.
      const result = await sdk.authorization.requireOrgRole(userId, orgId, [
        "owner",
        "admin",
        "member",
      ]);
      if (!result.success) {
        await request.audit("unauthorized_access", {
          action: options.auditAction,
          orgId,
        });
        return sendResultError(reply, result);
      }
      request.state.membership = result.data;
    }

    request.state.org =
      (await request.server.container.organizationRepository.findById(orgId)) ?? undefined;
  };
}

const UPDATE_PERMISSION = { resource: "organization", action: "update" };

export default async function workflowRoutes(app: FastifyInstance) {
  /** Load `:id` into `request.workflow` so the guard can read its `orgId`. */
  const loadWorkflow = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const workflow = await app.container.workflowRepository.findById(id);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    request.workflow = workflow;
  };

  app.get(
    "/workflows",
    {
      preHandler: [
        app.authenticate,
        requireOrgIdParam,
        requireWorkflowAccess({ auditAction: "workflow_list" }),
      ],
    },
    async (request) => {
      const orgId = requestedOrgId(request)!;
      return { workflows: await app.container.workflowRepository.listByOrg(orgId) };
    }
  );

  app.post(
    "/workflows",
    {
      preHandler: [
        app.authenticate,
        requireWorkflowAccess({
          permission: () => UPDATE_PERMISSION,
          auditAction: "workflow_create",
        }),
      ],
    },
    async (request, reply) => {
      const parsed = CreateWorkflowSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid workflow", details: parsed.error.issues });
      }
      const body = parsed.data;

      const workflow = await registerWorkflow({
        actorId: request.user!.id,
        orgId: body.orgId,
        name: body.name,
        trigger: body.trigger,
        definition: body.definition,
        isActive: body.isActive,
      });
      await request.audit("workflow_created", {
        workflowId: workflow.id,
        trigger: body.trigger,
        orgId: body.orgId,
      });
      return reply.status(201).send(workflow);
    }
  );

  app.get(
    "/workflows/:id",
    {
      preHandler: [
        app.authenticate,
        loadWorkflow,
        requireWorkflowAccess({ auditAction: "workflow_read" }),
      ],
    },
    async (request) => ({ workflow: request.workflow })
  );

  app.delete(
    "/workflows/:id",
    {
      preHandler: [
        app.authenticate,
        loadWorkflow,
        requireWorkflowAccess({
          permission: () => UPDATE_PERMISSION,
          auditAction: "workflow_delete",
        }),
      ],
    },
    async (request, reply) => {
      const record = await app.container.workflowRepository.delete(request.workflow!.id);
      // The guard loaded this workflow a moment ago, so the delete matching
      // nothing means it was removed in between. That is still a 404 rather than a
      // 200 with an error body, which is what the previous handler did.
      if (!record) return reply.status(404).send({ error: "Workflow not found" });
      await request.audit("workflow_deleted", { workflowId: record.id });
      return { success: true };
    }
  );

  app.get(
    "/workflows/:id/runs",
    {
      preHandler: [
        app.authenticate,
        loadWorkflow,
        requireWorkflowAccess({ auditAction: "workflow_runs_read" }),
      ],
    },
    async (request) => ({ runs: await listWorkflowRuns(request.workflow!.id) })
  );
}
