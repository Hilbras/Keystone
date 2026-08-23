import { useEffect, useState } from "react";
import { Shield, Activity, Lock, AlertTriangle } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Button } from "./ui/Button.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";

interface SecuritySummary {
  last24h: { logins: number; failedLogins: number };
  activeSessions: number;
  mfa: { enabled: number; total: number };
  anomalies?: {
    newDevices24h: number;
    recentFailedLogins: Array<{
      id: string;
      event: string;
      userId: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      createdAt: string;
    }>;
  };
  recentLogins: Array<{
    id: string;
    event: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
  }>;
}

export function SecurityPanel() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSecuritySummary();
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <LoadingState message="Loading security dashboard…" />;
  if (error) return <Alert variant="error">Unable to load security data: {error}</Alert>;
  if (!summary) return null;

  const mfaRate = summary.mfa.total > 0 ? Math.round((summary.mfa.enabled / summary.mfa.total) * 100) : 0;

  return (
    <div className="space-y-5">
      <SectionCard title="Security overview" description="Key security metrics for your Keystone instance.">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-gold" />
              <span className="text-[12px] txt-muted">24h logins</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{summary.last24h.logins}</p>
          </Card>
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-[12px] txt-muted">24h failed logins</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{summary.last24h.failedLogins}</p>
          </Card>
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <Lock className="w-4 h-4 text-gold" />
              <span className="text-[12px] txt-muted">Active sessions</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{summary.activeSessions}</p>
          </Card>
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-gold" />
              <span className="text-[12px] txt-muted">MFA adoption</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{mfaRate}%</p>
          </Card>
        </div>
      </SectionCard>

      <SectionCard title="Anomaly detection" description="Suspicious activity signals from the last 24 hours.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <span className="text-[12px] txt-muted">New devices detected</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{summary.anomalies?.newDevices24h ?? 0}</p>
          </Card>
          <Card className="p-4 bg-surface border border-theme/20">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-[12px] txt-muted">Failed login attempts</span>
            </div>
            <p className="text-[22px] font-semibold txt-head">{summary.last24h.failedLogins}</p>
          </Card>
        </div>
        {summary.anomalies && summary.anomalies.recentFailedLogins.length > 0 && (
          <div className="space-y-2">
            <p className="text-[12px] font-medium txt-head">Recent failed logins</p>
            {summary.anomalies.recentFailedLogins.map((login) => (
              <div key={login.id} className="p-3 rounded-xl border border-theme/20 bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium txt-head">{login.event}</p>
                  <p className="text-[11px] txt-muted truncate">{login.ipAddress || "Unknown IP"} · {login.userAgent || "Unknown device"}</p>
                </div>
                <span className="text-[11px] txt-muted shrink-0">{new Date(login.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Recent login activity" description="Latest successful sign-ins across the platform.">
        {summary.recentLogins.length === 0 ? (
          <p className="text-[13px] txt-muted">No recent login activity.</p>
        ) : (
          <div className="space-y-2">
            {summary.recentLogins.map((login) => (
              <div key={login.id} className="p-3 rounded-xl border border-theme/20 bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium txt-head">{login.event}</p>
                  <p className="text-[11px] txt-muted truncate">{login.ipAddress || "Unknown IP"} · {login.userAgent || "Unknown device"}</p>
                </div>
                <span className="text-[11px] txt-muted shrink-0">{new Date(login.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
        <Button size="sm" variant="secondary" onClick={load} className="mt-4">
          Refresh
        </Button>
      </SectionCard>
    </div>
  );
}
