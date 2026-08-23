import { useState } from "react";
import { Users, Save, X, Trash2, Pencil } from "lucide-react";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Select } from "./ui/Select.tsx";
import { DataTable } from "./DataTable.tsx";
import type { DataTabState } from "../Dashboard.tsx";
import type { UiMode } from "../hooks/useUiMode.ts";

interface UsersPanelProps {
  state: DataTabState<{ users: unknown[] }>;
  onRefresh: () => void;
  mode: UiMode;
}

export function UsersPanel({ state, onRefresh, mode }: UsersPanelProps) {
  const isSimple = mode === "simple";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setSuccess(null);
  };

  const startEdit = (user: Record<string, unknown>) => {
    setEditingId(String(user.id));
    setEditRole(String(user.role || "member"));
    reset();
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    reset();
    setBusy(true);
    try {
      await api.updateUser(editingId, { role: editRole });
      setSuccess("User role updated");
      setEditingId(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async (userId: string) => {
    if (!confirm("Deactivate this user? They will no longer be able to sign in.")) return;
    reset();
    setBusy(true);
    try {
      await api.deactivateUser(userId);
      setSuccess("User deactivated");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate user");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="glass" className="mt-6 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
          <Users className="w-4 h-4 text-gold" />
          Users
        </h3>
      </div>

      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      <DataTable
        state={state}
        columns={isSimple ? ["email", "name", "role"] : ["id", "email", "username", "name", "role", "emailVerified", "createdAt"]}
        rows={state.data?.users ?? []}
        emptyMessage="No users found."
        renderRowActions={
          isSimple
            ? undefined
            : (row) =>
                editingId === String(row.id) ? (
                  <form onSubmit={handleUpdate} className="flex items-center gap-2">
                    <Select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="text-[12px] py-1">
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </Select>
                    <Button type="submit" size="sm" isLoading={busy}>
                      <Save className="w-3 h-3" />
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEditingId(null)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => startEdit(row)}>
                      <Pencil className="w-3 h-3 mr-1" />
                      Role
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDeactivate(String(row.id))} disabled={busy}>
                      <Trash2 className="w-3 h-3 mr-1" />
                      Deactivate
                    </Button>
                  </div>
                )
        }
      />
    </Card>
  );
}
