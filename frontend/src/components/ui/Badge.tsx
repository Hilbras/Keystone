import { type HTMLAttributes, forwardRef } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "gold" | "success" | "warning" | "danger";
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = "default", children, className = "", ...props }, ref) => {
    const variants = {
      default: "bg-surface border-theme/20 text-muted-foreground",
      gold: "bg-gold/10 border-gold/20 text-gold",
      success: "bg-emerald-500/10 border-emerald-500/20 text-emerald-500",
      warning: "bg-amber-500/10 border-amber-500/20 text-amber-500",
      danger: "bg-red-500/10 border-red-500/20 text-red-500",
    };

    return (
      <span
        ref={ref}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold border ${variants[variant]} ${className}`}
        {...props}
      >
        {children}
      </span>
    );
  }
);

Badge.displayName = "Badge";
