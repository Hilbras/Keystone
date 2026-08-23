import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Users, LogIn, UserPlus, ShieldAlert } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";
import { EmptyState } from "./ui/EmptyState.tsx";

interface DayPoint {
  date: string;
  logins: number;
  failedLogins: number;
  signups: number;
  dau: number;
}

const COLORS = {
  logins: "#22c55e",
  failedLogins: "#ef4444",
  signups: "#3b82f6",
  dau: "#c9a227",
};

export function MetricsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DayPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getUsageMetrics(days);
      setData(res.series);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    return data.reduce(
      (acc, d) => ({
        logins: acc.logins + d.logins,
        failedLogins: acc.failedLogins + d.failedLogins,
        signups: acc.signups + d.signups,
        dau: acc.dau + d.dau,
      }),
      { logins: 0, failedLogins: 0, signups: 0, dau: 0 }
    );
  }, [data]);

  const chartData = useMemo(() => {
    if (data.length === 0) return [];
    const max = Math.max(...data.map((d) => Math.max(d.logins, d.failedLogins, d.signups, d.dau, 1)));
    return data.map((d) => ({ ...d, loginsPct: (d.logins / max) * 100, failedPct: (d.failedLogins / max) * 100, signupsPct: (d.signups / max) * 100, dauPct: (d.dau / max) * 100 }));
  }, [data]);

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4 mt-6">
      {error && <Alert variant="error">{error}</Alert>}

      <Card variant="glass" className="p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-gold" />
            Usage metrics
          </h3>
          <div className="flex items-center gap-2">
            {[7, 30, 90].map((d) => (
              <Button key={d} size="sm" variant={days === d ? "primary" : "secondary"} onClick={() => setDays(d)}>
                {d}d
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <div className="p-3 rounded-lg border border-theme/30">
            <div className="flex items-center gap-2 text-[12px] txt-muted mb-1">
              <LogIn className="w-3.5 h-3.5 text-green-500" />
              Logins
            </div>
            <p className="text-[20px] font-semibold txt-head">{totals.logins.toLocaleString()}</p>
          </div>
          <div className="p-3 rounded-lg border border-theme/30">
            <div className="flex items-center gap-2 text-[12px] txt-muted mb-1">
              <Users className="w-3.5 h-3.5 text-gold" />
              Active users
            </div>
            <p className="text-[20px] font-semibold txt-head">{totals.dau.toLocaleString()}</p>
          </div>
          <div className="p-3 rounded-lg border border-theme/30">
            <div className="flex items-center gap-2 text-[12px] txt-muted mb-1">
              <UserPlus className="w-3.5 h-3.5 text-blue-500" />
              Signups
            </div>
            <p className="text-[20px] font-semibold txt-head">{totals.signups.toLocaleString()}</p>
          </div>
          <div className="p-3 rounded-lg border border-theme/30">
            <div className="flex items-center gap-2 text-[12px] txt-muted mb-1">
              <ShieldAlert className="w-3.5 h-3.5 text-red-500" />
              Failed logins
            </div>
            <p className="text-[20px] font-semibold txt-head">{totals.failedLogins.toLocaleString()}</p>
          </div>
        </div>

        {chartData.length === 0 ? (
          <EmptyState title="No data yet" description="Usage data will appear once users start signing in." />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              <div className="flex items-end gap-1 h-48 mb-2">
                {chartData.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col justify-end gap-0.5 group relative">
                    <div className="w-full rounded-t-sm opacity-90" style={{ height: `${d.loginsPct}%`, backgroundColor: COLORS.logins }} />
                    <div className="w-full rounded-t-sm opacity-90" style={{ height: `${d.signupsPct}%`, backgroundColor: COLORS.signups }} />
                    <div className="w-full rounded-t-sm opacity-90" style={{ height: `${d.failedPct}%`, backgroundColor: COLORS.failedLogins }} />
                    <div className="w-full rounded-t-sm opacity-90" style={{ height: `${d.dauPct}%`, backgroundColor: COLORS.dau }} />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded-md bg-surface border border-theme/30 px-2 py-1 text-[11px] txt-head shadow-lg">
                      {d.date}
                      <br />
                      logins {d.logins} · signups {d.signups} · failed {d.failedLogins} · active {d.dau}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[10px] txt-muted">
                <span>{chartData[0]?.date}</span>
                <span>{chartData[chartData.length - 1]?.date}</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="success">Logins</Badge>
          <Badge variant="default">Signups</Badge>
          <Badge variant="danger">Failed logins</Badge>
          <Badge variant="gold">Active users</Badge>
        </div>
      </Card>
    </div>
  );
}
