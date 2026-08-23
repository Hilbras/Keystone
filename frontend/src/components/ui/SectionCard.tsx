import type { ReactNode } from "react";
import { Card } from "./Card.tsx";

interface SectionCardProps {
  title?: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({ title, description, action, children, className = "" }: SectionCardProps) {
  return (
    <Card variant="glass" className={`p-4 sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 mb-3 sm:mb-4">
          <div>
            {title && <h3 className="text-[14px] font-semibold txt-head">{title}</h3>}
            {description && <p className="text-[12px] txt-muted mt-0.5">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </Card>
  );
}
