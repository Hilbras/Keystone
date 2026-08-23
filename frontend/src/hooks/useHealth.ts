import { useEffect, useState } from "react";
import { api } from "../api.ts";

export type ServiceStatus = "ok" | "error" | "unknown";

export interface HealthState {
  api: ServiceStatus;
  database: ServiceStatus;
  redis: ServiceStatus;
  setupComplete: ServiceStatus;
  loading: boolean;
  error: string | null;
  lastCheck: Date | null;
}

export function useHealth(pollMs = 10000): HealthState {
  const [state, setState] = useState<HealthState>({
    api: "unknown",
    database: "unknown",
    redis: "unknown",
    setupComplete: "unknown",
    loading: true,
    error: null,
    lastCheck: null,
  });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const [status, health] = await Promise.all([api.getStatus(), api.getHealth().catch(() => null)]);
        if (cancelled) return;

        const apiOk = health?.status === "ok" || health?.status === "setup";
        setState({
          api: apiOk ? "ok" : "error",
          database: health?.database === true ? "ok" : health?.database === false ? "error" : "unknown",
          redis: health?.redis === true ? "ok" : health?.redis === false ? "error" : "unknown",
          setupComplete: status?.needsSetup === false ? "ok" : "error",
          loading: false,
          error: null,
          lastCheck: new Date(),
        });
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          api: "error",
          database: "error",
          redis: "error",
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          lastCheck: new Date(),
        }));
      }
    };

    check();
    const interval = setInterval(check, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs]);

  return state;
}
