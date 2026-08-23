import { useState } from "react";
import { Activity, Workflow, Plus, Trash2, Play, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import { Badge } from "./ui/Badge.tsx";
import { ConfirmDialog } from "./ui/ConfirmDialog.tsx";
import { useToastContext } from "./ui/ToastProvider.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface WorkflowItem {
  id: string;
  name: string;
  trigger: string;
  definition: { steps: Array<{ type: string; name?: string }> };
  isActive: boolean;
  createdAt: string;
}

interface WorkflowRun {
  id: string;
  status: string;
  triggerEvent: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: Array<{ step: string; status: string; error?: string }>;
}

interface WorkflowPanelProps {
  workflowsState: DataTabState<{ workflows: WorkflowItem[] }>;
  runsState: DataTabState<{ runs: WorkflowRun[] }>;
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  onRefresh: () => void;
  onCreate: (input: { name: string; trigger: string; definition: { steps: Array<{ type: string; name?: string }> } }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLoadRuns: (id: string) => Promise<void>;
}

const TRIGGERS = ["user_registered", "user_login", "organization_created"];
const STEP_TYPES = ["assign_role", "create_organization", "send_email", "webhook"];

export function WorkflowPanel({
  workflowsState,
  runsState,
  selectedWorkflowId,
  onSelectWorkflow,
  onRefresh,
  onCreate,
  onDelete,
  onLoadRuns,
}: WorkflowPanelProps) {
  const [newName, setNewName] = useState("");
  const [newTrigger, setNewTrigger] = useState(TRIGGERS[0]);
  const [newSteps, setNewSteps] = useState<Array<{ type: string; name?: string }>>([{ type: "assign_role", name: "assign_default_role" }]);
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const { addToast } = useToastContext();

  if (workflowsState.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading workflows…</p>
      </div>
    );
  }

  if (workflowsState.error) {
    return (
      <Alert variant="error" className="mt-6">
        Unable to load workflows: {workflowsState.error}
      </Alert>
    );
  }

  const workflows = workflowsState.data?.workflows ?? [];
  const runs = runsState.data?.runs ?? [];

  return (
    <div className="mt-6 space-y-4">
      <Card variant="glass" className="p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <Workflow className="w-4 h-4 text-gold" />
            Workflows
          </h3>
          <Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={onRefresh}>
            Refresh
          </Button>
        </div>

        {workflows.length === 0 ? (
          <p className="text-[13px] txt-muted">No workflows configured.</p>
        ) : (
          <div className="space-y-2 mb-4">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                className={`p-3 rounded-xl border border-theme/20 bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${selectedWorkflowId === wf.id ? "border-gold/50" : ""}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium txt-head">{wf.name}</span>
                    <Badge variant={wf.isActive ? "success" : "default"}>{wf.isActive ? "Active" : "Inactive"}</Badge>
                    <Badge variant="default">{wf.trigger}</Badge>
                  </div>
                  <p className="text-[11px] txt-muted mt-1">{wf.definition.steps.length} step(s)</p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 shrink-0 w-full sm:w-auto">
                  <Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={() => { onSelectWorkflow(wf.id); onLoadRuns(wf.id); }}>
                    <Play className="w-4 h-4" />
                    Runs
                  </Button>
                  <Button size="sm" variant="danger" className="w-full sm:w-auto" onClick={() => setConfirmDeleteId(wf.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {selectedWorkflowId && (
        <Card variant="glass" className="p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h3 className="text-[14px] font-semibold txt-head">Workflow Runs</h3>
            <Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={() => onSelectWorkflow(null)}>
              Close
            </Button>
          </div>
          {runsState.loading ? (
            <p className="text-[13px] txt-muted">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="text-[13px] txt-muted">No runs yet.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div key={run.id} className="p-3 rounded-xl border border-theme/20 bg-surface">
                  <button
                    className="w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-left"
                    onClick={() => setExpandedRuns(expandedRuns === run.id ? null : run.id)}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {expandedRuns === run.id ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                      <span className="text-[13px] txt-head">{run.triggerEvent}</span>
                      <Badge variant={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "default"}>{run.status}</Badge>
                    </div>
                    <span className="text-[11px] txt-muted shrink-0">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</span>
                  </button>
                  {expandedRuns === run.id && (
                    <div className="mt-2 pl-6 space-y-1">
                      {run.log.map((entry, idx) => (
                        <div key={idx} className="text-[12px] txt-muted flex items-center gap-2">
                          <span className={entry.status === "ok" ? "text-emerald-500" : "text-red-500"}>●</span>
                          {entry.step}
                          {entry.error && <span className="text-red-500">({entry.error})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card variant="glass" className="p-5">
        <h3 className="text-[14px] font-semibold txt-head mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4 text-gold" />
          Create Workflow
        </h3>
        <div className="space-y-4">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Welcome flow" />
          </div>
          <div>
            <Label className="text-[12px]">Trigger</Label>
            <select
              className="w-full bg-surface border border-theme/30 rounded-lg px-3 py-2 text-[13px] txt-head"
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value)}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[12px]">Steps</Label>
            <div className="space-y-2">
              {newSteps.map((step, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
                  <select
                    className="w-full bg-surface border border-theme/30 rounded-lg px-3 py-2 text-[13px] txt-head"
                    value={step.type}
                    onChange={(e) => {
                      const updated = [...newSteps];
                      updated[idx] = { ...updated[idx], type: e.target.value };
                      setNewSteps(updated);
                    }}
                  >
                    {STEP_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <Input
                    placeholder="step name (optional)"
                    value={step.name || ""}
                    onChange={(e) => {
                      const updated = [...newSteps];
                      updated[idx] = { ...updated[idx], name: e.target.value };
                      setNewSteps(updated);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full md:w-auto"
                    onClick={() => setNewSteps(newSteps.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button size="sm" variant="secondary" className="mt-2 w-full sm:w-auto" onClick={() => setNewSteps([...newSteps, { type: STEP_TYPES[0] }])}>
              Add Step
            </Button>
          </div>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => {
              onCreate({ name: newName, trigger: newTrigger, definition: { steps: newSteps } });
              setNewName("");
              setNewSteps([{ type: STEP_TYPES[0] }]);
            }}
            disabled={!newName.trim() || newSteps.length === 0}
          >
            Create Workflow
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        isOpen={confirmDeleteId !== null}
        title="Delete workflow"
        message="This workflow and its run history will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDeleteId) {
            onDelete(confirmDeleteId);
            addToast("Workflow deleted", "success");
          }
          setConfirmDeleteId(null);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
