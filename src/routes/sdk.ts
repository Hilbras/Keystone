import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { createApplication, findApplicationByClientId } from "../services/applications.js";
import { findOrganizationBySlug, findOrganizationById } from "../services/organizations.js";
import { getSdk } from "../sdk/index.js";
import { requirePlatformRole } from "./admin/helpers.js";

const gzipAsync = promisify(gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_FILE = path.resolve(__dirname, "../../packages/keystone-sdk/dist/keystone-dropin.js");

const ConnectSchema = z.object({
  projectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  redirectUri: z.string().url().optional(),
  clientId: z.string().optional(),
});

export default async function sdkRoutes(app: FastifyInstance) {
  const sdk = getSdk();
  // Serve the drop-in SDK so external projects can load it with one script tag.
  app.get("/keystone-dropin.js", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const content = await fs.readFile(SDK_FILE, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("base64");
      const etag = `"${hash}"`;
      const ifNoneMatch = request.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        return reply.status(304).send();
      }

      const acceptEncoding = request.headers["accept-encoding"] || "";
      const useGzip = acceptEncoding.includes("gzip");
      const body = useGzip ? await gzipAsync(content) : content;

      reply
        .header("Content-Type", "application/javascript; charset=utf-8")
        .header("Cache-Control", "public, max-age=86400, immutable")
        .header("ETag", etag);
      if (useGzip) reply.header("Content-Encoding", "gzip");
      return reply.send(body);
    } catch (err) {
      app.log.error({ err }, "SDK file not found");
      return reply.status(404).send({ error: "SDK not built. Run npm run build:sdk first." });
    }
  });

  // SRI hash for the drop-in SDK so consumers can use integrity="sha256-…".
  app.get("/keystone-dropin.js.sri", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const content = await fs.readFile(SDK_FILE, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("base64");
      reply.header("Cache-Control", "public, max-age=86400, immutable");
      return { integrity: `sha256-${hash}` };
    } catch (err) {
      app.log.error({ err }, "SDK file not found");
      return reply.status(404).send({ error: "SDK not built. Run npm run build:sdk first." });
    }
  });

  // Public branding lookup for hosted login pages and the drop-in SDK.
  // Returns only display-safe fields — never secrets.
  app.get("/branding/:clientId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { clientId } = request.params as { clientId: string };
    const application = await findApplicationByClientId(clientId);
    if (!application) {
      return reply.status(404).send({ error: "Application not found" });
    }
    const org = await findOrganizationById(application.orgId);

    type Branding = Record<string, unknown>;
    const orgBranding = (org?.branding ?? {}) as Branding;
    const appBranding = (application.branding ?? {}) as Branding;
    // App-level branding wins over org-level defaults.
    const merged: Branding = { ...orgBranding, ...appBranding };
    const pick = (key: string) => (typeof merged[key] === "string" ? merged[key] : undefined);

    reply.header("Cache-Control", "public, max-age=300");
    return {
      name: pick("companyName") ?? application.name,
      logoUrl: pick("logoUrl"),
      primaryColor: pick("primaryColor"),
      accentColor: pick("accentColor"),
      supportEmail: pick("supportEmail"),
      loginTitle: pick("loginTitle"),
      loginSubtitle: pick("loginSubtitle"),
    };
  });

  // Register or connect an external project/application.
  app.post("/connect", { preHandler: [requirePlatformRole("owner")] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = ConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.issues });
    }

    const { projectId, redirectUri, clientId } = parsed.data;

    try {
      // If clientId is provided, verify the application exists.
      if (clientId) {
        const existing = await findApplicationByClientId(clientId);
        if (!existing) {
          return reply.status(404).send({ error: "Application not found" });
        }
        return reply.send({
          connected: true,
          clientId: existing.clientId,
          message: "Connected to existing application",
        });
      }

      // Create a new client application for a project. The route is platform-owner protected.
      let defaultOrg = await findOrganizationBySlug("external-projects");
      if (!defaultOrg) {
        const created = await sdk.organization.createOrganization(request.user!.id, {
          name: "External Projects",
          slug: "external-projects",
        });
        if (!created.success) throw new Error(created.error.message);
        defaultOrg = created.data;
      } else {
        const membership = await request.server.container.organizationRepository.findMembership(defaultOrg.id, request.user!.id);
        if (!membership) {
          const invited = await sdk.organization.inviteMember(
            request.user!.id,
            defaultOrg.id,
            { email: request.user!.email, role: "owner" },
            { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"] }
          );
          if (!invited.success) throw new Error(invited.error.message);
        }
      }

      const createdApp = await createApplication({
        orgId: defaultOrg.id,
        name: projectId,
        clientId: projectId,
        redirectUris: redirectUri ? [redirectUri] : [],
        allowedOrigins: [request.headers.origin || "*"].filter(Boolean),
      });

      return reply.status(201).send({
        connected: true,
        clientId: createdApp.clientId,
        clientSecret: createdApp.clientSecret,
        message: "Application connected to Keystone",
      });
    } catch (err) {
      request.log.error({ err }, "SDK connect failed");
      return reply.status(500).send({ error: "Connection failed" });
    }
  });
}
