import { type InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, leftIcon, rightIcon, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        <div className="relative">
          {leftIcon && (
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            className={`w-full rounded-xl bg-surface border text-[14px] placeholder:text-muted-foreground/50 focus:border-gold/50 focus:ring-2 focus:ring-gold/10 outline-none transition-all ${
              leftIcon ? "pl-10" : "pl-4"
            } ${rightIcon ? "pr-11" : "pr-4"} py-3 ${
              error ? "border-red-500/50 focus:border-red-500" : "border-theme/30"
            } ${className}`}
            {...props}
          />
          {rightIcon && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              {rightIcon}
            </span>
          )}
        </div>
        {error && <p className="text-[11px] text-red-400 mt-1.5">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
