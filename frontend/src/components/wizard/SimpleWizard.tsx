import { useEffect, useState } from "react";
import { CheckCircle2, Database, Server, Globe, User, Rocket, ArrowRight, ShieldCheck, Activity, RefreshCw } from "lucide-react";
import { api, type DiagnosticCheck } from "../../api.ts";
import { initialState, type WizardState } from "../../types.ts";
import { Button } from "../ui/Button.tsx";
import { Input } from "../ui/Input.tsx";
import { Label } from "../ui/Label.tsx";
import { Card } from "../ui/Card.tsx";
import { Alert } from "../ui/Alert.tsx";

const PROFILES = [
  { id: "development", label: "Development", desc: "Local machine with Docker" },
  { id: "docker", label: "Docker Compose", desc: "Container deployment" },
  { id: "production", label: "Production", desc: "Self-managed server" },
];

function generateId(len = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

interface SimpleWizardProps {
  onSwitchAdvanced?: () => void;
}

export default function SimpleWizard({ onSwitchAdvanced }: SimpleWizardProps) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState(() => localStorage.getItem("keystone-setup-token") || "");
  const [profile, setProfile] = useState("development");
  const [appName, setAppName] = useState("My App");
  const [appUrl, setAppUrl] = useState("http://localhost:3000");
  const [diagnostics, setDiagnostics] = useState<DiagnosticCheck[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  useEffect(() => {
    if (state.secrets.autoGenerate && (!state.secrets.internalApiKey || !state.secrets.encryptionKey)) {
      generateSecrets();
    }
  }, []);

  const update = <K extends keyof WizardState>(section: K, values: Partial<WizardState[K]>) => {
    setState((prev) => ({ ...prev, [section]: { ...prev[section], ...values } }));
  };

  const setErrorMessage = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const generateSecrets = () => {
    update("secrets", {
      internalApiKey: generateId(64),
      encryptionKey: generateId(32),
      jwtPrivateKey: "",
      jwtPublicKey: "",
      autoGenerate: true,
    });
  };

  const applyProfile = (id: string) => {
    setProfile(id);
    if (id === "development") {
      update("infrastructure", {
        databaseUrl: "postgresql://hilbras:hilbras@localhost:5432/hilbras",
        redisUrl: "redis://localhost:6379",
      });
      update("urls", {
        authApiPublicUrl: "http://localhost:4001",
        clientAppUrl: "http://localhost:5173",
        allowedOrigins: "http://localhost:5173,http://localhost:3000",
        cookieDomain: "localhost",
        cookieSecure: false,
      });
    } else if (id === "docker") {
      update("infrastructure", {
        databaseUrl: "postgresql://hilbras:hilbras@postgres:5432/hilbras",
        redisUrl: "redis://redis:6379",
      });
      update("urls", {
        authApiPublicUrl: "http://localhost:4001",
        clientAppUrl: "http://localhost:5173",
        allowedOrigins: "http://localhost:5173,http://localhost:3000",
        cookieDomain: "localhost",
        cookieSecure: false,
      });
    }
  };

  const next = () => setStep((s) => Math.min(s + 1, 3));

  const validateDatabase = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.validateDatabase({ databaseUrl: state.infrastructure.databaseUrl });
      setSuccess("Database connection successful");
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const validateRedis = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.validateRedis({ redisUrl: state.infrastructure.redisUrl });
      setSuccess("Redis connection successful");
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const env: Record<string, string> = {
        DATABASE_URL: state.infrastructure.databaseUrl,
        REDIS_URL: state.infrastructure.redisUrl,
        AUTH_API_PUBLIC_URL: state.urls.authApiPublicUrl,
        CLIENT_APP_URL: appUrl,
        ALLOWED_ORIGINS: `${state.urls.allowedOrigins},${appUrl}`,
        COOKIE_DOMAIN: state.urls.cookieDomain,
        COOKIE_SECURE: String(state.urls.cookieSecure),
        KEYSTONE_INTERNAL_API_KEY: state.secrets.internalApiKey,
        KEYSTONE_ENCRYPTION_KEY: state.secrets.encryptionKey,
        EMAIL_PROVIDER: "console",
        SMS_PROVIDER: "none",
      };
      await api.applyConfig({ env });
      await api.runMigrations();
      await api.init({
        email: state.owner.email,
        password: state.owner.password,
        name: state.owner.name,
      });
      setSuccess("Setup complete! Running diagnostics…");
      setStep(4);
      await runDiagnostics();
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const runDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const result = await api.getSetupDiagnostics();
      setDiagnostics(result.checks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    try {
      await api.restart();
    } catch {
      // The request may fail because the server is restarting.
    } finally {
      setBusy(false);
    }
  };

  const renderWelcome = () => (
    <div className="space-y-5">
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-gold/10 flex items-center justify-center mx-auto mb-3">
          <Rocket className="w-7 h-7 text-gold" />
        </div>
        <h2 className="text-[18px] font-semibold txt-head">Welcome to Keystone</h2>
        <p className="text-[13px] txt-muted mt-1">Let&apos;s set up your identity platform in a few steps.</p>
      </div>

      <div className="space-y-2">
        <Label className="text-[12px]">Choose your environment</Label>
        <div className="grid grid-cols-1 gap-2">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              onClick={() => applyProfile(p.id)}
              className={`flex items-center justify-between p-3 rounded-xl border text-left transition-colors ${
                profile === p.id ? "border-gold bg-gold/[0.05]" : "border-theme/20 bg-surface hover:border-gold/30"
              }`}
            >
              <div>
                <p className="text-[13px] font-medium txt-head">{p.label}</p>
                <p className="text-[11px] txt-muted">{p.desc}</p>
              </div>
              {profile === p.id && <CheckCircle2 className="w-4 h-4 text-gold" />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-[12px]">Setup token</Label>
        <Input
          type="password"
          value={setupToken}
          onChange={(e) => {
            const value = e.target.value.trim();
            setSetupToken(value);
            localStorage.setItem("keystone-setup-token", value);
          }}
          placeholder="Paste the token from the server logs"
        />
        <p className="text-[11px] txt-muted mt-1">Find it in the terminal where Keystone is running.</p>
      </div>

      <Button onClick={next} disabled={!setupToken} className="w-full">
        Start setup
        <ArrowRight className="w-4 h-4" />
      </Button>

      {onSwitchAdvanced && (
        <button onClick={onSwitchAdvanced} className="w-full text-center text-[12px] txt-muted hover:text-gold">
          Use advanced setup
        </button>
      )}
    </div>
  );

  const renderDependencies = () => (
    <div className="space-y-5">
      <h3 className="text-[16px] font-semibold txt-head flex items-center gap-2">
        <Database className="w-5 h-5 text-gold" />
        Connect dependencies
      </h3>
      <p className="text-[13px] txt-muted">Keystone needs PostgreSQL and Redis to run.</p>

      <Card className="p-4 bg-surface border border-theme/20 space-y-3">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-gold" />
          <span className="text-[13px] font-medium txt-head">PostgreSQL</span>
        </div>
        <Input
          aria-label="Database URL"
          value={state.infrastructure.databaseUrl}
          onChange={(e) => update("infrastructure", { databaseUrl: e.target.value })}
        />
        <Button size="sm" onClick={validateDatabase} disabled={busy} isLoading={busy}>
          Test database
        </Button>
      </Card>

      <Card className="p-4 bg-surface border border-theme/20 space-y-3">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-gold" />
          <span className="text-[13px] font-medium txt-head">Redis</span>
        </div>
        <Input
          aria-label="Redis URL"
          value={state.infrastructure.redisUrl}
          onChange={(e) => update("infrastructure", { redisUrl: e.target.value })}
        />
        <Button size="sm" onClick={validateRedis} disabled={busy} isLoading={busy}>
          Test Redis
        </Button>
      </Card>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="secondary" onClick={() => setStep(0)} className="w-full sm:w-auto">Back</Button>
        <Button onClick={next} className="w-full sm:w-auto">Continue</Button>
      </div>
    </div>
  );

  const renderOwner = () => (
    <div className="space-y-5">
      <h3 className="text-[16px] font-semibold txt-head flex items-center gap-2">
        <User className="w-5 h-5 text-gold" />
        Create owner account
      </h3>
      <p className="text-[13px] txt-muted">This will be the first administrator of your Keystone instance.</p>

      <div>
        <Label className="text-[12px]">Full name (optional)</Label>
        <Input aria-label="Full name (optional)" value={state.owner.name} onChange={(e) => update("owner", { name: e.target.value })} />
      </div>
      <div>
        <Label className="text-[12px]">Email</Label>
        <Input
          aria-label="Email"
          type="email"
          value={state.owner.email}
          onChange={(e) => update("owner", { email: e.target.value })}
          required
        />
      </div>
      <div>
        <Label className="text-[12px]">Password</Label>
        <Input
          aria-label="Password"
          type="password"
          value={state.owner.password}
          onChange={(e) => update("owner", { password: e.target.value })}
          required
          minLength={8}
        />
        <p className="text-[11px] txt-muted mt-1">Use at least 8 characters.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="secondary" onClick={() => setStep(1)} className="w-full sm:w-auto">Back</Button>
        <Button onClick={next} disabled={!state.owner.email || state.owner.password.length < 8} className="w-full sm:w-auto">
          Continue
        </Button>
      </div>
    </div>
  );

  const renderFirstApp = () => (
    <div className="space-y-5">
      <h3 className="text-[16px] font-semibold txt-head flex items-center gap-2">
        <Globe className="w-5 h-5 text-gold" />
        Connect your first project
      </h3>
      <p className="text-[13px] txt-muted">We&apos;ll create an application and organization for you automatically.</p>

      <div>
        <Label className="text-[12px]">Project name</Label>
        <Input aria-label="Project name" value={appName} onChange={(e) => setAppName(e.target.value)} />
      </div>
      <div>
        <Label className="text-[12px]">Project URL</Label>
        <Input aria-label="Project URL" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} />
        <p className="text-[11px] txt-muted mt-1">Where your website or app is hosted.</p>
      </div>

      <div className="p-3 rounded-xl bg-surface border border-theme/20 text-[12px] txt-muted">
        <ShieldCheck className="w-4 h-4 text-gold inline mr-1" />
        We will generate secure secrets, save your configuration, run migrations, and create your account.
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="secondary" onClick={() => setStep(2)} className="w-full sm:w-auto">Back</Button>
        <Button onClick={finish} disabled={busy} isLoading={busy} className="w-full sm:w-auto">
          Finish setup
        </Button>
      </div>
    </div>
  );

  const renderDiagnostics = () => {
    return (
      <div className="space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
            <Activity className="w-7 h-7 text-emerald-500" />
          </div>
          <h2 className="text-[18px] font-semibold txt-head">System diagnostics</h2>
          <p className="text-[13px] txt-muted mt-1">Review the health report before restarting.</p>
        </div>

        <div className="space-y-2">
          {diagnosticsLoading && <p className="text-[13px] txt-muted">Running checks…</p>}
          {!diagnosticsLoading && diagnostics.length === 0 && (
            <p className="text-[13px] txt-muted">No diagnostics available.</p>
          )}
          {diagnostics.map((check) => (
            <div
              key={check.name}
              className={`flex items-center justify-between p-3 rounded-xl border ${
                check.status === "ok"
                  ? "border-emerald-500/30 bg-emerald-500/[0.05]"
                  : check.status === "error"
                    ? "border-red-500/30 bg-red-500/[0.05]"
                    : "border-theme/20 bg-surface"
              }`}
            >
              <div>
                <p className="text-[13px] font-medium txt-head">{check.name}</p>
                {check.message && <p className="text-[11px] txt-muted">{check.message}</p>}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  check.status === "ok"
                    ? "text-emerald-500"
                    : check.status === "error"
                      ? "text-red-500"
                      : check.status === "warning"
                        ? "text-amber-500"
                        : "text-zinc-400"
                }`}
              >
                {check.status === "ok" ? "OK" : check.status === "error" ? "Issue" : check.status === "warning" ? "Warning" : "Skipped"}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button variant="secondary" onClick={runDiagnostics} disabled={diagnosticsLoading} className="w-full sm:w-auto">
            <RefreshCw className={`w-4 h-4 ${diagnosticsLoading ? "animate-spin" : ""}`} />
            Re-run checks
          </Button>
          <Button onClick={restart} disabled={busy} isLoading={busy} className="w-full sm:w-auto">
            Restart to complete
          </Button>
        </div>
      </div>
    );
  };

  const steps = [renderWelcome, renderDependencies, renderOwner, renderFirstApp, renderDiagnostics];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`h-1.5 w-8 rounded-full ${i <= step ? "bg-gold" : "bg-surface border border-theme/30"}`}
            />
          ))}
        </div>
        <span className="text-[11px] txt-muted">Step {step + 1} of 5</span>
      </div>

      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {steps[step]()}
    </div>
  );
}
