import { Activity, Plug, Trash2, Puzzle } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface PluginSummary {
  metadata: {
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
  };
  extensionPoints: string[];
}

interface ExtensionPointSummary {
  name: string;
  description: string;
  registered: string[];
}

interface PluginsPanelProps {
  pluginsState: DataTabState<{ plugins: PluginSummary[] }>;
  extensionsState: DataTabState<{ extensionPoints: ExtensionPointSummary[] }>;
  onRefresh: () => void;
  onUnregister: (name: string) => Promise<void>;
}

export function PluginsPanel({ pluginsState, extensionsState, onRefresh, onUnregister }: PluginsPanelProps) {
  if (pluginsState.loading || extensionsState.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading plugins…</p>
      </div>
    );
  }

  if (pluginsState.error || extensionsState.error) {
    return (
      <Alert variant="error" className="mt-6">
        Unable to load plugins: {pluginsState.error || extensionsState.error}
      </Alert>
    );
  }

  const plugins = pluginsState.data?.plugins ?? [];
  const extensionPoints = extensionsState.data?.extensionPoints ?? [];

  return (
    <div className="mt-6 space-y-4">
      <Card variant="glass" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <Plug className="w-4 h-4 text-gold" />
            Registered Plugins
          </h3>
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>

        {plugins.length === 0 ? (
          <p className="text-[13px] txt-muted">No plugins are currently registered.</p>
        ) : (
          <div className="space-y-3">
            {plugins.map((plugin) => (
              <div
                key={plugin.metadata.name}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-theme/20 bg-surface"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium txt-head">{plugin.metadata.name}</span>
                    <Badge variant="default">v{plugin.metadata.version}</Badge>
                  </div>
                  {plugin.metadata.description ? (
                    <p className="text-[12px] txt-muted mt-1">{plugin.metadata.description}</p>
                  ) : null}
                  {plugin.metadata.author ? (
                    <p className="text-[11px] txt-muted mt-0.5">by {plugin.metadata.author}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {plugin.extensionPoints.map((point) => (
                      <Badge key={point} variant="default" className="text-[10px]">
                        {point}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => onUnregister(plugin.metadata.name)}
                >
                  <Trash2 className="w-4 h-4" />
                  Unregister
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card variant="glass" className="p-5">
        <h3 className="text-[14px] font-semibold txt-head mb-4 flex items-center gap-2">
          <Puzzle className="w-4 h-4 text-gold" />
          Extension Points
        </h3>

        {extensionPoints.length === 0 ? (
          <p className="text-[13px] txt-muted">No extension points available.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {extensionPoints.map((point) => (
              <div key={point.name} className="p-4 rounded-xl border border-theme/20 bg-surface">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[13px] font-medium txt-head">{point.name}</span>
                  <Badge variant={point.registered.length > 0 ? "success" : "default"}>
                    {point.registered.length}
                  </Badge>
                </div>
                <p className="text-[12px] txt-muted">{point.description}</p>
                {point.registered.length > 0 && (
                  <p className="text-[11px] txt-muted mt-2">
                    Registered: {point.registered.join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
