import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { OrganizationParamsSchema, requireOrganizationRole } from "./helpers.js";
import { getBillingSummary, setOrganizationPlan, provisionBillingCustomer, listPlans } from "../../services/billing.js";

const UpdatePlanSchema = z.object({
  plan: z.enum(["free", "starter", "growth", "enterprise"]),
});

export default async function billingRoutes(app: FastifyInstance) {
  app.get("/billing/plans", { preHandler: [app.authenticate] }, async () => {
    return { plans: listPlans() };
  });

  app.get(
    "/organizations/:id/billing",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "billing", action: "read" })] },
    async (request) => {
      const { id } = OrganizationParamsSchema.parse(request.params);
      const summary = await getBillingSummary(id);
      return summary;
    }
  );

  app.patch(
    "/organizations/:id/plan",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "billing", action: "update" })] },
    async (request) => {
      const { id } = OrganizationParamsSchema.parse(request.params);
      const body = UpdatePlanSchema.parse(request.body);
      const result = await setOrganizationPlan(id, body.plan);
      await request.audit("organization_plan_updated", { orgId: id, plan: body.plan });
      return result;
    }
  );

  app.post(
    "/organizations/:id/billing/customer",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "billing", action: "update" })] },
    async (request, reply) => {
      const { id } = OrganizationParamsSchema.parse(request.params);
      const user = request.user!;
      const result = await provisionBillingCustomer(id, user.email!);
      const success = result.ok !== false;
      await request.audit("billing_customer_provisioned", {
        orgId: id,
        success,
        ...(success ? {} : { reason: result.reason }),
      });
      if (!success) {
        return reply.status(503).send(result);
      }
      return reply.status(201).send(result);
    }
  );
}
