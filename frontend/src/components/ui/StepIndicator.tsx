import { Check } from "lucide-react";

interface StepIndicatorProps {
  steps: string[];
  current: number;
}

export function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div className="flex flex-wrap gap-2 mb-6">
      {steps.map((label, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;

        return (
          <div
            key={label}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
              isActive
                ? "bg-gold/10 border-gold/30 text-gold"
                : isDone
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
                : "bg-surface border-theme/20 text-muted-foreground"
            }`}
          >
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                isActive
                  ? "bg-gold text-white"
                  : isDone
                  ? "bg-emerald-500 text-white"
                  : "bg-theme/30 text-muted-foreground"
              }`}
            >
              {isDone ? <Check className="w-3 h-3" /> : idx + 1}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
