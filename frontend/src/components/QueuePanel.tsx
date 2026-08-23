import { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw, RotateCcw, AlertCircle } from "lucide-react";
import { api } from "../api.ts";
import { Button } from "./ui/Button.tsx";
import { Card } from "./ui/Card.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";
import { EmptyState } from "./ui/EmptyState.tsx";
import { useToastContext } from "./ui/ToastProvider.tsx";

interface FailedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts?: number;
  createdAt?: string;
}

interface QueueStats {
  type: string;
  count: number;
  failed?: number;
  delayed?: number;
}

export function QueuePanel() {
  const { addToast } = useToastContext();
  const [status, setStatus] = useState<{ queue: string; stats: QueueStats[] } | null>(null);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, f] = await Promise.all([api.getQueueStatus(), api.getQueueFailed(50)]);
      setStatus(s);
      setFailed(f.failed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retryOne = async (id: string) => {
    setRetrying(id);
    try {
      await api.retryQueueJob(id);
      addToast("Job queued for retry", "success");
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Retry failed", "error");
    } finally {
      setRetrying(null);
    }
  };

  const retryAll = async () => {
    setRetryingAll(true);
    try {
      await api.retryAllQueueJobs();
      addToast("All failed jobs queued for retry", "success");
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Retry all failed", "error");
    } finally {
      setRetryingAll(false);
    }
  };

  if (loading) return <LoadingState />;

  const totalFailed = status?.stats?.reduce((sum, s) => sum + (s.failed ?? 0), 0) ?? 0;

  return (
    <div className="space-y-4 mt-6">
      {error && <Alert variant="error">{error}</Alert>}

      <Card variant="glass" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <Layers className="w-4 h-4 text-gold" />
            Queue overview
          </h3>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={load} isLoading={loading}>
              <RefreshCw className="w-3 h-3" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <Badge variant="default">Provider: {status?.queue ?? "unknown"}</Badge>
          {status?.stats.map((s) => (
            <Badge key={s.type} variant={s.failed ? "danger" : "default"}>
              {s.type}: {s.count.toLocaleString()}
              {s.delayed ? ` / ${s.delayed} delayed` : ""}
              {s.failed ? ` / ${s.failed} failed` : ""}
            </Badge>
          ))}
        </div>

        {status?.queue === "InProcessQueue" && (
          <Alert variant="info" className="text-[12px]">
            Running in-process queue. Failed jobs are not persisted, so retry and dead-letter management require BullMQ.
          </Alert>
        )}
      </Card>

      <Card variant="glass" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            Failed jobs
          </h3>
          {failed.length > 0 && status?.queue !== "InProcessQueue" && (
            <Button size="sm" variant="secondary" onClick={retryAll} isLoading={retryingAll}>
              <RotateCcw className="w-3 h-3" />
              Retry all
            </Button>
          )}
        </div>

        {failed.length === 0 ? (
          <EmptyState title="No failed jobs" description="The dead-letter queue is empty." />
        ) : (
          <div className="space-y-2">
            {failed.map((job) => (
              <div
                key={job.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-theme/30"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="warning">{job.type}</Badge>
                    <span className="text-[12px] txt-muted truncate font-mono">{job.id}</span>
                    {job.attempts !== undefined && (
                      <span className="text-[11px] txt-muted">{job.attempts} attempts</span>
                    )}
                  </div>
                  <pre className="mt-1 text-[11px] txt-muted bg-surface rounded p-2 overflow-auto max-h-24">
                    {JSON.stringify(job.payload, null, 2)}
                  </pre>
                </div>
                {status?.queue !== "InProcessQueue" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => retryOne(job.id)}
                    isLoading={retrying === job.id}
                    className="shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-[12px] txt-muted mt-4">Total failed: {totalFailed.toLocaleString()}</p>
      </Card>
    </div>
  );
}
