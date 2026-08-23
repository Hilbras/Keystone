import { Tooltip } from "./Tooltip.tsx";
import type { ServiceStatus } from "../../hooks/useHealth.ts";

interface HealthBadgeProps {
  status: ServiceStatus;
  label: string;
  className?: string;
}

export function HealthBadge({ status, label, className = "" }: HealthBadgeProps) {
  const colors = {
    ok: "bg-emerald-500",
    error: "bg-red-500",
    unknown: "bg-zinc-400",
  };

  return (
    <Tooltip content={`${label}: ${status}`}>
      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-theme/20 bg-surface text-[11px] txt-muted ${className}`}>
        <span className={`w-2 h-2 rounded-full ${colors[status]} ${status === "unknown" ? "animate-pulse" : ""}`} />
        {label}
      </span>
    </Tooltip>
  );
}
