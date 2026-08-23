import { X, Database, Server, Globe, CheckCircle2 } from "lucide-react";
import { Card } from "../ui/Card.tsx";
import { Button } from "../ui/Button.tsx";
import type { ServiceStatus } from "../../hooks/useHealth.ts";

interface DiagnosticsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  api: ServiceStatus;
  database: ServiceStatus;
  redis: ServiceStatus;
  setupComplete: ServiceStatus;
}

export function DiagnosticsDrawer({ isOpen, onClose, api, database, redis, setupComplete }: DiagnosticsDrawerProps) {
  if (!isOpen) return null;

  const items = [
    { label: "API", status: api, icon: <Globe className="w-4 h-4" />, fix: "Make sure Keystone is running and the API URL is correct." },
    { label: "Database", status: database, icon: <Database className="w-4 h-4" />, fix: "Check DATABASE_URL and ensure PostgreSQL is running." },
    { label: "Redis", status: redis, icon: <Server className="w-4 h-4" />, fix: "Check REDIS_URL and ensure Redis is running." },
    { label: "Setup", status: setupComplete, icon: <CheckCircle2 className="w-4 h-4" />, fix: "Complete the setup wizard at /setup." },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <Card className="relative w-full max-w-sm h-full bg-card border-l border-theme p-5 overflow-y-auto animate-slide-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-[16px] font-semibold txt-head">Diagnostics</h2>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close diagnostics">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.label}
              className={`p-4 rounded-xl border ${
                item.status === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.05]" : "border-theme/20 bg-surface"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {item.icon}
                <span className="text-[13px] font-medium txt-head">{item.label}</span>
                <span
                  className={`ml-auto text-[11px] font-medium ${
                    item.status === "ok" ? "text-emerald-500" : item.status === "error" ? "text-red-500" : "text-zinc-400"
                  }`}
                >
                  {item.status === "ok" ? "OK" : item.status === "error" ? "Issue" : "Checking"}
                </span>
              </div>
              {item.status !== "ok" && <p className="text-[11px] txt-muted">{item.fix}</p>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
