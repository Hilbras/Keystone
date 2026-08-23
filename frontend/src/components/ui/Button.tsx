import { type ButtonHTMLAttributes, forwardRef } from "react";
import { Loader2 } from "lucide-react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", isLoading, children, className = "", disabled, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:pointer-events-none";

    const variants = {
      primary:
        "bg-gold text-white hover:bg-gold-light shadow-sm shadow-gold/10",
      secondary:
        "bg-surface border border-theme/30 text-foreground hover:border-gold/40 hover:text-gold",
      ghost:
        "text-muted-foreground hover:text-foreground hover:bg-surface",
      danger:
        "bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20",
    };

    const sizes = {
      sm: "px-3 py-1.5 text-[12px]",
      md: "px-4 py-2.5 text-[13px]",
      lg: "px-6 py-3.5 text-[14px]",
      icon: "w-9 h-9 p-0",
    };

    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
