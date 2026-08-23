import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Database,
  Server,
  Globe,
  Key,
  Mail,
  MessageSquare,
  Link,
  User,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { api } from "./api.ts";
import { initialState, type WizardState, type EmailProvider, type SmsProvider } from "./types.ts";
import { Button } from "./components/ui/Button.tsx";
import { Input } from "./components/ui/Input.tsx";
import { Label } from "./components/ui/Label.tsx";
import { Select } from "./components/ui/Select.tsx";
import { Card } from "./components/ui/Card.tsx";
import { Alert } from "./components/ui/Alert.tsx";
import { StepIndicator } from "./components/ui/StepIndicator.tsx";

const STEPS = [
  "Token",
  "Infrastructure",
  "URLs",
  "Secrets",
  "Email",
  "SMS",
  "Connectors",
  "Review",
  "Owner",
  "Done",
];

const STEP_ICONS = [
  ShieldCheck,
  Database,
  Globe,
  Key,
  Mail,
  MessageSquare,
  Link,
  ShieldCheck,
  User,
  CheckCircle2,
];

function mask(value: string): string {
  return value ? "•".repeat(Math.min(value.length, 16)) : "(empty)";
}

function generateId(len = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

interface WizardProps {
  onUseSimple?: () => void;
}

export default function Wizard({ onUseSimple }: WizardProps) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [setupToken, setSetupToken] = useState(() => localStorage.getItem("keystone-setup-token") || "");

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

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const validateDatabase = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.validateDatabase({ databaseUrl: state.infrastructure.databaseUrl });
      setSuccess("Database connection successful");
      next();
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const validateRedis = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.validateRedis({ redisUrl: state.infrastructure.redisUrl });
      setSuccess("Redis connection successful");
      next();
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const generateSecrets = () => {
    update("secrets", {
      internalApiKey: generateId(64),
      encryptionKey: generateId(32),
      jwtPrivateKey: "",
      jwtPublicKey: "",
      autoGenerate: true,
    });
    setSuccess("Secrets generated");
  };

  const validateEmail = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.validateEmail({
        provider: state.email.provider,
        from: state.email.from,
        smtpHost: state.email.smtpHost,
        smtpPort: state.email.smtpPort,
        smtpUser: state.email.smtpUser,
        smtpPass: state.email.smtpPass,
        smtpSecure: state.email.smtpSecure,
        sendgridApiKey: state.email.sendgridApiKey,
        mailgunApiKey: state.email.mailgunApiKey,
        mailgunDomain: state.email.mailgunDomain,
        to: state.owner.email || "test@example.com",
      });
      setSuccess("Test email sent successfully");
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const validateSms = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.validateSms({
        provider: state.sms.provider,
        twilioAccountSid: state.sms.twilioAccountSid,
        twilioAuthToken: state.sms.twilioAuthToken,
        twilioFromNumber: state.sms.twilioFromNumber,
        twilioMessagingServiceSid: state.sms.twilioMessagingServiceSid,
        to: "+1234567890",
      });
      setSuccess("Test SMS sent successfully");
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const buildEnv = (): Record<string, string> => {
    const env: Record<string, string> = {
      DATABASE_URL: state.infrastructure.databaseUrl,
      REDIS_URL: state.infrastructure.redisUrl,
      AUTH_API_PUBLIC_URL: state.urls.authApiPublicUrl,
      CLIENT_APP_URL: state.urls.clientAppUrl,
      ALLOWED_ORIGINS: state.urls.allowedOrigins,
      COOKIE_DOMAIN: state.urls.cookieDomain,
      COOKIE_SECURE: String(state.urls.cookieSecure),
      KEYSTONE_INTERNAL_API_KEY: state.secrets.internalApiKey,
      KEYSTONE_ENCRYPTION_KEY: state.secrets.encryptionKey,
      EMAIL_PROVIDER: state.email.provider,
      EMAIL_FROM: state.email.from,
      SMS_PROVIDER: state.sms.provider,
    };

    if (state.secrets.jwtPrivateKey) env.JWT_PRIVATE_KEY = state.secrets.jwtPrivateKey;
    if (state.secrets.jwtPublicKey) env.JWT_PUBLIC_KEY = state.secrets.jwtPublicKey;

    if (state.email.provider === "smtp") {
      env.SMTP_HOST = state.email.smtpHost;
      env.SMTP_PORT = String(state.email.smtpPort);
      env.SMTP_USER = state.email.smtpUser;
      env.SMTP_PASS = state.email.smtpPass;
      env.SMTP_SECURE = String(state.email.smtpSecure);
    } else if (state.email.provider === "sendgrid") {
      env.SENDGRID_API_KEY = state.email.sendgridApiKey;
    } else if (state.email.provider === "mailgun") {
      env.MAILGUN_API_KEY = state.email.mailgunApiKey;
      env.MAILGUN_DOMAIN = state.email.mailgunDomain;
    }

    if (state.sms.provider === "twilio") {
      env.TWILIO_ACCOUNT_SID = state.sms.twilioAccountSid;
      env.TWILIO_AUTH_TOKEN = state.sms.twilioAuthToken;
      env.TWILIO_FROM_NUMBER = state.sms.twilioFromNumber;
      env.TWILIO_MESSAGING_SERVICE_SID = state.sms.twilioMessagingServiceSid;
    }

    const connectors: [keyof WizardState["connectors"], string, string?][] = [
      ["google", "GOOGLE", undefined],
      ["github", "GITHUB", undefined],
      ["azure", "AZURE", undefined],
      ["okta", "OKTA", "ISSUER"],
      ["keycloak", "KEYCLOAK", "ISSUER"],
      ["zitadel", "ZITADEL", "DOMAIN"],
    ];

    for (const [key, prefix, extra] of connectors) {
      const cfg = state.connectors[key];
      if (cfg.enabled) {
        env[`${prefix}_CLIENT_ID`] = cfg.clientId;
        env[`${prefix}_CLIENT_SECRET`] = cfg.clientSecret;
        if (extra && "issuer" in cfg && cfg.issuer) env[`${prefix}_${extra}`] = cfg.issuer;
        if (extra && "domain" in cfg && cfg.domain) env[`${prefix}_${extra}`] = cfg.domain;
      }
    }

    return env;
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const env = buildEnv();
      await api.applyConfig({ env });
      await api.runMigrations();
      setNeedsRestart(true);
      next();
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
    }
  };

  const createOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.init({
        email: state.owner.email,
        password: state.owner.password,
        name: state.owner.name,
      });
      next();
    } catch (err) {
      setErrorMessage(err);
    } finally {
      setBusy(false);
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

  const StepIcon = STEP_ICONS[step];

  const renderTokenStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">
        Enter the setup token shown in the server logs to continue.
      </p>
      <div>
        <Label htmlFor="token">Setup token</Label>
        <Input
          id="token"
          type="password"
          value={setupToken}
          onChange={(e) => {
            const value = e.target.value.trim();
            setSetupToken(value);
            localStorage.setItem("keystone-setup-token", value);
          }}
          placeholder="paste-token-here"
          leftIcon={<ShieldCheck className="w-4 h-4" />}
        />
      </div>
      <Button onClick={next} disabled={!setupToken} className="w-full sm:w-auto">
        Continue
      </Button>
    </div>
  );

  const renderInfrastructureStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">
        Configure PostgreSQL and Redis. Test each connection before continuing.
      </p>
      <div>
        <Label htmlFor="databaseUrl">Database URL</Label>
        <Input
          id="databaseUrl"
          type="text"
          value={state.infrastructure.databaseUrl}
          onChange={(e) => update("infrastructure", { databaseUrl: e.target.value })}
          leftIcon={<Database className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="redisUrl">Redis URL</Label>
        <Input
          id="redisUrl"
          type="text"
          value={state.infrastructure.redisUrl}
          onChange={(e) => update("infrastructure", { redisUrl: e.target.value })}
          leftIcon={<Server className="w-4 h-4" />}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button onClick={validateDatabase} disabled={busy} isLoading={busy}>
          Test database
        </Button>
        <Button onClick={validateRedis} disabled={busy} isLoading={busy}>
          Test Redis
        </Button>
      </div>
    </div>
  );

  const renderUrlsStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">Set the public URLs Keystone will use.</p>
      <div>
        <Label htmlFor="authApiPublicUrl">Auth API public URL</Label>
        <Input
          id="authApiPublicUrl"
          type="url"
          value={state.urls.authApiPublicUrl}
          onChange={(e) => update("urls", { authApiPublicUrl: e.target.value })}
          leftIcon={<Globe className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="clientAppUrl">Client app URL</Label>
        <Input
          id="clientAppUrl"
          type="url"
          value={state.urls.clientAppUrl}
          onChange={(e) => update("urls", { clientAppUrl: e.target.value })}
          leftIcon={<Globe className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="allowedOrigins">Allowed CORS origins (comma-separated)</Label>
        <Input
          id="allowedOrigins"
          type="text"
          value={state.urls.allowedOrigins}
          onChange={(e) => update("urls", { allowedOrigins: e.target.value })}
          leftIcon={<Link className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="cookieDomain">Cookie domain</Label>
        <Input
          id="cookieDomain"
          type="text"
          placeholder="localhost or .yourdomain.com"
          value={state.urls.cookieDomain}
          onChange={(e) => update("urls", { cookieDomain: e.target.value })}
          leftIcon={<Link className="w-4 h-4" />}
        />
        <p className="text-[11px] txt-muted mt-1">
          Use a leading dot for production, e.g. .yourdomain.com, so cookies work across subdomains.
        </p>
      </div>
      <label className="flex items-center gap-2.5 text-[13px] text-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={state.urls.cookieSecure}
          onChange={(e) => update("urls", { cookieSecure: e.target.checked })}
          className="w-4 h-4 rounded border-theme bg-surface text-gold focus:ring-gold/30"
        />
        Secure cookies (required for HTTPS production)
      </label>
      <Button onClick={next} className="w-full sm:w-auto">
        Continue
      </Button>
    </div>
  );

  const renderSecretsStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">
        Generate secure platform secrets. They are masked in the review step.
      </p>
      <label className="flex items-center gap-2.5 text-[13px] text-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={state.secrets.autoGenerate}
          onChange={(e) => update("secrets", { autoGenerate: e.target.checked })}
          className="w-4 h-4 rounded border-theme bg-surface text-gold focus:ring-gold/30"
        />
        Auto-generate secrets
      </label>

      {state.secrets.autoGenerate && (
        <div className="space-y-3">
          <Button onClick={generateSecrets} disabled={busy} variant="secondary">
            Generate secrets
          </Button>
          {state.secrets.internalApiKey && (
            <Alert variant="success">Secrets generated and will be written on apply.</Alert>
          )}
        </div>
      )}

      {!state.secrets.autoGenerate && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="internalApiKey">Internal API key</Label>
            <Input
              id="internalApiKey"
              type="password"
              value={state.secrets.internalApiKey}
              onChange={(e) => update("secrets", { internalApiKey: e.target.value })}
              leftIcon={<Key className="w-4 h-4" />}
            />
          </div>
          <div>
            <Label htmlFor="encryptionKey">Encryption key</Label>
            <Input
              id="encryptionKey"
              type="password"
              value={state.secrets.encryptionKey}
              onChange={(e) => update("secrets", { encryptionKey: e.target.value })}
              leftIcon={<Key className="w-4 h-4" />}
            />
          </div>
        </div>
      )}

      <Button
        onClick={next}
        disabled={!state.secrets.internalApiKey || !state.secrets.encryptionKey}
        className="w-full sm:w-auto"
      >
        Continue
      </Button>
    </div>
  );

  const renderEmailStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">Choose how Keystone sends emails.</p>
      <div>
        <Label htmlFor="emailProvider">Email provider</Label>
        <Select
          id="emailProvider"
          value={state.email.provider}
          onChange={(e) => update("email", { provider: e.target.value as EmailProvider })}
        >
          <option value="none">None</option>
          <option value="console">Console (development)</option>
          <option value="smtp">SMTP</option>
          <option value="sendgrid">SendGrid</option>
          <option value="mailgun">Mailgun</option>
        </Select>
      </div>

      <div>
        <Label htmlFor="emailFrom">From address</Label>
        <Input
          id="emailFrom"
          type="email"
          value={state.email.from}
          onChange={(e) => update("email", { from: e.target.value })}
          leftIcon={<Mail className="w-4 h-4" />}
        />
      </div>

      {state.email.provider === "smtp" && (
        <div className="space-y-4 pt-2 border-t border-theme/20">
          <div>
            <Label htmlFor="smtpHost">SMTP host</Label>
            <Input
              id="smtpHost"
              type="text"
              value={state.email.smtpHost}
              onChange={(e) => update("email", { smtpHost: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="smtpPort">SMTP port</Label>
            <Input
              id="smtpPort"
              type="number"
              value={state.email.smtpPort}
              onChange={(e) => update("email", { smtpPort: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label htmlFor="smtpUser">SMTP user</Label>
            <Input
              id="smtpUser"
              type="text"
              value={state.email.smtpUser}
              onChange={(e) => update("email", { smtpUser: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="smtpPass">SMTP password</Label>
            <Input
              id="smtpPass"
              type="password"
              value={state.email.smtpPass}
              onChange={(e) => update("email", { smtpPass: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2.5 text-[13px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={state.email.smtpSecure}
              onChange={(e) => update("email", { smtpSecure: e.target.checked })}
              className="w-4 h-4 rounded border-theme bg-surface text-gold focus:ring-gold/30"
            />
            Use TLS
          </label>
        </div>
      )}

      {state.email.provider === "sendgrid" && (
        <div className="pt-2 border-t border-theme/20">
          <Label htmlFor="sendgridApiKey">SendGrid API key</Label>
          <Input
            id="sendgridApiKey"
            type="password"
            value={state.email.sendgridApiKey}
            onChange={(e) => update("email", { sendgridApiKey: e.target.value })}
          />
        </div>
      )}

      {state.email.provider === "mailgun" && (
        <div className="space-y-4 pt-2 border-t border-theme/20">
          <div>
            <Label htmlFor="mailgunApiKey">Mailgun API key</Label>
            <Input
              id="mailgunApiKey"
              type="password"
              value={state.email.mailgunApiKey}
              onChange={(e) => update("email", { mailgunApiKey: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mailgunDomain">Mailgun domain</Label>
            <Input
              id="mailgunDomain"
              type="text"
              value={state.email.mailgunDomain}
              onChange={(e) => update("email", { mailgunDomain: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button onClick={validateEmail} disabled={busy || state.email.provider === "none"} isLoading={busy}>
          Send test email
        </Button>
        <Button onClick={next}>Continue</Button>
      </div>
    </div>
  );

  const renderSmsStep = () => (
    <div className="space-y-4">
      <p className="text-[13px] txt-muted">Choose how Keystone sends SMS messages.</p>
      <div>
        <Label htmlFor="smsProvider">SMS provider</Label>
        <Select
          id="smsProvider"
          value={state.sms.provider}
          onChange={(e) => update("sms", { provider: e.target.value as SmsProvider })}
        >
          <option value="none">None</option>
          <option value="console">Console (development)</option>
          <option value="twilio">Twilio</option>
        </Select>
      </div>

      {state.sms.provider === "twilio" && (
        <div className="space-y-4 pt-2 border-t border-theme/20">
          <div>
            <Label htmlFor="twilioAccountSid">Account SID</Label>
            <Input
              id="twilioAccountSid"
              type="text"
              value={state.sms.twilioAccountSid}
              onChange={(e) => update("sms", { twilioAccountSid: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="twilioAuthToken">Auth token</Label>
            <Input
              id="twilioAuthToken"
              type="password"
              value={state.sms.twilioAuthToken}
              onChange={(e) => update("sms", { twilioAuthToken: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="twilioFromNumber">From number</Label>
            <Input
              id="twilioFromNumber"
              type="text"
              value={state.sms.twilioFromNumber}
              onChange={(e) => update("sms", { twilioFromNumber: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="twilioMessagingServiceSid">Messaging service SID</Label>
            <Input
              id="twilioMessagingServiceSid"
              type="text"
              value={state.sms.twilioMessagingServiceSid}
              onChange={(e) => update("sms", { twilioMessagingServiceSid: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button onClick={validateSms} disabled={busy || state.sms.provider === "none"} isLoading={busy}>
          Send test SMS
        </Button>
        <Button onClick={next}>Continue</Button>
      </div>
    </div>
  );

  const renderConnectorsStep = () => {
    const toggle = (key: keyof WizardState["connectors"]) => {
      setState((prev) => ({
        ...prev,
        connectors: {
          ...prev.connectors,
          [key]: { ...prev.connectors[key], enabled: !prev.connectors[key].enabled },
        },
      }));
    };

    const updateConnector = (key: keyof WizardState["connectors"], field: string, value: string) => {
      setState((prev) => ({
        ...prev,
        connectors: {
          ...prev.connectors,
          [key]: { ...prev.connectors[key], [field]: value },
        },
      }));
    };

    const connectorCard = (key: keyof WizardState["connectors"], label: string, extra?: string) => {
      const cfg = state.connectors[key];
      return (
        <Card
          key={key}
          className={`p-4 transition-colors ${cfg.enabled ? "border-gold/30 bg-gold/[0.03]" : ""}`}
        >
          <label className="flex items-center gap-3 text-[13px] font-medium text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={() => toggle(key)}
              className="w-4 h-4 rounded border-theme bg-surface text-gold focus:ring-gold/30"
            />
            {label}
          </label>
          {cfg.enabled && (
            <div className="space-y-3 mt-3 pt-3 border-t border-theme/20">
              <div>
                <Label className="text-[12px]">Client ID</Label>
                <Input
                  type="text"
                  value={cfg.clientId}
                  onChange={(e) => updateConnector(key, "clientId", e.target.value)}
                />
              </div>
              <div>
                <Label className="text-[12px]">Client secret</Label>
                <Input
                  type="password"
                  value={cfg.clientSecret}
                  onChange={(e) => updateConnector(key, "clientSecret", e.target.value)}
                />
              </div>
              {extra && (
                <div>
                  <Label className="text-[12px]">{extra === "issuer" ? "Issuer" : "Domain"}</Label>
                  <Input
                    type="text"
                    value={(cfg as unknown as Record<string, string>)[extra]}
                    onChange={(e) => updateConnector(key, extra, e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
        </Card>
      );
    };

    return (
      <div className="space-y-4">
        <p className="text-[13px] txt-muted">Enable optional identity connectors. All are optional.</p>
        <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
          {connectorCard("google", "Google")}
          {connectorCard("github", "GitHub")}
          {connectorCard("azure", "Azure AD")}
          {connectorCard("okta", "Okta", "issuer")}
          {connectorCard("keycloak", "Keycloak", "issuer")}
          {connectorCard("zitadel", "Zitadel", "domain")}
        </div>
        <Button onClick={next} className="w-full sm:w-auto">
          Continue
        </Button>
      </div>
    );
  };

  const renderOwnerStep = () => (
    <form onSubmit={createOwner} className="space-y-4">
      <p className="text-[13px] txt-muted">Create the first platform owner account.</p>
      <div>
        <Label htmlFor="ownerName">Full name (optional)</Label>
        <Input
          id="ownerName"
          type="text"
          value={state.owner.name}
          onChange={(e) => update("owner", { name: e.target.value })}
          leftIcon={<User className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="ownerEmail">Email address</Label>
        <Input
          id="ownerEmail"
          type="email"
          required
          value={state.owner.email}
          onChange={(e) => update("owner", { email: e.target.value })}
          leftIcon={<Mail className="w-4 h-4" />}
        />
      </div>
      <div>
        <Label htmlFor="ownerPassword">Password</Label>
        <Input
          id="ownerPassword"
          type="password"
          required
          minLength={8}
          value={state.owner.password}
          onChange={(e) => update("owner", { password: e.target.value })}
          leftIcon={<Key className="w-4 h-4" />}
        />
      </div>
      <Button type="submit" disabled={busy} isLoading={busy} className="w-full sm:w-auto">
        Create owner account
      </Button>
    </form>
  );

  const renderReviewStep = () => {
    const env = buildEnv();
    return (
      <div className="space-y-4">
        <p className="text-[13px] txt-muted">Review the configuration before applying.</p>
        <div className="max-h-[320px] overflow-y-auto rounded-xl border border-theme/30 bg-surface p-4 space-y-2">
          {Object.entries(env).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4 text-[12px] border-b border-theme/20 last:border-0 pb-2 last:pb-0">
              <span className="txt-muted font-mono">{key}</span>
              <span className="txt-body">{mask(value)}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={back} variant="secondary" disabled={busy}>
            Back
          </Button>
          <Button onClick={apply} disabled={busy} isLoading={busy}>
            Apply configuration
          </Button>
        </div>
      </div>
    );
  };

  const renderDoneStep = () => (
    <div className="space-y-4 text-center">
      <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
        <CheckCircle2 className="w-7 h-7 text-emerald-500" />
      </div>
      <Alert variant="success" className="text-left">
        Setup complete. Owner account created for {state.owner.email}.
      </Alert>
      {needsRestart ? (
        <div className="space-y-3">
          <p className="text-[13px] txt-muted">
            Keystone must restart to load the new database configuration.
          </p>
          <Button onClick={restart} disabled={busy} isLoading={busy}>
            <RefreshCw className="w-4 h-4" />
            Restart server
          </Button>
        </div>
      ) : (
        <p className="text-[13px] txt-muted">You can now sign in to the Administration Portal.</p>
      )}
    </div>
  );

  const stepRenderers: Record<number, () => React.ReactNode> = {
    0: renderTokenStep,
    1: renderInfrastructureStep,
    2: renderUrlsStep,
    3: renderSecretsStep,
    4: renderEmailStep,
    5: renderSmsStep,
    6: renderConnectorsStep,
    7: renderReviewStep,
    8: renderOwnerStep,
    9: renderDoneStep,
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-gold/10 flex items-center justify-center text-gold">
          <StepIcon className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold txt-head leading-tight">
            {STEPS[step]}
          </h2>
          <p className="text-[11px] txt-muted">
            Step {step + 1} of {STEPS.length}
          </p>
        </div>
      </div>

      <StepIndicator steps={STEPS} current={step} />

      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="step-content">{stepRenderers[step]()}</div>

      {step > 0 && step < 9 && step !== 7 && (
        <div className="mt-5 pt-4 border-t border-theme/20 flex flex-col sm:flex-row gap-2">
          <Button variant="ghost" onClick={back} disabled={busy} className="w-full sm:w-auto">
            Back
          </Button>
          {onUseSimple && (
            <Button variant="secondary" onClick={onUseSimple} disabled={busy} className="w-full sm:w-auto">
              Use simple setup
            </Button>
          )}
        </div>
      )}

      {step === 0 && onUseSimple && (
        <button
          onClick={onUseSimple}
          className="w-full text-center text-[12px] txt-muted hover:text-gold mt-4"
        >
          Use simple setup
        </button>
      )}
    </div>
  );
}
