import { memo, useMemo, useState } from "react";
import {
  Code2,
  Copy,
  Check,
  Info,
  Rocket,
  Shield,
  Globe,
  ArrowRight,
  LayoutTemplate,
  FileCode,
  Braces,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Input } from "./ui/Input.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { Select } from "./ui/Select.tsx";
import { PageHeader } from "./ui/PageHeader.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { Tabs } from "./ui/Tabs.tsx";
import { CodeBlock } from "./ui/CodeBlock.tsx";
import { Advanced } from "./ui/Advanced.tsx";
import { useUiMode } from "../hooks/useUiMode.ts";
import type { DataTabState } from "../Dashboard.tsx";

interface ConnectProjectPanelProps {
  applicationsState: DataTabState<{ applications: unknown[] }>;
  configState: DataTabState<{ values: Record<string, string> }>;
}

interface Application {
  id: string;
  clientId: string;
  name: string;
  orgId: string;
  isActive: boolean;
  allowedOrigins?: string[];
  redirectUris?: string[];
}

type Framework = "html" | "react" | "vue" | "nextjs" | "angular" | "svelte" | "django" | "rails" | "go";
type CodeTab = Framework;

function ConnectProjectPanelBase({ applicationsState, configState }: ConnectProjectPanelProps) {
  const { mode } = useUiMode();
  const [selectedAppId, setSelectedAppId] = useState("");
  const [projectUrl, setProjectUrl] = useState("http://localhost:3000");
  const [callbackPath, setCallbackPath] = useState("/callback.html");
  const [activeTab, setActiveTab] = useState<CodeTab>("html");
  const [framework, setFramework] = useState<Framework>("html");
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);

  const apps = (applicationsState.data?.applications ?? []) as Application[];
  const selectedApp = apps.find((a) => a.id === selectedAppId);

  const keystoneUrl = useMemo(() => {
    const publicUrl = configState.data?.values?.AUTH_API_PUBLIC_URL;
    if (publicUrl) return publicUrl.replace(/\/$/, "");
    if (typeof window !== "undefined") {
      return `${window.location.protocol}//${window.location.host}`;
    }
    return "http://localhost:4001";
  }, [configState.data]);

  const callbackUrl = useMemo(() => {
    const base = projectUrl.replace(/\/$/, "");
    const path = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
    return `${base}${path}`;
  }, [projectUrl, callbackPath]);

  const callbackOk = useMemo(() => {
    if (!selectedApp?.redirectUris?.length) return true;
    return selectedApp.redirectUris.includes(callbackUrl);
  }, [selectedApp, callbackUrl]);

  const originOk = useMemo(() => {
    if (!selectedApp?.allowedOrigins?.length) return true;
    try {
      return selectedApp.allowedOrigins.includes(new URL(projectUrl).origin);
    } catch {
      return false;
    }
  }, [selectedApp, projectUrl]);

  const embedCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect script -->";
    }
    return `<script src="${keystoneUrl}/sdk/keystone-dropin.js"
        data-keystone-url="${keystoneUrl}"
        data-keystone-client-id="${selectedApp.clientId}"
        data-keystone-callback="${callbackUrl}"
        data-keystone-autowire="true"
        data-keystone-check-session="true"></script>`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const reactCode = useMemo(() => {
    if (!selectedApp) {
      return "// Select an application to generate the connect code";
    }
    return `// Add this to the <head> of your root HTML file
<script src="${keystoneUrl}/sdk/keystone-dropin.js"
  data-keystone-url="${keystoneUrl}"
  data-keystone-client-id="${selectedApp.clientId}"
  data-keystone-callback="${callbackUrl}"
  data-keystone-autowire="true"
  data-keystone-check-session="true"></script>

// Then use these IDs in any React component
export default function AuthPage() {
  return (
    <div>
      <form id="keystone-login-form">
        <input data-keystone-input="email" type="email" />
        <input data-keystone-input="password" type="password" />
        <button type="submit">Sign in</button>
      </form>
      <button id="keystone-google-btn">Continue with Google</button>
      <button id="keystone-logout">Sign out</button>
    </div>
  );
}`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const vueCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect code -->";
    }
    return `<template>
  <div>
    <form id="keystone-login-form">
      <input data-keystone-input="email" type="email" />
      <input data-keystone-input="password" type="password" />
      <button type="submit">Sign in</button>
    </form>
    <button id="keystone-google-btn">Continue with Google</button>
    <button id="keystone-logout">Sign out</button>
  </div>
</template>

<script setup>
// No imports needed. The global SDK is loaded from index.html:
// <script src="${keystoneUrl}/sdk/keystone-dropin.js"
//   data-keystone-client-id="${selectedApp.clientId}"
//   data-keystone-callback="${callbackUrl}"><\/script>
<\/script>`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const nextjsCode = useMemo(() => {
    if (!selectedApp) {
      return "// Select an application to generate the connect code";
    }
    return `// app/layout.tsx (App Router) or pages/_document.tsx (Pages Router)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          src="${keystoneUrl}/sdk/keystone-dropin.js"
          data-keystone-url="${keystoneUrl}"
          data-keystone-client-id="${selectedApp.clientId}"
          data-keystone-callback="${callbackUrl}"
          data-keystone-autowire="true"
          data-keystone-check-session="true"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

// Use these IDs in any page or component
export default function LoginPage() {
  return (
    <div>
      <form id="keystone-login-form">
        <input data-keystone-input="email" type="email" />
        <input data-keystone-input="password" type="password" />
        <button type="submit">Sign in</button>
      </form>
      <button id="keystone-google-btn">Continue with Google</button>
      <button id="keystone-logout">Sign out</button>
    </div>
  );
}`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const angularCode = useMemo(() => {
    if (!selectedApp) {
      return "// Select an application to generate the connect code";
    }
    return `// Load the SDK in src/index.html, inside <head>
<script src="${keystoneUrl}/sdk/keystone-dropin.js"
  data-keystone-url="${keystoneUrl}"
  data-keystone-client-id="${selectedApp.clientId}"
  data-keystone-callback="${callbackUrl}"
  data-keystone-autowire="true"
  data-keystone-check-session="true"><\/script>

// src/app/login/login.component.ts
import { Component } from "@angular/core";

@Component({
  selector: "app-login",
  template: \`
    <form id="keystone-login-form">
      <input data-keystone-input="email" type="email" />
      <input data-keystone-input="password" type="password" />
      <button type="submit">Sign in</button>
    </form>
    <button id="keystone-google-btn">Continue with Google</button>
    <button id="keystone-logout">Sign out</button>
  \`,
})
export class LoginComponent {}`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const svelteCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect code -->";
    }
    return `<!-- src/routes/+page.svelte (or any component) -->
<form id="keystone-login-form">
  <input data-keystone-input="email" type="email" />
  <input data-keystone-input="password" type="password" />
  <button type="submit">Sign in</button>
</form>
<button id="keystone-google-btn">Continue with Google</button>
<button id="keystone-logout">Sign out</button>

<!-- Load the SDK in src/app.html or src/routes/+layout.svelte -->
<svelte:head>
  <script src="${keystoneUrl}/sdk/keystone-dropin.js"
    data-keystone-url="${keystoneUrl}"
    data-keystone-client-id="${selectedApp.clientId}"
    data-keystone-callback="${callbackUrl}"
    data-keystone-autowire="true"
    data-keystone-check-session="true"><\/script>
</svelte:head>`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const djangoCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect code -->";
    }
    return `<!-- templates/base.html -->
<!DOCTYPE html>
<html>
<head>
  <script src="${keystoneUrl}/sdk/keystone-dropin.js"
    data-keystone-url="${keystoneUrl}"
    data-keystone-client-id="${selectedApp.clientId}"
    data-keystone-callback="${callbackUrl}"
    data-keystone-autowire="true"
    data-keystone-check-session="true"></script>
</head>
<body>
  <form id="keystone-login-form">
    <input data-keystone-input="email" type="email" />
    <input data-keystone-input="password" type="password" />
    <button type="submit">Sign in</button>
  </form>
  <button id="keystone-google-btn">Continue with Google</button>
  <button id="keystone-logout">Sign out</button>
</body>
</html>`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const railsCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect code -->";
    }
    return `<!-- app/views/layouts/application.html.erb -->
<!DOCTYPE html>
<html>
  <head>
    <script src="${keystoneUrl}/sdk/keystone-dropin.js"
      data-keystone-url="${keystoneUrl}"
      data-keystone-client-id="${selectedApp.clientId}"
      data-keystone-callback="${callbackUrl}"
      data-keystone-autowire="true"
      data-keystone-check-session="true"></script>
  </head>
  <body>
    <%= yield %>
  </body>
</html>

<!-- app/views/sessions/new.html.erb -->
<form id="keystone-login-form">
  <input data-keystone-input="email" type="email" />
  <input data-keystone-input="password" type="password" />
  <button type="submit">Sign in</button>
</form>
<button id="keystone-google-btn">Continue with Google</button>
<button id="keystone-logout">Sign out</button>`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const goCode = useMemo(() => {
    if (!selectedApp) {
      return "<!-- Select an application to generate the connect code -->";
    }
    return `<!-- templates/base.html (loaded with html/template) -->
<!DOCTYPE html>
<html>
<head>
  <script src="${keystoneUrl}/sdk/keystone-dropin.js"
    data-keystone-url="${keystoneUrl}"
    data-keystone-client-id="${selectedApp.clientId}"
    data-keystone-callback="${callbackUrl}"
    data-keystone-autowire="true"
    data-keystone-check-session="true"></script>
</head>
<body>
  {{ template "content" . }}
</body>
</html>

<!-- templates/login.html -->
{{ define "content" }}
<form id="keystone-login-form">
  <input data-keystone-input="email" type="email" />
  <input data-keystone-input="password" type="password" />
  <button type="submit">Sign in</button>
</form>
<button id="keystone-google-btn">Continue with Google</button>
<button id="keystone-logout">Sign out</button>
{{ end }}`;
  }, [selectedApp, keystoneUrl, callbackUrl]);

  const codeExamples = {
    html: embedCode,
    react: reactCode,
    vue: vueCode,
    nextjs: nextjsCode,
    angular: angularCode,
    svelte: svelteCode,
    django: djangoCode,
    rails: railsCode,
    go: goCode,
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeExamples[activeTab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const tabs = [
    { id: "html" as const, label: "HTML", icon: <FileCode className="w-3.5 h-3.5" /> },
    { id: "react" as const, label: "React", icon: <Code2 className="w-3.5 h-3.5" /> },
    { id: "vue" as const, label: "Vue", icon: <LayoutTemplate className="w-3.5 h-3.5" /> },
    { id: "nextjs" as const, label: "Next.js", icon: <Rocket className="w-3.5 h-3.5" /> },
    { id: "angular" as const, label: "Angular", icon: <LayoutTemplate className="w-3.5 h-3.5" /> },
    { id: "svelte" as const, label: "Svelte", icon: <Code2 className="w-3.5 h-3.5" /> },
    { id: "django" as const, label: "Django", icon: <Globe className="w-3.5 h-3.5" /> },
    { id: "rails" as const, label: "Rails", icon: <Globe className="w-3.5 h-3.5" /> },
    { id: "go" as const, label: "Go", icon: <Braces className="w-3.5 h-3.5" /> },
  ];

  const requirements = [
    { label: "Application selected", ok: Boolean(selectedApp) },
    { label: "Callback URL in Redirect URIs", ok: callbackOk },
    { label: "Project origin in Allowed Origins", ok: originOk },
    { label: "Application is active", ok: selectedApp?.isActive ?? false },
  ];

  const simpleCode = codeExamples[framework];

  const openTestLogin = () => {
    if (!selectedApp) return;
    const url = `${keystoneUrl}/sdk/test-login?client_id=${encodeURIComponent(selectedApp.clientId)}&callback=${encodeURIComponent(callbackUrl)}`;
    window.open(url, "keystone-test", "width=480,height=640");
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connect a Project"
        description="Generate a drop-in auth script and wire Keystone into any website or app in minutes."
      />

      {mode === "simple" && (
        <SectionCard
          title="Quick install"
          description="Choose your framework, pick an app, and copy one snippet."
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <FieldHelp
              label="Framework"
              help="The frontend framework or server-side stack your project uses. Keystone generates the matching install snippet."
              example="React"
            >
              <Select value={framework} onChange={(e) => setFramework(e.target.value as Framework)}>
                <option value="html">HTML / Vanilla JS</option>
                <option value="react">React</option>
                <option value="vue">Vue</option>
                <option value="nextjs">Next.js</option>
                <option value="angular">Angular</option>
                <option value="svelte">Svelte / SvelteKit</option>
                <option value="django">Django</option>
                <option value="rails">Ruby on Rails</option>
                <option value="go">Go templates</option>
              </Select>
            </FieldHelp>
            <FieldHelp
              label="Application"
              help="The Keystone application (client) that represents this project. The snippet will use this app's public client ID."
              example="My Website"
            >
              <Select value={selectedAppId} onChange={(e) => setSelectedAppId(e.target.value)}>
                <option value="">Select an application</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </Select>
            </FieldHelp>
            <FieldHelp
              label="Website URL"
              help="The public URL where your project is hosted. Keystone uses this to validate the origin and build the callback URL."
              example="http://localhost:3000"
            >
              <Input value={projectUrl} onChange={(e) => setProjectUrl(e.target.value)} placeholder="http://localhost:3000" />
            </FieldHelp>
          </div>

          <CodeBlock code={simpleCode} language={framework} showLineNumbers />

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Button size="sm" variant="secondary" onClick={handleCopy} disabled={!selectedApp}>
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied" : "Copy snippet"}
            </Button>
            <Button size="sm" onClick={openTestLogin} disabled={!selectedApp}>
              Test login
            </Button>
          </div>

          <div className="mt-5 p-4 rounded-xl bg-surface border border-theme/20">
            <h4 className="text-[13px] font-semibold txt-head mb-2 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-gold" />
              Show the signed-in user
            </h4>
            <p className="text-[12px] txt-muted mb-3">
              Once a user is signed in, the SDK can automatically fill profile fields anywhere on the page. Add these attributes to any element:
            </p>
            <div className="space-y-2 mb-3">
              {[
                { attr: 'data-keystone-field="email"', desc: "User's email address" },
                { attr: 'data-keystone-field="name"', desc: "Display name (falls back to username)" },
                { attr: 'data-keystone-field="username"', desc: "Username" },
              ].map((item) => (
                <div key={item.attr} className="flex items-start gap-3 text-[12px]">
                  <code className="text-gold font-mono shrink-0">{item.attr}</code>
                  <span className="txt-muted">{item.desc}</span>
                </div>
              ))}
            </div>
            <CodeBlock
              code={`<div class="user-profile">
  <p>Welcome, <span data-keystone-field="name">Guest</span>!</p>
  <p>Email: <span data-keystone-field="email">-</span></p>
</div>`}
              language="html"
            />
            <p className="text-[11px] txt-muted mt-3">
              For custom code, listen for the <code className="text-gold">keystone:session</code> event or call <code className="text-gold">keystone.getUser()</code>.
            </p>
          </div>

          {!selectedApp && apps.length === 0 && (
            <Alert variant="info" className="mt-4 text-[12px]">
              Create an application first in the Applications section.
            </Alert>
          )}
        </SectionCard>
      )}

      <Advanced mode={mode}>
      {/* Configuration */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Rocket className="w-4 h-4 text-gold" />
            1. Configure integration
          </span>
        }
        description="Pick the application and tell us where it will be hosted."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FieldHelp
                label="Application"
                help="The Keystone application (OAuth client) that represents this project. The generated snippet will use this app's public client ID."
                example="My Website"
              >
                <Select value={selectedAppId} onChange={(e) => setSelectedAppId(e.target.value)}>
                  <option value="">Select an application</option>
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name} ({app.clientId})
                    </option>
                  ))}
                </Select>
                {applicationsState.loading && (
                  <p className="text-[11px] txt-muted mt-1">Loading applications…</p>
                )}
              </FieldHelp>

              <FieldHelp
                label="Project URL"
                help="The public URL where your project is hosted. Keystone validates this origin for CORS and builds the full callback URL from it."
                example="http://localhost:3000"
              >
                <Input
                  value={projectUrl}
                  onChange={(e) => setProjectUrl(e.target.value)}
                  placeholder="http://localhost:3000"
                />
              </FieldHelp>

              <FieldHelp
                label="Callback path"
                help="The path on your site where users are sent after signing in with an external provider (Google, etc.). The full URL is Project URL + this path and must be listed in the app's Redirect URIs."
                example="/callback.html"
              >
                <Input
                  value={callbackPath}
                  onChange={(e) => setCallbackPath(e.target.value)}
                  placeholder="/callback.html"
                />
              </FieldHelp>

              <div className="flex flex-col justify-end">
                <div className="text-[12px] space-y-1">
                  <div className="flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-gold" />
                    <span className="txt-muted">Keystone URL:</span>
                    <code className="text-gold font-medium">{keystoneUrl}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-gold" />
                    <span className="txt-muted">Callback URL:</span>
                    <code className="text-gold font-medium">{callbackUrl}</code>
                  </div>
                </div>
              </div>
            </div>

            {selectedApp && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Badge variant={selectedApp.isActive ? "success" : "warning"}>
                  {selectedApp.isActive ? "Active" : "Inactive"}
                </Badge>
                <Badge variant="default">{selectedApp.clientId}</Badge>
                {!callbackOk && (
                  <Badge variant="danger">Callback URL not in Redirect URIs</Badge>
                )}
                {!originOk && (
                  <Badge variant="danger">Origin not in Allowed Origins</Badge>
                )}
              </div>
            )}
          </div>

          <div className="bg-surface border border-theme/20 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 txt-head text-[13px] font-semibold">
              <Shield className="w-4 h-4 text-gold" />
              Requirements
            </div>
            <div className="space-y-2">
              {requirements.map((req) => (
                <div key={req.label} className="flex items-center gap-2 text-[12px]">
                  {req.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-zinc-400 shrink-0" />
                  )}
                  <span className={req.ok ? "txt-body" : "txt-muted"}>{req.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Generated code */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Braces className="w-4 h-4 text-gold" />
            2. Add the code
          </span>
        }
        description="Copy the snippet for your framework and paste it into your project."
      >
        {selectedApp && !selectedApp.isActive && (
          <Alert variant="error" className="mb-4">
            This application is disabled. Enable it before using it in production.
          </Alert>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as CodeTab)} />
          <Button size="sm" variant="secondary" onClick={handleCopy} disabled={!selectedApp}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? "Copied" : "Copy snippet"}
          </Button>
        </div>

        <CodeBlock
          code={codeExamples[activeTab]}
          language={activeTab}
          showLineNumbers
          className="mb-5"
        />

        <Alert variant="info" className="text-[12px]">
          Make sure your project URL is in the application&apos;s <strong>Allowed Origins</strong> and the callback URL is in{" "}
          <strong>Redirect URIs</strong>.{" "}
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="inline-flex items-center gap-1 underline hover:text-gold"
          >
            Learn more <ExternalLink className="w-3 h-3" />
          </a>
        </Alert>
      </SectionCard>
      </Advanced>

      {/* Live preview */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-gold" />
            3. Live preview
          </span>
        }
        description="This is what your users will see once the SDK is wired."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Card className="p-5 bg-surface border border-theme/20">
            <div className="space-y-3">
              <div className="text-center mb-4">
                <h4 className="text-[14px] font-semibold txt-head">Sign in to {selectedApp?.name ?? "your app"}</h4>
                <p className="text-[11px] txt-muted">Powered by Keystone</p>
              </div>
              <form className="space-y-2">
                <input
                  type="email"
                  placeholder="Email"
                  className="w-full px-3 py-2 rounded-lg bg-input border border-theme/30 text-[12px] outline-none"
                  readOnly
                />
                <input
                  type="password"
                  placeholder="Password"
                  className="w-full px-3 py-2 rounded-lg bg-input border border-theme/30 text-[12px] outline-none"
                  readOnly
                />
                <button
                  type="button"
                  className="w-full py-2 rounded-lg btn-gold text-white text-[12px] font-medium opacity-80"
                >
                  Sign in
                </button>
              </form>
              <button
                type="button"
                className="w-full py-2 rounded-lg border border-theme/30 bg-white text-[12px] font-medium flex items-center justify-center gap-2 opacity-80"
              >
                Continue with Google
              </button>
            </div>
          </Card>

          <div className="space-y-3">
            <p className="text-[13px] txt-body">
              The SDK automatically attaches to the form above because it uses the IDs and data attributes shown below.
              You do not need to write any JavaScript.
            </p>
            <div className="space-y-2">
              {[
                { id: "keystone-login-form", label: "Sign-in form" },
                { id: "keystone-register-form", label: "Sign-up form" },
                { id: "keystone-google-btn", label: "Google button" },
                { id: "keystone-logout", label: "Logout button" },
              ].map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-3 py-2 rounded-xl bg-surface border border-theme/20 text-[12px]"
                >
                  <code className="text-gold">#{item.id}</code>
                  <span className="txt-muted">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Integration flow */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Info className="w-4 h-4 text-gold" />
            How it works
          </span>
        }
        description="Three simple steps between your users and Keystone."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              step: "1",
              title: "User visits your project",
              desc: "The drop-in script loads from Keystone and scans the page for known IDs.",
              icon: <Globe className="w-5 h-5 text-gold" />,
            },
            {
              step: "2",
              title: "Keystone handles auth",
              desc: "Passwords, registration, and OAuth flows run through your Keystone instance.",
              icon: <Shield className="w-5 h-5 text-gold" />,
            },
            {
              step: "3",
              title: "Tokens are stored",
              desc: "Keystone returns a secure session cookie and updates the UI automatically.",
              icon: <Lock className="w-5 h-5 text-gold" />,
            },
          ].map((item, idx, arr) => (
            <div key={item.step} className="relative">
              <Card className="p-4 bg-surface border border-theme/20 h-full">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gold/10 flex items-center justify-center shrink-0">
                    {item.icon}
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold text-gold uppercase tracking-wide">Step {item.step}</p>
                    <h4 className="text-[14px] font-semibold txt-head mt-0.5">{item.title}</h4>
                    <p className="text-[12px] txt-muted mt-1 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              </Card>
              {idx < arr.length - 1 && (
                <div className="hidden md:flex absolute top-1/2 -right-2 transform -translate-y-1/2 translate-x-1/2 z-10">
                  <ChevronRight className="w-4 h-4 text-gold/50" />
                </div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Input reference */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Info className="w-4 h-4 text-gold" />
            Input & attribute reference
          </span>
        }
        description="Every field, ID, and data attribute the Keystone drop-in SDK recognizes."
      >
        <div className="space-y-6">
          {[
            {
              title: "Script configuration",
              icon: <Braces className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: "data-keystone-url",
                  description: "The base URL of your Keystone API. The SDK sends login, register, and OAuth requests here.",
                  example: "http://localhost:4001",
                },
                {
                  name: "data-keystone-client-id",
                  description: "The public client ID of your Keystone application. This is safe to expose in browser code.",
                  example: "app_abc123",
                },
                {
                  name: "data-keystone-callback",
                  description: "The callback path or full URL where OAuth providers send users back after sign-in. Must match your app's Redirect URIs.",
                  example: "/callback.html",
                },
                {
                  name: "data-keystone-project-id",
                  description: "Optional project identifier. When set, the SDK auto-connects your project to Keystone on load.",
                  example: "proj_123",
                },
                {
                  name: "data-keystone-after-login",
                  description: "Where to redirect the user after successful login or registration.",
                  example: "/dashboard",
                },
                {
                  name: "data-keystone-after-logout",
                  description: "Where to redirect the user after they sign out.",
                  example: "/",
                },
                {
                  name: "data-keystone-autowire",
                  description: "Whether the SDK should automatically find and wire forms and buttons. Set to false to attach manually via JavaScript.",
                  example: "false",
                },
                {
                  name: "data-keystone-check-session",
                  description: "When true, the SDK checks for an existing Keystone session on page load and fills user fields automatically.",
                  example: "true",
                },
              ],
            },
            {
              title: "Form IDs",
              icon: <LayoutTemplate className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: "#keystone-login-form",
                  description: "The sign-in form. The SDK listens for submit and reads email and password inputs inside it.",
                  example: '<form id="keystone-login-form">',
                },
                {
                  name: "#keystone-register-form",
                  description: "The sign-up form. The SDK listens for submit and reads username, email, and password inputs inside it.",
                  example: '<form id="keystone-register-form">',
                },
                {
                  name: "#keystone-google-btn",
                  description: "Button that starts Google OAuth sign-in. The SDK attaches a click handler that redirects to Keystone.",
                  example: '<button id="keystone-google-btn">',
                },
                {
                  name: "#keystone-logout",
                  description: "Button that signs the user out. The SDK attaches a click handler that calls logout and redirects.",
                  example: '<button id="keystone-logout">',
                },
                {
                  name: "#keystone-message",
                  description: "Optional element where the SDK displays error, success, and info messages.",
                  example: '<div id="keystone-message"></div>',
                },
              ],
            },
            {
              title: "Form input attributes",
              icon: <FileCode className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: 'data-keystone-input="email"',
                  description: "Marks an input as the user's email address. Required for login and registration.",
                  example: '<input data-keystone-input="email" type="email" />',
                },
                {
                  name: 'data-keystone-input="password"',
                  description: "Marks an input as the user's password. Required for login and registration.",
                  example: '<input data-keystone-input="password" type="password" />',
                },
                {
                  name: 'data-keystone-input="username"',
                  description: "Marks an input as the user's username. Required for registration.",
                  example: '<input data-keystone-input="username" type="text" />',
                },
                {
                  name: 'data-keystone-input="name"',
                  description: "Marks an input as the user's display name. Optional for registration.",
                  example: '<input data-keystone-input="name" type="text" />',
                },
              ],
            },
            {
              title: "Custom registration fields",
              icon: <Code2 className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: 'data-keystone-input="firstName"',
                  description: "Custom fields like firstName, lastName, company, or anything else are collected and stored in the user's metadata object.",
                  example: '<input data-keystone-input="firstName" type="text" />',
                },
                {
                  name: 'data-keystone-input="lastName"',
                  description: "Add any field name you need. The SDK automatically sends unknown fields as metadata to Keystone.",
                  example: '<input data-keystone-input="lastName" type="text" />',
                },
                {
                  name: "User metadata",
                  description: "All custom fields are stored in the user's metadata JSON object and returned by /auth/me and login/register responses.",
                  example: '{ "firstName": "John", "lastName": "Doe" }',
                },
              ],
            },
            {
              title: "User display attributes",
              icon: <CheckCircle2 className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: 'data-keystone-field="email"',
                  description: "Auto-fills the signed-in user's email address into this element.",
                  example: '<span data-keystone-field="email"></span>',
                },
                {
                  name: 'data-keystone-field="name"',
                  description: "Auto-fills the signed-in user's display name (or username) into this element.",
                  example: '<span data-keystone-field="name"></span>',
                },
                {
                  name: 'data-keystone-field="username"',
                  description: "Auto-fills the signed-in user's username into this element.",
                  example: '<span data-keystone-field="username"></span>',
                },
              ],
            },
            {
              title: "Alternative attributes",
              icon: <ArrowRight className="w-4 h-4 text-gold" />,
              items: [
                {
                  name: 'data-keystone-form="login"',
                  description: "Alternative to #keystone-login-form. Marks a form as the login form.",
                  example: '<form data-keystone-form="login">',
                },
                {
                  name: 'data-keystone-form="register"',
                  description: "Alternative to #keystone-register-form. Marks a form as the registration form.",
                  example: '<form data-keystone-form="register">',
                },
                {
                  name: 'data-keystone-google',
                  description: "Alternative to #keystone-google-btn. Marks any element as a Google sign-in trigger.",
                  example: '<button data-keystone-google>Sign in with Google</button>',
                },
                {
                  name: 'data-keystone-logout',
                  description: "Alternative to #keystone-logout. Marks any element as a logout trigger.",
                  example: '<button data-keystone-logout>Sign out</button>',
                },
                {
                  name: 'data-keystone-message',
                  description: "Alternative to #keystone-message. Marks any element as the message container.",
                  example: '<p data-keystone-message></p>',
                },
              ],
            },
          ].map((section) => (
            <Card key={section.title} variant="glass" className="p-4 sm:p-5 border border-theme/20">
              <h4 className="text-[13px] font-semibold txt-head mb-4 flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gold/10 flex items-center justify-center shrink-0">
                  {section.icon}
                </div>
                {section.title}
              </h4>
              <div className="space-y-4">
                {section.items.map((item) => (
                  <div key={item.name} className="group">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                      <div className="shrink-0 sm:w-64">
                        <code className="inline-block px-2 py-1 rounded-lg bg-gold/10 text-gold text-[11px] font-mono break-all">
                          {item.name}
                        </code>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] txt-body leading-relaxed">{item.description}</p>
                        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                          <span className="txt-muted shrink-0">Example:</span>
                          <code className="text-gold break-all font-mono">{item.example}</code>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </SectionCard>

      <Advanced mode={mode}>
        {/* HTML reference */}
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-gold" />
              HTML reference
            </span>
          }
          description="Use these IDs and data attributes so the SDK can find your elements."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 bg-surface border border-theme/20">
              <h4 className="text-[13px] font-semibold txt-head mb-3 flex items-center gap-2">
                <LayoutTemplate className="w-4 h-4 text-gold" />
                Form IDs
              </h4>
              <div className="space-y-3">
                {[
                  { id: "keystone-login-form", desc: "Sign-in form. Needs email and password inputs." },
                  { id: "keystone-register-form", desc: "Sign-up form. Needs username, email, and password inputs." },
                  { id: "keystone-google-btn", desc: "Button that starts Google OAuth sign-in." },
                  { id: "keystone-logout", desc: "Button that signs the user out." },
                ].map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <code className="text-[11px] text-gold shrink-0 mt-0.5">#{item.id}</code>
                    <p className="text-[12px] txt-muted leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4 bg-surface border border-theme/20">
              <h4 className="text-[13px] font-semibold txt-head mb-3 flex items-center gap-2">
                <Braces className="w-4 h-4 text-gold" />
                Data attributes
              </h4>
              <div className="space-y-3">
                {[
                  { attr: "data-keystone-input", desc: "Use on inputs: email, password, username, name." },
                  { attr: "data-keystone-field", desc: "Use on display elements: email, name, username. Auto-filled after login." },
                  { attr: "data-keystone-url", desc: "Your Keystone API base URL." },
                  { attr: "data-keystone-client-id", desc: "Public client ID for this application." },
                ].map((item) => (
                  <div key={item.attr} className="flex items-start gap-3">
                    <code className="text-[11px] text-gold shrink-0 mt-0.5">{item.attr}</code>
                    <p className="text-[12px] txt-muted leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </SectionCard>

        {/* Security note */}
        <Alert variant="info" className="text-[12px]">
          <div className="flex items-start gap-2">
            {showSecret ? <EyeOff className="w-4 h-4 shrink-0" /> : <Eye className="w-4 h-4 shrink-0" />}
            <div className="flex-1">
              <p className="font-medium">Never expose your client secret in browser code</p>
              <p className="mt-1">
                The drop-in SDK only needs the public <strong>client ID</strong>. Keep the client secret on your backend.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowSecret((s) => !s)} className="shrink-0">
              {showSecret ? "Hide" : "Show why"}
            </Button>
          </div>
          {showSecret && (
            <div className="mt-3 pt-3 border-t border-gold/20 text-[11px] txt-muted">
              The client secret is used for server-to-server communication (e.g., exchanging authorization codes).
              Putting it in HTML or JavaScript sent to the browser would let anyone steal it.
            </div>
          )}
        </Alert>
      </Advanced>
    </div>
  );
}

export const ConnectProjectPanel = memo(ConnectProjectPanelBase);
