import { useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

interface TooltipProps {
  content: ReactNode;
  children?: ReactNode;
  icon?: boolean;
}

export function Tooltip({ content, children, icon = false }: TooltipProps) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {icon && <HelpCircle className="w-3.5 h-3.5 text-muted-foreground hover:text-gold cursor-help ml-1" />}
      {open && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-56 px-3 py-2 rounded-xl bg-popover text-popover-foreground text-[11px] leading-relaxed shadow-lg border border-theme/30">
          {content}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-popover" />
        </span>
      )}
    </span>
  );
}
