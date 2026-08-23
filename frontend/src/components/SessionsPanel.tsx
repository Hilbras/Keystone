import { useEffect, useState } from "react";
import { Monitor, Smartphone, Globe, Trash2, LogOut } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";

interface Session {
  id: string;
  deviceFingerprint: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}

function parseDevice(ua: string | null): { icon: React.ReactNode; label: string } {
  if (!ua) return { icon: <Globe className="w-4 h-4" />, label: "Unknown device" };
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return { icon: <Smartphone className="w-4 h-4" />, label: "Mobile device" };
  }
  if (lower.includes("mac")) return { icon: <Monitor className="w-4 h-4" />, label: "Mac" };
  if (lower.includes("windows")) return { icon: <Monitor className="w-4 h-4" />, label: "Windows PC" };
  if (lower.includes("linux")) return { icon: <Monitor className="w-4 h-4" />, label: "Linux" };
  return { icon: <Globe className="w-4 h-4" />, label: "Browser" };
}

export function SessionsPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSessions();
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const revoke = async (id: string) => {
    if (!confirm("Sign out this device?")) return;
    try {
      await api.revokeSession(id);
      setSuccess("Session revoked");
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke session");
    }
  };

  const revokeAll = async () => {
    if (!confirm("Sign out all other devices?")) return;
    try {
      await api.revokeAllSessions();
      setSuccess("All other sessions revoked");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke sessions");
    }
  };

  if (loading) return <LoadingState message="Loading sessions…" />;

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-gold" />
          Active Sessions
        </span>
      }
      description="Devices currently signed in to your account."
      action={
        sessions.length > 1 ? (
          <Button size="sm" variant="danger" onClick={revokeAll}>
            <LogOut className="w-3.5 h-3.5 mr-1" />
            Sign out all others
          </Button>
        ) : undefined
      }
    >
      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {sessions.length === 0 ? (
        <p className="text-[12px] txt-muted">No active sessions found.</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => {
            const device = parseDevice(session.userAgent);
            const isCurrent = false; // TODO: detect current session by refresh token
            return (
              <Card key={session.id} variant="glass" className="p-4 border border-theme/20">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-gold/10 flex items-center justify-center shrink-0 text-gold">
                      {device.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-[13px] font-semibold txt-head">{device.label}</h4>
                        {isCurrent && <Badge variant="success">Current</Badge>}
                      </div>
                      <p className="text-[11px] txt-muted mt-0.5 truncate">{session.userAgent || "Unknown browser"}</p>
                      <div className="flex items-center gap-3 mt-2 text-[11px] txt-muted">
                        <span>IP: {session.ipAddress || "Unknown"}</span>
                        <span>Last seen: {new Date(session.lastSeenAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => revoke(session.id)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    Revoke
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
