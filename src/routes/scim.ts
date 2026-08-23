import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, organizations } from "../db/schema.js";
import { slugifyUsername, ensureUniqueUsername } from "../services/users.js";

const ScimUserSchema = z.object({
  userName: z.string().email(),
  name: z.object({ givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  emails: z.array(z.object({ value: z.string().email(), primary: z.boolean().optional() })).optional(),
  active: z.boolean().optional(),
});

function scimUserResponse(user: typeof users.$inferSelect): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    userName: user.email,
    name: {
      givenName: user.name?.split(" ")[0] || "",
      familyName: user.name?.split(" ").slice(1).join(" ") || "",
    },
    emails: [{ value: user.email, primary: true }],
    active: true,
    meta: {
      resourceType: "User",
    },
  };
}

function scimError(status: number, detail: string): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
}

export default async function scimRoutes(app: FastifyInstance) {
  // Simple bearer-token auth: validate SCIM_BEARER_TOKEN env var.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    const expected = process.env.SCIM_BEARER_TOKEN;
    if (!expected) {
      return reply.status(501).send(scimError(501, "SCIM not configured"));
    }
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== expected) {
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }
  });

  app.get("/scim/v2/Users", async () => {
    const allUsers = await db.select().from(users);
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: allUsers.length,
      Resources: allUsers.map(scimUserResponse),
    };
  });

  app.get("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      return reply.status(404).send(scimError(404, "User not found"));
    }
    return scimUserResponse(user);
  });

  app.post("/scim/v2/Users", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ScimUserSchema.parse(request.body);
    const email = body.userName.toLowerCase().trim();

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      const username = await ensureUniqueUsername(slugifyUsername(email.split("@")[0]));
      [user] = await db
        .insert(users)
        .values({
          email,
          username,
          name: body.name ? `${body.name.givenName || ""} ${body.name.familyName || ""}`.trim() || username : username,
          provider: "scim",
          emailVerified: true,
        })
        .returning();
    }

    return reply.status(201).send(scimUserResponse(user));
  });

  app.put("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const body = ScimUserSchema.parse(request.body);

    const [updated] = await db
      .update(users)
      .set({
        email: body.userName.toLowerCase().trim(),
        name: body.name
          ? `${body.name.givenName || ""} ${body.name.familyName || ""}`.trim()
          : undefined,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      return reply.status(404).send(scimError(404, "User not found"));
    }
    return scimUserResponse(updated);
  });

  app.delete("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    await db.delete(users).where(eq(users.id, userId));
    return reply.status(204).send();
  });

  app.get("/scim/v2/Groups", async () => ({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 0,
    Resources: [],
  }));
}
