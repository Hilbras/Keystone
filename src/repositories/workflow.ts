import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, type Workflow } from "../db/schema.js";
import type { WorkflowRepository } from "./types.js";

/**
 * Data access for workflows, which until now happened inside the route file.
 *
 * `src/routes/workflows.ts` imported `db` and `drizzle-orm` and wrote its own
 * queries in five handlers. That is a layering violation on its own terms — routes
 * are supposed to parse, delegate and respond — and it is the reason a sixth route
 * would be dangerous: authorization and tenancy were hand-written per handler, five
 * times, and a new handler would have had to reproduce both correctly.
 *
 * Nothing here enforces anything. The tenancy check is the route guard's job, and
 * `findById` deliberately does not take an `orgId` to filter on: the guard has
 * already established which organization the caller may act on, and a second
 * filter would be a second place for the rule to be wrong.
 */
export class DrizzleWorkflowRepository implements WorkflowRepository {
  async listByOrg(orgId: string): Promise<Workflow[]> {
    return db.select().from(workflows).where(eq(workflows.orgId, orgId));
  }

  async findById(id: string): Promise<Workflow | undefined> {
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    return workflow;
  }

  async delete(id: string): Promise<Workflow | undefined> {
    const [deleted] = await db.delete(workflows).where(eq(workflows.id, id)).returning();
    return deleted;
  }
}
