import { useState } from "react";
import { Activity, ToggleLeft, ToggleRight, Trash2, Plus, FileJson } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { Input } from "./ui/Input.tsx";
import { Advanced } from "./ui/Advanced.tsx";
import { useUiMode } from "../hooks/useUiMode.ts";
import type { DataTabState } from "../Dashboard.tsx";

interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  source: "database" | "environment";
}

interface ConfigurationProfile {
  id: string;
  name: string;
  description: string;
}

interface FeatureFlagsPanelProps {
  flagsState: DataTabState<{ flags: FeatureFlag[] }>;
  profilesState: DataTabState<{ profiles: ConfigurationProfile[] }>;
  onRefresh: () => void;
  onToggle: (key: string, enabled: boolean) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
  onCreate: (key: string, enabled: boolean, description?: string) => Promise<void>;
}

export function FeatureFlagsPanel({
  flagsState,
  profilesState,
  onRefresh,
  onToggle,
  onDelete,
  onCreate,
}: FeatureFlagsPanelProps) {
  const { mode } = useUiMode();
  const [newKey, setNewKey] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<ConfigurationProfile | null>(null);

  if (flagsState.loading || profilesState.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading feature flags…</p>
      </div>
    );
  }

  if (flagsState.error || profilesState.error) {
    return (
      <Alert variant="error" className="mt-6">
        Unable to load feature flags: {flagsState.error || profilesState.error}
      </Alert>
    );
  }

  const flags = flagsState.data?.flags ?? [];
  const profiles = profilesState.data?.profiles ?? [];

  return (
    <div className="mt-6 space-y-4">
      <Card variant="glass" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <ToggleLeft className="w-4 h-4 text-gold" />
            Feature Flags
          </h3>
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>

        {flags.length === 0 ? (
          <p className="text-[13px] txt-muted">No feature flags configured.</p>
        ) : (
          <div className="space-y-2">
            {flags.map((flag) => (
              <div
                key={flag.key}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-theme/20 bg-surface"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium txt-head">{flag.key}</span>
                    <Badge variant={flag.source === "database" ? "default" : "success"}>{flag.source}</Badge>
                  </div>
                  {flag.description ? (
                    <p className="text-[12px] txt-muted mt-1">{flag.description}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant={flag.enabled ? "primary" : "secondary"}
                    onClick={() => onToggle(flag.key, !flag.enabled)}
                  >
                    {flag.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                    {flag.enabled ? "Enabled" : "Disabled"}
                  </Button>
                  {flag.source === "database" && (
                    <Button size="sm" variant="secondary" onClick={() => onDelete(flag.key)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 pt-5 border-t border-theme/20">
          <h4 className="text-[13px] font-medium txt-head mb-3 flex items-center gap-2">
            <Plus className="w-4 h-4 text-gold" />
            Create Flag
          </h4>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="flag_key"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="sm:max-w-xs"
            />
            <Input
              placeholder="Description (optional)"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />
            <Button
              size="sm"
              onClick={() => {
                onCreate(newKey, true, newDescription);
                setNewKey("");
                setNewDescription("");
              }}
              disabled={!newKey.trim()}
            >
              Create
            </Button>
          </div>
        </div>
      </Card>

      <Advanced mode={mode}>
        <Card variant="glass" className="p-5">
          <h3 className="text-[14px] font-semibold txt-head mb-4 flex items-center gap-2">
            <FileJson className="w-4 h-4 text-gold" />
            Configuration Profiles
          </h3>

          {profiles.length === 0 ? (
            <p className="text-[13px] txt-muted">No configuration profiles available.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => setSelectedProfile(profile)}
                  className="text-left p-4 rounded-xl border border-theme/20 bg-surface hover:border-gold/50 transition-colors"
                >
                  <span className="text-[13px] font-medium txt-head">{profile.name}</span>
                  <p className="text-[12px] txt-muted mt-1">{profile.description}</p>
                </button>
              ))}
            </div>
          )}

          {selectedProfile && (
            <div className="mt-4 p-4 rounded-xl bg-surface border border-theme/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] font-medium txt-head">{selectedProfile.name}</span>
                <Button size="sm" variant="secondary" onClick={() => setSelectedProfile(null)}>
                  Close
                </Button>
              </div>
              <p className="text-[12px] txt-muted mb-3">{selectedProfile.description}</p>
              <pre className="text-[11px] txt-head bg-background p-3 rounded-lg overflow-auto max-h-64">
                {JSON.stringify(selectedProfile, null, 2)}
              </pre>
            </div>
          )}
        </Card>
      </Advanced>
    </div>
  );
}
