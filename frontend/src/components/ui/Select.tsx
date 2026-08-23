import { type SelectHTMLAttributes, forwardRef } from "react";
import { ChevronDown } from "lucide-react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ children, error, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        <div className="relative">
          <select
            ref={ref}
            className={`w-full rounded-xl bg-surface border text-[14px] focus:border-gold/50 focus:ring-2 focus:ring-gold/10 outline-none transition-all appearance-none pl-4 pr-10 py-3 ${
              error ? "border-red-500/50 focus:border-red-500" : "border-theme/30"
            } ${className}`}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        </div>
        {error && <p className="text-[11px] text-red-400 mt-1.5">{error}</p>}
      </div>
    );
  }
);

Select.displayName = "Select";
