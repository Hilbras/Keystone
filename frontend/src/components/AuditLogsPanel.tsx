import { useState } from "react";
import { ScrollText, Search, Download } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import { DataTable } from "./DataTable.tsx";
import { api } from "../api.ts";
import { useToastContext } from "./ui/ToastProvider.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface AuditLogsPanelProps {
  state: DataTabState<{ logs: unknown[] }>;
  onRefresh: (event?: string) => void;
}

export function AuditLogsPanel({ state, onRefresh }: AuditLogsPanelProps) {
  const { addToast } = useToastContext();
  const [event, setEvent] = useState("");
  const [exporting, setExporting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRefresh(event);
  };

  const handleClear = () => {
    setEvent("");
    onRefresh();
  };

  const doExport = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      await api.downloadAuditExport(event || undefined, format);
      addToast(`${format.toUpperCase()} export started`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card variant="glass" className="mt-6 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-gold" />
          Audit Logs
        </h3>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => doExport("csv")} disabled={exporting}>
            <Download className="w-3 h-3" />
            CSV
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => doExport("json")} disabled={exporting}>
            <Download className="w-3 h-3" />
            JSON
          </Button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-[12px]">Filter by event</Label>
          <Input
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            placeholder="e.g. user.login"
            className="w-64"
          />
        </div>
        <Button type="submit" size="sm">
          <Search className="w-3 h-3" />
          Filter
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={handleClear}>
          Clear
        </Button>
      </form>

      <DataTable
        state={state}
        columns={["id", "event", "userId", "orgId", "createdAt"]}
        rows={state.data?.logs ?? []}
        emptyMessage="No audit logs found."
      />
    </Card>
  );
}
