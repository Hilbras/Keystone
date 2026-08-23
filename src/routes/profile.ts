import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { toPublicUser } from "../types.js";

const UpdateProfileSchema = z.object({
  name: z.string().max(255).optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  phoneNumber: z.string().max(32).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export default async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return reply.status(404).send({ error: "User not found" });

    return { user: toPublicUser(user) };
  });

  app.patch("/profile", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const body = UpdateProfileSchema.parse(request.body);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
    if (body.metadata !== undefined) updates.metadata = body.metadata;
    // Changing the phone number resets its verification status.
    if (body.phoneNumber !== undefined) {
      updates.phoneNumber = body.phoneNumber;
      updates.phoneVerified = false;
    }

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning();

    if (!updated) return reply.status(404).send({ error: "User not found" });

    await request.audit("profile_updated", { userId });
    return { user: toPublicUser(updated) };
  });
}
