import { Sparkles, SlidersHorizontal } from "lucide-react";
import type { UiMode } from "../../hooks/useUiMode.ts";

interface ModeToggleProps {
  mode: UiMode;
  onChange: (mode: UiMode) => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="flex items-center p-1 bg-surface border border-theme/30 rounded-xl">
      <button
        type="button"
        onClick={() => onChange("simple")}
        className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
          mode === "simple"
            ? "bg-gold text-white shadow-sm shadow-gold/10"
            : "text-muted-foreground hover:text-foreground"
        }`}
        aria-pressed={mode === "simple"}
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Simple</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("advanced")}
        className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
          mode === "advanced"
            ? "bg-gold text-white shadow-sm shadow-gold/10"
            : "text-muted-foreground hover:text-foreground"
        }`}
        aria-pressed={mode === "advanced"}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Advanced</span>
      </button>
    </div>
  );
}
