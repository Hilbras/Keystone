import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireAuthAndRole } from "./helpers.js";
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
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "billing", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const summary = await getBillingSummary(id);
      return summary;
    }
  );

  app.patch(
    "/organizations/:id/plan",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "billing", action: "update" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = UpdatePlanSchema.parse(request.body);
      const result = await setOrganizationPlan(id, body.plan);
      await request.audit("organization_plan_updated", { orgId: id, plan: body.plan });
      return result;
    }
  );

  app.post(
    "/organizations/:id/billing/customer",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "billing", action: "update" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const result = await provisionBillingCustomer(id, user.email!);
      await request.audit("billing_customer_provisioned", { orgId: id });
      return reply.status(201).send(result);
    }
  );
}
