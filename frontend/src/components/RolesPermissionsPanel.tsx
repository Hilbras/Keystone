import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, Plus, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Badge } from "./ui/Badge.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";
import { EmptyState } from "./ui/EmptyState.tsx";
import { useToastContext } from "./ui/ToastProvider.tsx";

interface Permission {
  id: string;
  resource: string;
  action: string;
  description: string | null;
}

const PROTECTED_ROLES = new Set(["owner"]);

export function RolesPermissionsPanel() {
  const { addToast } = useToastContext();
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>("admin");
  const [rolePermissionIds, setRolePermissionIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");
  const [description, setDescription] = useState("");
  const [newRole, setNewRole] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [perms, roleList] = await Promise.all([api.getPermissions(), api.getRoles()]);
      setPermissions(perms.permissions);
      setRoles(roleList.roles);
      if (!roleList.roles.includes(selectedRole) && roleList.roles.length > 0) {
        setSelectedRole(roleList.roles[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load permissions");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedRole) return;
    api
      .getRolePermissions(selectedRole)
      .then((data) => setRolePermissionIds(new Set(data.permissions.map((p) => p.id))))
      .catch(() => setRolePermissionIds(new Set()));
  }, [selectedRole]);

  const grouped = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const p of permissions) {
      const list = map.get(p.resource) ?? [];
      list.push(p);
      map.set(p.resource, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  const createPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createPermission({
        resource: resource.trim(),
        action: action.trim(),
        description: description.trim() || undefined,
      });
      setResource("");
      setAction("");
      setDescription("");
      setShowForm(false);
      addToast("Permission created", "success");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create permission");
    } finally {
      setBusy(false);
    }
  };

  const removePermission = async (id: string, key: string) => {
    if (!window.confirm(`Delete permission "${key}"? It will be removed from all roles.`)) return;
    try {
      await api.deletePermission(id);
      addToast("Permission deleted", "success");
      await load();
      if (selectedRole) {
        const data = await api.getRolePermissions(selectedRole);
        setRolePermissionIds(new Set(data.permissions.map((p) => p.id)));
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete permission", "error");
    }
  };

  const toggle = async (permissionId: string) => {
    if (PROTECTED_ROLES.has(selectedRole)) {
      addToast("The owner role always has every permission", "error");
      return;
    }
    const assigned = rolePermissionIds.has(permissionId);
    // Optimistic update
    setRolePermissionIds((prev) => {
      const next = new Set(prev);
      if (assigned) next.delete(permissionId);
      else next.add(permissionId);
      return next;
    });
    try {
      if (assigned) await api.removeRolePermission(selectedRole, permissionId);
      else await api.assignRolePermission(selectedRole, permissionId);
    } catch (err) {
      // Revert on failure
      setRolePermissionIds((prev) => {
        const next = new Set(prev);
        if (assigned) next.add(permissionId);
        else next.delete(permissionId);
        return next;
      });
      addToast(err instanceof Error ? err.message : "Failed to update role", "error");
    }
  };

  const addCustomRole = (e: React.FormEvent) => {
    e.preventDefault();
    const role = newRole.trim().toLowerCase();
    if (!role) return;
    if (!roles.includes(role)) setRoles((prev) => [...prev, role].sort());
    setSelectedRole(role);
    setNewRole("");
    addToast(`Role "${role}" ready — assign permissions below, then use it when inviting members.`, "success");
  };

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4 mt-6">
      {error && <Alert variant="error">{error}</Alert>}

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-gold" />
            Roles
          </span>
        }
        description="Select a role to edit its permissions. Custom roles can be used when inviting organization members."
      >
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {roles.map((role) => (
            <button
              key={role}
              onClick={() => setSelectedRole(role)}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                selectedRole === role
                  ? "bg-gold/15 border-gold/40 text-gold"
                  : "border-theme/30 txt-muted hover:txt-head"
              }`}
            >
              {role}
              {PROTECTED_ROLES.has(role) && <span className="ml-1 opacity-60">(all)</span>}
            </button>
          ))}
        </div>
        <form onSubmit={addCustomRole} className="flex flex-wrap items-end gap-2">
          <FieldHelp label="New custom role" help="Type a role name (e.g. support, billing-manager) and assign it any combination of permissions.">
            <Input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="e.g. support" className="w-48" />
          </FieldHelp>
          <Button type="submit" size="sm" variant="secondary" disabled={!newRole.trim()}>
            <Plus className="w-3 h-3" />
            Add role
          </Button>
        </form>
      </SectionCard>

      <SectionCard
        title={`Permissions for "${selectedRole}"`}
        description={
          PROTECTED_ROLES.has(selectedRole)
            ? "The owner role always has every permission and cannot be edited."
            : "Toggle permissions for this role. Changes apply immediately."
        }
        action={
          <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
            <Plus className="w-3 h-3" />
            New permission
          </Button>
        }
      >
        {showForm && (
          <form onSubmit={createPermission} className="mb-4 p-3 rounded-lg border border-theme/30 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <FieldHelp label="Resource" help="The thing being protected, lowercase snake_case." example="billing">
                <Input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="billing" required />
              </FieldHelp>
              <FieldHelp label="Action" help="What can be done with the resource." example="refund">
                <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="refund" required />
              </FieldHelp>
              <FieldHelp label="Description" help="Optional human-readable explanation.">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Issue refunds" />
              </FieldHelp>
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              Create permission
            </Button>
          </form>
        )}

        {grouped.length === 0 ? (
          <EmptyState title="No permissions" description="Create your first permission to build a custom role." />
        ) : (
          <div className="space-y-4">
            {grouped.map(([res, perms]) => (
              <div key={res}>
                <p className="text-[11px] uppercase tracking-wide txt-muted mb-2">{res}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {perms.map((p) => {
                    const assigned = PROTECTED_ROLES.has(selectedRole) || rolePermissionIds.has(p.id);
                    return (
                      <div
                        key={p.id}
                        className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                          assigned ? "border-gold/40 bg-gold/5" : "border-theme/30"
                        }`}
                      >
                        <label className="flex items-center gap-2 cursor-pointer min-w-0">
                          <input
                            type="checkbox"
                            checked={assigned}
                            disabled={PROTECTED_ROLES.has(selectedRole)}
                            onChange={() => toggle(p.id)}
                            className="accent-[#c9a227] shrink-0"
                          />
                          <span className="text-[12px] txt-head truncate">
                            {p.resource}:{p.action}
                          </span>
                          {p.description && (
                            <span className="text-[11px] txt-muted truncate hidden sm:inline">{p.description}</span>
                          )}
                        </label>
                        <button
                          onClick={() => removePermission(p.id, `${p.resource}:${p.action}`)}
                          className="txt-muted hover:text-red-400 transition-colors shrink-0"
                          title="Delete permission"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Badge variant="default">{permissions.length} permissions</Badge>
          <Badge variant="gold">{roles.length} roles</Badge>
        </div>
      </SectionCard>
    </div>
  );
}
