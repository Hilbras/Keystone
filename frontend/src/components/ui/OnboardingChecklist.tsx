import { CheckCircle2, X } from "lucide-react";
import { Card } from "./Card.tsx";
import { Button } from "./Button.tsx";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  onClick: () => void;
}

interface OnboardingChecklistProps {
  items: ChecklistItem[];
  onDismiss: () => void;
  className?: string;
}

export function OnboardingChecklist({ items, onDismiss, className = "" }: OnboardingChecklistProps) {
  const completed = items.filter((i) => i.done).length;
  const progress = items.length > 0 ? Math.round((completed / items.length) * 100) : 0;

  return (
    <Card variant="glass" className={`p-4 sm:p-5 ${className}`}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-[14px] font-semibold txt-head">Welcome to Keystone</h3>
          <p className="text-[12px] txt-muted mt-0.5">
            Complete these steps to get your identity platform running.
          </p>
        </div>
        <Button size="icon" variant="ghost" onClick={onDismiss} aria-label="Dismiss checklist" className="shrink-0">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden mb-4 border border-theme/20">
        <div
          className="h-full bg-gold transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={item.onClick}
            className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-colors ${
              item.done ? "bg-surface/50" : "bg-surface hover:bg-gold/5"
            }`}
          >
            <CheckCircle2
              className={`w-5 h-5 shrink-0 ${item.done ? "text-emerald-500" : "text-zinc-400"}`}
            />
            <span className={`text-[13px] ${item.done ? "txt-muted line-through" : "txt-body"}`}>
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
