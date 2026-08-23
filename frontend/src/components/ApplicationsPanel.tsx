import { memo, useEffect, useState } from "react";
import { LayoutGrid, Plus, Save, X, Power, Shield, Palette } from "lucide-react";
import { api, type BrandingInput } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import { Select } from "./ui/Select.tsx";
import { DataTable } from "./DataTable.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { useUiMode } from "../hooks/useUiMode.ts";
import { useToastContext } from "./ui/ToastProvider.tsx";
import { APPLICATION_TEMPLATES } from "../lib/templates.ts";
import type { DataTabState } from "../Dashboard.tsx";

interface ApplicationsPanelProps {
  state: DataTabState<{ applications: unknown[] }>;
  organizations: DataTabState<{ organizations: unknown[] }>;
  onRefresh: () => void;
}

function ApplicationsPanelBase({ state, organizations, onRefresh }: ApplicationsPanelProps) {
  const { mode } = useUiMode();
  const { addToast } = useToastContext();
  const [showForm, setShowForm] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [name, setName] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [ipEditApp, setIpEditApp] = useState<Record<string, unknown> | null>(null);
  const [allowedIps, setAllowedIps] = useState("");
  const [blockedIps, setBlockedIps] = useState("");
  const [brandEditApp, setBrandEditApp] = useState<Record<string, unknown> | null>(null);
  const [branding, setBranding] = useState<BrandingInput>({});
  const [brandingPreview, setBrandingPreview] = useState<BrandingInput | null>(null);

  const openBrandingEditor = (app: Record<string, unknown>) => {
    reset();
    setBrandEditApp(app);
    setBranding(appBranding(app));
  };

  const saveBranding = async () => {
    if (!brandEditApp) return;
    reset();
    setBusy(true);
    try {
      const clean: BrandingInput = Object.fromEntries(
        Object.entries(branding).filter(([, v]) => v !== undefined && v !== "")
      ) as BrandingInput;
      await api.updateApplication(String(brandEditApp.orgId), String(brandEditApp.id), { branding: clean });
      setSuccess("Branding updated");
      addToast("Branding updated", "success");
      setBrandEditApp(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update branding");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!brandEditApp || !brandEditApp.clientId) return;
    api
      .getPublicBranding(String(brandEditApp.clientId))
      .then(setBrandingPreview)
      .catch(() => setBrandingPreview(null));
  }, [brandEditApp]);

  const appBranding = (app: Record<string, unknown>): BrandingInput => {
    const b = (app.branding ?? {}) as Record<string, unknown>;
    return {
      logoUrl: typeof b.logoUrl === "string" ? b.logoUrl : undefined,
      primaryColor: typeof b.primaryColor === "string" ? b.primaryColor : undefined,
      accentColor: typeof b.accentColor === "string" ? b.accentColor : undefined,
      companyName: typeof b.companyName === "string" ? b.companyName : undefined,
      supportEmail: typeof b.supportEmail === "string" ? b.supportEmail : undefined,
      loginTitle: typeof b.loginTitle === "string" ? b.loginTitle : undefined,
      loginSubtitle: typeof b.loginSubtitle === "string" ? b.loginSubtitle : undefined,
    };
  };

  const orgOptions = organizations.data?.organizations ?? [];

  const reset = () => {
    setError(null);
    setSuccess(null);
    setCreatedSecret(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    if (!orgId) {
      setError("Select an organization");
      return;
    }
    setBusy(true);
    try {
      const result = await api.createApplication(orgId, {
        name,
        redirectUris: redirectUris.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setSuccess(`Application created. Client ID: ${result.clientId}`);
      addToast("Application created successfully", "success");
      setCreatedSecret(result.clientSecret);
      setName("");
      setRedirectUris("");
      setShowForm(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create application");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (app: Record<string, unknown>) => {
    reset();
    setBusy(true);
    try {
      await api.updateApplication(String(app.orgId), String(app.id), { isActive: !app.isActive });
      setSuccess("Application updated");
      addToast("Application status updated", "success");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update application");
    } finally {
      setBusy(false);
    }
  };

  const openIpEditor = (app: Record<string, unknown>) => {
    reset();
    setIpEditApp(app);
    setAllowedIps(((app.allowedIps as string[]) ?? []).join(", "));
    setBlockedIps(((app.blockedIps as string[]) ?? []).join(", "));
  };

  const saveIpControls = async () => {
    if (!ipEditApp) return;
    reset();
    setBusy(true);
    try {
      await api.updateApplication(String(ipEditApp.orgId), String(ipEditApp.id), {
        allowedIps: allowedIps.split(",").map((s) => s.trim()).filter(Boolean),
        blockedIps: blockedIps.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setSuccess("IP controls updated");
      addToast("IP controls updated", "success");
      setIpEditApp(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update IP controls");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="glass" className="mt-6 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
          <LayoutGrid className="w-4 h-4 text-gold" />
          Applications
        </h3>
        <Button size="sm" onClick={() => setShowForm((s) => !s)}>
          <Plus className="w-4 h-4" />
          {showForm ? "Cancel" : "Create"}
        </Button>
      </div>

      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}
      {createdSecret && (
        <Alert variant="info" className="mb-4">
          Client secret (copy now, it will not be shown again): {" "}
          <code className="font-mono text-gold break-all">{createdSecret}</code>
        </Alert>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-5 p-3 sm:p-4 rounded-xl bg-surface border border-theme/20 space-y-3">
          <div>
            <Label className="text-[12px]">Organization</Label>
            <Select value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
              <option value="">Select organization</option>
              {orgOptions.map((org: unknown) => {
                const o = org as Record<string, unknown>;
                return (
                  <option key={String(o.id)} value={String(o.id)}>
                    {String(o.name)}
                  </option>
                );
              })}
            </Select>
          </div>
          <div>
            <Label className="text-[12px]">Application name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" required />
          </div>
          <div>
            <Label className="text-[12px]">Template</Label>
            <Select
              value={templateId}
              onChange={(e) => {
                const id = e.target.value;
                setTemplateId(id);
                const tpl = APPLICATION_TEMPLATES.find((t) => t.id === id);
                if (tpl) {
                  setRedirectUris(tpl.redirectUris.join(", "));
                }
              }}
            >
              <option value="">No template</option>
              {APPLICATION_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </Select>
            {templateId && (
              <p className="text-[11px] txt-muted mt-1">
                {APPLICATION_TEMPLATES.find((t) => t.id === templateId)?.description}
              </p>
            )}
          </div>
          <FieldHelp
            label="Redirect URIs"
            help="Where users are sent after signing in with an external provider like Google. Must match the URI configured in the provider console."
            example="http://localhost:5173/callback, https://app.example.com/auth/callback"
          >
            <Input value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} placeholder="http://localhost:5173/callback" />
          </FieldHelp>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button type="submit" size="sm" isLoading={busy} disabled={!name || !orgId}>
              <Save className="w-4 h-4" />
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setShowForm(false)}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
          </div>
        </form>
      )}

      {ipEditApp && (
        <div className="mb-5 p-3 sm:p-4 rounded-xl bg-surface border border-theme/20 space-y-3">
          <p className="text-[13px] font-semibold txt-head flex items-center gap-2">
            <Shield className="w-4 h-4 text-gold" />
            IP controls — {String(ipEditApp.name)}
          </p>
          <FieldHelp
            label="Allowed IPs"
            help="If set, only these IPs or CIDR ranges may sign in to this application. Leave empty to allow all."
            example="203.0.113.10, 198.51.100.0/24"
          >
            <Input value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="203.0.113.0/24" />
          </FieldHelp>
          <FieldHelp
            label="Blocked IPs"
            help="These IPs or CIDR ranges are always rejected, even if they match the allowed list."
            example="192.0.2.55, 2001:db8::/32"
          >
            <Input value={blockedIps} onChange={(e) => setBlockedIps(e.target.value)} placeholder="192.0.2.55" />
          </FieldHelp>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button size="sm" onClick={saveIpControls} isLoading={busy}>
              <Save className="w-4 h-4" />
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setIpEditApp(null)}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {brandEditApp && (
        <div className="mb-5 p-3 sm:p-4 rounded-xl bg-surface border border-theme/20 space-y-4">
          <p className="text-[13px] font-semibold txt-head flex items-center gap-2">
            <Palette className="w-4 h-4 text-gold" />
            Branding — {String(brandEditApp.name)}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldHelp label="Company name" help="Shown on the hosted login page." example="Acme">
              <Input value={branding.companyName ?? ""} onChange={(e) => setBranding((b) => ({ ...b, companyName: e.target.value || undefined }))} placeholder="Acme" />
            </FieldHelp>
            <FieldHelp label="Logo URL" help="A public HTTPS URL to your logo." example="https://example.com/logo.svg">
              <Input value={branding.logoUrl ?? ""} onChange={(e) => setBranding((b) => ({ ...b, logoUrl: e.target.value || undefined }))} placeholder="https://example.com/logo.svg" />
            </FieldHelp>
            <FieldHelp label="Primary color" help="Hex color for buttons and accents." example="#c9a227">
              <div className="flex gap-2">
                <Input value={branding.primaryColor ?? ""} onChange={(e) => setBranding((b) => ({ ...b, primaryColor: e.target.value || undefined }))} placeholder="#c9a227" />
                <input type="color" value={branding.primaryColor || "#c9a227"} onChange={(e) => setBranding((b) => ({ ...b, primaryColor: e.target.value }))} className="w-10 h-9 rounded bg-transparent cursor-pointer" />
              </div>
            </FieldHelp>
            <FieldHelp label="Accent color" help="Secondary brand color." example="#ffffff">
              <div className="flex gap-2">
                <Input value={branding.accentColor ?? ""} onChange={(e) => setBranding((b) => ({ ...b, accentColor: e.target.value || undefined }))} placeholder="#ffffff" />
                <input type="color" value={branding.accentColor || "#ffffff"} onChange={(e) => setBranding((b) => ({ ...b, accentColor: e.target.value }))} className="w-10 h-9 rounded bg-transparent cursor-pointer" />
              </div>
            </FieldHelp>
            <FieldHelp label="Support email" help="Shown on the login page." example="support@example.com">
              <Input value={branding.supportEmail ?? ""} onChange={(e) => setBranding((b) => ({ ...b, supportEmail: e.target.value || undefined }))} placeholder="support@example.com" />
            </FieldHelp>
            <FieldHelp label="Login page title" help="Headline on the hosted sign-in screen." example="Sign in to Acme">
              <Input value={branding.loginTitle ?? ""} onChange={(e) => setBranding((b) => ({ ...b, loginTitle: e.target.value || undefined }))} placeholder="Sign in to Acme" />
            </FieldHelp>
            <FieldHelp label="Login page subtitle" help="Short text under the title." example="Welcome back — use your work email.">
              <Input value={branding.loginSubtitle ?? ""} onChange={(e) => setBranding((b) => ({ ...b, loginSubtitle: e.target.value || undefined }))} placeholder="Welcome back" />
            </FieldHelp>
          </div>

          <div className="rounded-lg border border-theme/30 p-4" style={{ backgroundColor: brandingPreview?.primaryColor ? `${brandingPreview.primaryColor}11` : undefined }}>
            <p className="text-[11px] uppercase tracking-wide txt-muted mb-2">Preview</p>
            <div className="flex flex-col items-center gap-3">
              {brandingPreview?.logoUrl && <img src={brandingPreview.logoUrl} alt="" className="h-10 object-contain" />}
              <div className="text-center">
                <p className="text-[16px] font-semibold txt-head">{brandingPreview?.loginTitle ?? brandingPreview?.companyName ?? String(brandEditApp.name)}</p>
                <p className="text-[13px] txt-muted">{brandingPreview?.loginSubtitle ?? "Branded login page"}</p>
              </div>
              <button
                type="button"
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-white"
                style={{ backgroundColor: brandingPreview?.primaryColor ?? "#c9a227" }}
              >
                Continue
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <Button size="sm" onClick={saveBranding} isLoading={busy}>
              <Save className="w-4 h-4" />
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setBrandEditApp(null)}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      <DataTable
        state={state}
        columns={mode === "simple" ? ["name", "isActive"] : ["id", "orgId", "clientId", "name", "isActive", "createdAt"]}
        rows={state.data?.applications ?? []}
        emptyMessage="No applications found."
        renderRowActions={(row) => (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => openBrandingEditor(row)} disabled={busy} title="Branding">
              <Palette className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openIpEditor(row)} disabled={busy} title="IP controls">
              <Shield className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => toggleActive(row)} disabled={busy}>
              <Power className="w-3 h-3 mr-1" />
              {row.isActive ? "Disable" : "Enable"}
            </Button>
          </div>
        )}
      />
    </Card>
  );
}

export const ApplicationsPanel = memo(ApplicationsPanelBase);
