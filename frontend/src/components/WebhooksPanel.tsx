import { useCallback, useEffect, useState } from "react";
import { Webhook, Plus, Trash2, RefreshCw, RotateCcw, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { api } from "../api.ts";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Badge } from "./ui/Badge.tsx";
import { Switch } from "./ui/Switch.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";
import { EmptyState } from "./ui/EmptyState.tsx";
import { useToastContext } from "./ui/ToastProvider.tsx";

interface Endpoint {
  id: string;
  appId: string | null;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

interface Delivery {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

export function WebhooksPanel() {
  const { addToast } = useToastContext();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState("");
  const [busy, setBusy] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getWebhooks();
      setEndpoints(data.endpoints);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadDeliveries = async (endpointId: string) => {
    try {
      const data = await api.getWebhookDeliveries(endpointId);
      setDeliveries((prev) => ({ ...prev, [endpointId]: data.deliveries }));
    } catch {
      addToast("Failed to load deliveries", "error");
    }
  };

  const toggleExpand = (endpointId: string) => {
    if (expanded === endpointId) {
      setExpanded(null);
    } else {
      setExpanded(endpointId);
      loadDeliveries(endpointId);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createWebhook({
        url,
        description: description || undefined,
        events: events.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setNewSecret(result.signingSecret);
      setUrl("");
      setDescription("");
      setEvents("");
      setShowForm(false);
      addToast("Webhook created", "success");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this webhook endpoint?")) return;
    try {
      await api.deleteWebhook(id);
      addToast("Webhook deleted", "success");
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete", "error");
    }
  };

  const toggleActive = async (endpoint: Endpoint) => {
    try {
      await api.updateWebhook(endpoint.id, { isActive: !endpoint.isActive });
      setEndpoints((prev) => prev.map((e) => (e.id === endpoint.id ? { ...e, isActive: !e.isActive } : e)));
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update", "error");
    }
  };

  const rotateSecret = async (id: string) => {
    if (!confirm("Rotate the signing secret? The current secret stops working immediately.")) return;
    try {
      const result = await api.rotateWebhookSecret(id);
      setNewSecret(result.signingSecret);
      addToast("Secret rotated", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to rotate secret", "error");
    }
  };

  const retry = async (deliveryId: string, endpointId: string) => {
    try {
      await api.retryWebhookDelivery(deliveryId);
      addToast("Delivery re-queued", "success");
      setTimeout(() => loadDeliveries(endpointId), 1000);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to retry", "error");
    }
  };

  if (loading) return <LoadingState message="Loading webhooks…" />;

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-gold" />
          Webhooks
        </span>
      }
      description="Receive platform events (signups, logins, etc.) as signed HTTP POST requests."
      action={
        <Button size="sm" onClick={() => setShowForm((s) => !s)}>
          <Plus className="w-4 h-4" />
          {showForm ? "Cancel" : "Add endpoint"}
        </Button>
      }
    >
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}
      {newSecret && (
        <Alert variant="info" className="mb-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold mb-1">Signing secret (shown once)</p>
              <code className="font-mono text-gold break-all text-[12px]">{newSecret}</code>
              <p className="text-[11px] mt-1 opacity-80">Verify requests with the X-Keystone-Signature header.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(newSecret); addToast("Copied", "success"); }}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </Alert>
      )}

      {showForm && (
        <form onSubmit={create} className="mb-5 p-3 sm:p-4 rounded-xl bg-surface border border-theme/20 space-y-3">
          <FieldHelp label="Endpoint URL" help="Keystone sends event payloads here as HTTP POST with a JSON body. Must be publicly reachable.">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/webhooks/keystone" required />
          </FieldHelp>
          <FieldHelp label="Description" help="Optional label to recognize this endpoint.">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Production server" />
          </FieldHelp>
          <FieldHelp label="Events" help="Comma-separated event types to receive. Leave empty to receive all events." example="user_registered, user_login, user_login_failed">
            <Input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="All events" />
          </FieldHelp>
          <Button type="submit" size="sm" isLoading={busy} disabled={!url}>
            Create endpoint
          </Button>
        </form>
      )}

      {endpoints.length === 0 ? (
        <EmptyState
          title="No webhook endpoints"
          description="Add an endpoint to start receiving platform events."
        />
      ) : (
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} className="rounded-xl border border-theme/20 bg-surface overflow-hidden">
              <div className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-[13px] font-medium txt-head break-all">{endpoint.url}</code>
                    <Badge variant={endpoint.isActive ? "success" : "warning"}>
                      {endpoint.isActive ? "Active" : "Paused"}
                    </Badge>
                  </div>
                  <p className="text-[11px] txt-muted mt-1">
                    {endpoint.description || "No description"} ·{" "}
                    {endpoint.events.length > 0 ? endpoint.events.join(", ") : "All events"}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={endpoint.isActive} onChange={() => toggleActive(endpoint)} title={endpoint.isActive ? "Pause" : "Resume"} />
                  <Button size="sm" variant="secondary" onClick={() => rotateSecret(endpoint.id)} title="Rotate signing secret">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => toggleExpand(endpoint.id)} title="Delivery logs">
                    {expanded === endpoint.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(endpoint.id)} title="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {expanded === endpoint.id && (
                <div className="border-t border-theme/20 p-3 sm:p-4 bg-background/50">
                  <p className="text-[12px] font-semibold txt-head mb-2">Recent deliveries</p>
                  {(deliveries[endpoint.id] ?? []).length === 0 ? (
                    <p className="text-[12px] txt-muted">No deliveries yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {(deliveries[endpoint.id] ?? []).slice(0, 10).map((d) => (
                        <div key={d.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2 rounded-lg border border-theme/10">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium txt-head">{d.eventType}</span>
                              <Badge variant={d.status === "success" ? "success" : d.status === "failed" ? "danger" : "warning"}>
                                {d.status}
                              </Badge>
                              {d.responseStatus && (
                                <span className="text-[11px] txt-muted">HTTP {d.responseStatus}</span>
                              )}
                            </div>
                            <p className="text-[11px] txt-muted">
                              {d.attempts} attempt{d.attempts !== 1 ? "s" : ""} · {new Date(d.createdAt).toLocaleString()}
                            </p>
                          </div>
                          {d.status === "failed" && (
                            <Button size="sm" variant="secondary" onClick={() => retry(d.id, endpoint.id)}>
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Retry
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
