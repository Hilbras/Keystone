import { useState } from "react";
import { Key, RefreshCw } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Badge } from "./ui/Badge.tsx";
import { DataTable } from "./DataTable.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface KeysPanelProps {
  state: DataTabState<{ keys: Array<{ keyId: string; createdAt: string; expiresAt?: string | null }>; provider: string }>;
  onRefresh: () => void;
}

export function KeysPanel({ state, onRefresh }: KeysPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const rotate = async () => {
    if (!confirm("Rotate the active JWT signing key? Tokens signed with the old key will remain valid during the grace period.")) return;
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const result = await api.rotateSigningKey();
      setSuccess(`New key active: ${result.keyId}`);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="glass" className="mt-6 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
          <Key className="w-4 h-4 text-gold" />
          Signing Keys
        </h3>
        <div className="flex items-center gap-3">
          {state.data && (
            <Badge variant="default">Provider: {state.data.provider}</Badge>
          )}
          <Button size="sm" onClick={rotate} isLoading={busy}>
            <RefreshCw className="w-4 h-4" />
            Rotate
          </Button>
        </div>
      </div>

      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      <DataTable
        state={state}
        columns={["keyId", "createdAt", "expiresAt"]}
        rows={state.data?.keys ?? []}
        emptyMessage="No signing keys found."
      />

      <div className="mt-4 p-3 rounded-xl bg-surface border border-theme/20">
        <p className="text-[12px] txt-muted">
          The active signing key is used to issue new JWT access tokens. Older keys remain valid for
          verification until they expire. Choose the secrets provider via{" "}
          <code className="font-mono text-gold">KEYSTONE_SECRETS_PROVIDER</code> (database, environment,
          vault, aws-kms).
        </p>
      </div>
    </Card>
  );
}
