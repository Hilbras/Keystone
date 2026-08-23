import { Server, ShieldCheck, Globe, Activity, Key, CheckCircle2 } from "lucide-react";
import { StatCard } from "../ui/StatCard.tsx";
import { SectionCard } from "../ui/SectionCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Badge } from "../ui/Badge.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";

const API_BASE = import.meta.env.VITE_KEYSTONE_API_URL || "http://localhost:4001";

interface OverviewPanelProps {
  health: { status: string } | null;
  config: Record<string, unknown> | null;
  queueStatus: { queue: string; stats: unknown[] } | null;
}

export function OverviewPanel({ health, config, queueStatus }: OverviewPanelProps) {
  return (
    <>
      <PageHeader
        title="Welcome to Keystone"
        description="Your identity platform is running. Manage applications, users, and integrations from the API or build additional admin screens here."
        action={
          health ? (
            <Badge variant={health.status === "ok" ? "success" : "warning"}>
              {health.status === "ok" ? "Healthy" : health.status}
            </Badge>
          ) : null
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="API URL"
          value={API_BASE}
          icon={<Server className="w-5 h-5" />}
          iconClassName="bg-gold/10 text-gold"
        />
        <StatCard
          label="Status"
          value={health?.status === "ok" ? "Operational" : health?.status || "Unknown"}
          icon={<ShieldCheck className="w-5 h-5" />}
          iconClassName="bg-emerald-500/10 text-emerald-500"
        />
        <StatCard
          label="Issuer"
          value={(config?.issuer as string) || "—"}
          icon={<Globe className="w-5 h-5" />}
          iconClassName="bg-blue-500/10 text-blue-500"
        />
        <StatCard
          label="Queue"
          value={queueStatus?.queue ?? "—"}
          icon={<Activity className="w-5 h-5" />}
          iconClassName="bg-purple-500/10 text-purple-500"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title={<><Key className="w-4 h-4 text-gold inline mr-2" />OIDC Endpoints</>}>
          <ul className="space-y-3">
            {[
              ["Authorization", config?.authorization_endpoint],
              ["Token", config?.token_endpoint],
              ["UserInfo", config?.userinfo_endpoint],
              ["JWKS", config?.jwks_uri],
              ["Revocation", config?.revocation_endpoint],
            ].map(([label, value]) => (
              <li key={label as string} className="flex flex-col gap-0.5">
                <span className="text-[11px] txt-muted uppercase tracking-wide font-semibold">{label as string}</span>
                <code className="text-[12px] txt-head bg-surface px-2 py-1 rounded-lg break-all">{(value as string) || "—"}</code>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title={<><CheckCircle2 className="w-4 h-4 text-emerald-500 inline mr-2" />Setup Complete</>}>
          <p className="text-[13px] txt-muted mb-4">
            Keystone is configured and ready to authenticate users and applications. You can now register applications and integrate sign-in flows.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.open(`${API_BASE}/documentation`, "_blank")}>
              Open API Docs
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(`${API_BASE}/.well-known/openid-configuration`, "_blank")}
            >
              View OIDC Config
            </Button>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
