import { useState } from "react";
import { Activity, Shield, FileText, Trash2, Plus, ExternalLink } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface SamlConnection {
  id: string;
  name: string;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  spEntityId: string;
  spAcsUrl: string;
  isActive: boolean;
  createdAt: string;
}

interface OidcConnection {
  id: string;
  name: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  clientId: string;
  scopes: string[];
  isActive: boolean;
  createdAt: string;
}

interface ScimConfig {
  enabled: boolean;
  baseUrl: string;
  orgId: string;
}

interface EnterpriseSsoPanelProps {
  samlState: DataTabState<{ connections: SamlConnection[] }>;
  oidcState: DataTabState<{ connections: OidcConnection[] }>;
  scimState: DataTabState<ScimConfig>;
  selectedOrgId: string | null;
  onRefresh: () => void;
  onCreateSaml: (input: { name: string; spEntityId: string; spAcsUrl: string }) => Promise<void>;
  onDeleteSaml: (id: string) => Promise<void>;
  onCreateOidc: (input: { name: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; clientSecret: string }) => Promise<void>;
  onDeleteOidc: (id: string) => Promise<void>;
}

export function EnterpriseSsoPanel({
  samlState,
  oidcState,
  scimState,
  selectedOrgId,
  onRefresh,
  onCreateSaml,
  onDeleteSaml,
  onCreateOidc,
  onDeleteOidc,
}: EnterpriseSsoPanelProps) {
  const [activeSubtab, setActiveSubtab] = useState<"saml" | "oidc" | "scim">("saml");
  const [samlForm, setSamlForm] = useState({ name: "", spEntityId: "", spAcsUrl: "" });
  const [oidcForm, setOidcForm] = useState({ name: "", issuer: "", authorizationEndpoint: "", tokenEndpoint: "", clientId: "", clientSecret: "" });

  if (samlState.loading || oidcState.loading || scimState.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading enterprise SSO…</p>
      </div>
    );
  }

  if (samlState.error || oidcState.error || scimState.error) {
    return (
      <Alert variant="error" className="mt-6">
        Unable to load SSO settings: {samlState.error || oidcState.error || scimState.error}
      </Alert>
    );
  }

  if (!selectedOrgId) {
    return (
      <Alert variant="info" className="mt-6">
        Select an organization to manage enterprise SSO connections.
      </Alert>
    );
  }

  const samlConnections = samlState.data?.connections ?? [];
  const oidcConnections = oidcState.data?.connections ?? [];
  const scimConfig = scimState.data;

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <Button size="sm" variant={activeSubtab === "saml" ? "primary" : "secondary"} onClick={() => setActiveSubtab("saml")} className="w-full sm:w-auto">
          SAML
        </Button>
        <Button size="sm" variant={activeSubtab === "oidc" ? "primary" : "secondary"} onClick={() => setActiveSubtab("oidc")} className="w-full sm:w-auto">
          OIDC
        </Button>
        <Button size="sm" variant={activeSubtab === "scim" ? "primary" : "secondary"} onClick={() => setActiveSubtab("scim")} className="w-full sm:w-auto">
          SCIM
        </Button>
        <Button size="sm" variant="secondary" onClick={onRefresh} className="w-full sm:w-auto">
          Refresh
        </Button>
      </div>

      {activeSubtab === "saml" && (
        <Card variant="glass" className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
              <Shield className="w-4 h-4 text-gold" />
              SAML Connections
            </h3>
          </div>

          {samlConnections.length === 0 ? (
            <p className="text-[13px] txt-muted">No SAML connections configured.</p>
          ) : (
            <div className="space-y-2 mb-4">
              {samlConnections.map((conn) => (
                <div key={conn.id} className="p-3 rounded-xl border border-theme/20 bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium txt-head">{conn.name}</p>
                    <p className="text-[11px] txt-muted truncate">SP: {conn.spEntityId}</p>
                    <p className="text-[11px] txt-muted truncate">ACS: {conn.spAcsUrl}</p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                    <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(conn.spAcsUrl)} className="w-full sm:w-auto">
                      <ExternalLink className="w-4 h-4" />
                      Copy ACS
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => onDeleteSaml(conn.id)} className="w-full sm:w-auto">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="pt-4 border-t border-theme/20 space-y-3">
            <h4 className="text-[13px] font-medium txt-head flex items-center gap-2">
              <Plus className="w-4 h-4 text-gold" />
              Add SAML Connection
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-[12px]">Name</Label>
                <Input value={samlForm.name} onChange={(e) => setSamlForm({ ...samlForm, name: e.target.value })} placeholder="Okta" />
              </div>
              <div>
                <Label className="text-[12px]">SP Entity ID</Label>
                <Input value={samlForm.spEntityId} onChange={(e) => setSamlForm({ ...samlForm, spEntityId: e.target.value })} placeholder="https://keystone.example.com" />
              </div>
              <div className="md:col-span-2">
                <Label className="text-[12px]">SP ACS URL</Label>
                <Input value={samlForm.spAcsUrl} onChange={(e) => setSamlForm({ ...samlForm, spAcsUrl: e.target.value })} placeholder="https://keystone.example.com/sso/saml/callback" />
              </div>
            </div>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                onCreateSaml(samlForm);
                setSamlForm({ name: "", spEntityId: "", spAcsUrl: "" });
              }}
              disabled={!samlForm.name || !samlForm.spEntityId || !samlForm.spAcsUrl}
            >
              Create SAML Connection
            </Button>
          </div>
        </Card>
      )}

      {activeSubtab === "oidc" && (
        <Card variant="glass" className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
              <Shield className="w-4 h-4 text-gold" />
              OIDC Connections
            </h3>
          </div>

          {oidcConnections.length === 0 ? (
            <p className="text-[13px] txt-muted">No OIDC enterprise connections configured.</p>
          ) : (
            <div className="space-y-2 mb-4">
              {oidcConnections.map((conn) => (
                <div key={conn.id} className="p-3 rounded-xl border border-theme/20 bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium txt-head">{conn.name}</p>
                    <p className="text-[11px] txt-muted truncate">Issuer: {conn.issuer}</p>
                    <p className="text-[11px] txt-muted truncate">Client ID: {conn.clientId}</p>
                  </div>
                  <Button size="sm" variant="danger" onClick={() => onDeleteOidc(conn.id)} className="w-full sm:w-auto">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="pt-4 border-t border-theme/20 space-y-3">
            <h4 className="text-[13px] font-medium txt-head flex items-center gap-2">
              <Plus className="w-4 h-4 text-gold" />
              Add OIDC Connection
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-[12px]">Name</Label>
                <Input value={oidcForm.name} onChange={(e) => setOidcForm({ ...oidcForm, name: e.target.value })} placeholder="Azure AD" />
              </div>
              <div>
                <Label className="text-[12px]">Issuer</Label>
                <Input value={oidcForm.issuer} onChange={(e) => setOidcForm({ ...oidcForm, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/tenant/v2.0" />
              </div>
              <div>
                <Label className="text-[12px]">Authorization Endpoint</Label>
                <Input value={oidcForm.authorizationEndpoint} onChange={(e) => setOidcForm({ ...oidcForm, authorizationEndpoint: e.target.value })} />
              </div>
              <div>
                <Label className="text-[12px]">Token Endpoint</Label>
                <Input value={oidcForm.tokenEndpoint} onChange={(e) => setOidcForm({ ...oidcForm, tokenEndpoint: e.target.value })} />
              </div>
              <div>
                <Label className="text-[12px]">Client ID</Label>
                <Input value={oidcForm.clientId} onChange={(e) => setOidcForm({ ...oidcForm, clientId: e.target.value })} />
              </div>
              <div>
                <Label className="text-[12px]">Client Secret</Label>
                <Input type="password" value={oidcForm.clientSecret} onChange={(e) => setOidcForm({ ...oidcForm, clientSecret: e.target.value })} />
              </div>
            </div>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                onCreateOidc(oidcForm);
                setOidcForm({ name: "", issuer: "", authorizationEndpoint: "", tokenEndpoint: "", clientId: "", clientSecret: "" });
              }}
              disabled={!oidcForm.name || !oidcForm.issuer || !oidcForm.authorizationEndpoint || !oidcForm.tokenEndpoint || !oidcForm.clientId || !oidcForm.clientSecret}
            >
              Create OIDC Connection
            </Button>
          </div>
        </Card>
      )}

      {activeSubtab === "scim" && (
        <Card variant="glass" className="p-5">
          <h3 className="text-[14px] font-semibold txt-head mb-4 flex items-center gap-2">
            <FileText className="w-4 h-4 text-gold" />
            SCIM Provisioning
          </h3>
          {scimConfig ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] txt-muted">Status:</span>
                <span className={`text-[13px] font-medium ${scimConfig.enabled ? "text-emerald-500" : "text-red-500"}`}>
                  {scimConfig.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div>
                <span className="text-[13px] txt-muted">SCIM Base URL:</span>
                <code className="block text-[12px] txt-head bg-surface p-2 rounded-lg mt-1 break-all">{scimConfig.baseUrl}</code>
              </div>
              <p className="text-[12px] txt-muted">
                Configure your identity provider to provision users to the SCIM endpoint above using the bearer token set in <code className="font-mono text-gold">SCIM_BEARER_TOKEN</code>.
              </p>
            </div>
          ) : (
            <p className="text-[13px] txt-muted">SCIM configuration unavailable.</p>
          )}
        </Card>
      )}
    </div>
  );
}
