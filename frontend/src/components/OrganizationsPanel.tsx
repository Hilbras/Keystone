import { useState } from "react";
import { Building2, Plus, Save, X } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import { DataTable } from "./DataTable.tsx";
import { Advanced } from "./ui/Advanced.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { useUiMode } from "../hooks/useUiMode.ts";
import type { DataTabState } from "../Dashboard.tsx";

interface OrganizationsPanelProps {
  state: DataTabState<{ organizations: unknown[] }>;
  onRefresh: () => void;
}

export function OrganizationsPanel({ state, onRefresh }: OrganizationsPanelProps) {
  const { mode } = useUiMode();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setBusy(true);
    try {
      await api.createOrganization({ name, slug: slug || undefined });
      setSuccess("Organization created");
      setName("");
      setSlug("");
      setShowForm(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="glass" className="mt-6 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
          <Building2 className="w-4 h-4 text-gold" />
          Organizations
        </h3>
        <Button size="sm" onClick={() => setShowForm((s) => !s)}>
          <Plus className="w-4 h-4" />
          {showForm ? "Cancel" : "Create"}
        </Button>
      </div>

      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-5 p-3 sm:p-4 rounded-xl bg-surface border border-theme/20 space-y-3">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required />
          </div>
          <Advanced mode={mode}>
            <FieldHelp
              label="Slug (optional)"
              help="A short, URL-friendly identifier for the organization. If left empty, Keystone will generate one from the name."
              example="acme-corp"
            >
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-corp" />
            </FieldHelp>
          </Advanced>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button type="submit" size="sm" isLoading={busy} disabled={!name}>
              <Save className="w-4 h-4" />
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setShowForm(false)}>
              <X className="w-4 h-4" />
              Cancel
            </Button>
          </div>
        </form>
      )}

      <DataTable
        state={state}
        columns={mode === "simple" ? ["name"] : ["id", "name", "slug", "plan", "createdAt"]}
        rows={state.data?.organizations ?? []}
        emptyMessage="No organizations found."
      />
    </Card>
  );
}
