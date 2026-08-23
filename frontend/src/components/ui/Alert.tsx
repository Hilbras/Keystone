import { type HTMLAttributes, forwardRef } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "info" | "success" | "error";
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ children, variant = "info", className = "", ...props }, ref) => {
    const variants = {
      info: "bg-gold/10 border-gold/20 text-gold",
      success: "bg-emerald-500/10 border-emerald-500/20 text-emerald-500",
      error: "bg-red-500/10 border-red-500/20 text-red-500",
    };

    const icons = {
      info: <Info className="w-4 h-4 shrink-0" />,
      success: <CheckCircle2 className="w-4 h-4 shrink-0" />,
      error: <AlertCircle className="w-4 h-4 shrink-0" />,
    };

    return (
      <div
        ref={ref}
        className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] ${variants[variant]} ${className}`}
        {...props}
      >
        {icons[variant]}
        <div className="flex-1">{children}</div>
      </div>
    );
  }
);

Alert.displayName = "Alert";
