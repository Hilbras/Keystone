import { memo } from "react";
import { Activity } from "lucide-react";
import { Alert } from "./ui/Alert.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface DataTableProps<T extends Record<string, unknown>> {
  state: DataTabState<T>;
  columns: string[];
  rows: unknown[];
  emptyMessage?: string;
  renderRowActions?: (row: Record<string, unknown>) => React.ReactNode;
}

function DataTableBase<T extends Record<string, unknown>>({
  state,
  columns,
  rows,
  emptyMessage = "No data found.",
  renderRowActions,
}: DataTableProps<T>) {
  if (state.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <Alert variant="error">
        Unable to load data: {state.error}
      </Alert>
    );
  }

  return (
    <div>
      {/* Mobile: stacked card layout */}
      <div className="sm:hidden space-y-3">
        {rows.map((row, index) => {
          const record = row as Record<string, unknown>;
          const rowKey = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : `row-${index}`;
          return (
            <div key={rowKey} className="bg-surface border border-theme/20 rounded-xl p-4 space-y-2">
              {columns.map((col) => (
                <div key={col} className="flex flex-col gap-0.5">
                  <span className="text-[11px] txt-muted font-medium uppercase tracking-wide">
                    {col}
                  </span>
                  <span className="text-[13px] txt-body break-all">
                    {formatCellValue(record[col])}
                  </span>
                </div>
              ))}
              {renderRowActions && (
                <div className="pt-2 border-t border-theme/10 flex flex-col sm:flex-row gap-2">
                  {renderRowActions(record)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop: traditional table with horizontal scroll fallback */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-theme/30">
              {columns.map((col) => (
                <th key={col} className="text-left py-2 pr-4 min-w-[120px] txt-muted font-medium uppercase tracking-wide">
                  {col}
                </th>
              ))}
              {renderRowActions && <th className="text-left py-2 pr-4 txt-muted font-medium uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const record = row as Record<string, unknown>;
              const rowKey = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : `row-${index}`;
              return (
                <tr key={rowKey} className="border-b border-theme/10 last:border-0">
                  {columns.map((col) => (
                    <td key={col} className="py-2 pr-4 min-w-[120px] txt-body break-all">
                      {formatCellValue(record[col])}
                    </td>
                  ))}
                  {renderRowActions && (
                    <td className="py-2 pr-4">
                      <div className="flex flex-col sm:flex-row gap-2">
                        {renderRowActions(record)}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-[13px] txt-muted mt-3">{emptyMessage}</p>}
    </div>
  );
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const DataTable = memo(DataTableBase) as typeof DataTableBase;
