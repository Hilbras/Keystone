import type { InputHTMLAttributes } from "react";

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
}

export function Switch({ label, description, className = "", ...props }: SwitchProps) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer ${className}`}>
      <div className="relative inline-flex h-5 w-9 shrink-0">
        <input type="checkbox" className="peer sr-only" {...props} />
        <span
          className="absolute inset-0 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-gold"
          aria-hidden="true"
        />
        <span
          className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4"
          aria-hidden="true"
        />
      </div>
      <div>
        {label && <span className="text-[13px] font-medium txt-head">{label}</span>}
        {description && <p className="text-[12px] txt-muted">{description}</p>}
      </div>
    </label>
  );
}
