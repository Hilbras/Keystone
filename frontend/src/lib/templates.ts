export interface ApplicationTemplate {
  id: string;
  name: string;
  description: string;
  redirectUris: string[];
  allowedOrigins: string[];
}

export const APPLICATION_TEMPLATES: ApplicationTemplate[] = [
  {
    id: "spa",
    name: "Single-page app (React/Vue/Angular)",
    description: "A browser app running on one origin.",
    redirectUris: ["http://localhost:5173/callback", "http://localhost:3000/callback"],
    allowedOrigins: ["http://localhost:5173", "http://localhost:3000"],
  },
  {
    id: "ssr",
    name: "Server-rendered app (Next.js/Nuxt)",
    description: "A full-stack app where the server can keep secrets.",
    redirectUris: ["http://localhost:3000/api/auth/callback"],
    allowedOrigins: ["http://localhost:3000"],
  },
  {
    id: "mobile",
    name: "Mobile app",
    description: "iOS or Android app using a custom URL scheme.",
    redirectUris: ["com.yourapp://callback"],
    allowedOrigins: [],
  },
  {
    id: "m2m",
    name: "Machine-to-machine API",
    description: "Backend service that calls Keystone APIs.",
    redirectUris: [],
    allowedOrigins: [],
  },
];

export interface IdentityProviderPreset {
  type: string;
  name: string;
  docsUrl: string;
  callbackPath: string;
  fields: Array<{ key: string; label: string; type: "text" | "password" }>;
}

export const IDENTITY_PROVIDER_PRESETS: IdentityProviderPreset[] = [
  {
    type: "google",
    name: "Google",
    docsUrl: "https://developers.google.com/identity/protocols/oauth2",
    callbackPath: "/auth/callback/google",
    fields: [
      { key: "GOOGLE_CLIENT_ID", label: "Client ID", type: "text" },
      { key: "GOOGLE_CLIENT_SECRET", label: "Client Secret", type: "password" },
    ],
  },
  {
    type: "github",
    name: "GitHub",
    docsUrl: "https://docs.github.com/en/developers/apps/building-oauth-apps",
    callbackPath: "/auth/callback/github",
    fields: [
      { key: "GITHUB_CLIENT_ID", label: "Client ID", type: "text" },
      { key: "GITHUB_CLIENT_SECRET", label: "Client Secret", type: "password" },
    ],
  },
  {
    type: "microsoft",
    name: "Microsoft / Azure AD",
    docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc",
    callbackPath: "/auth/callback/azure",
    fields: [
      { key: "AZURE_CLIENT_ID", label: "Client ID", type: "text" },
      { key: "AZURE_CLIENT_SECRET", label: "Client Secret", type: "password" },
    ],
  },
];

export interface RoleTemplate {
  name: string;
  description: string;
  permissions: string[];
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { name: "Admin", description: "Full platform access", permissions: ["*"] },
  { name: "Editor", description: "Read and write most resources", permissions: ["read:*", "write:users", "write:applications"] },
  { name: "Viewer", description: "Read-only access", permissions: ["read:*"] },
  { name: "Member", description: "Default user permissions", permissions: ["read:profile", "write:profile"] },
];
