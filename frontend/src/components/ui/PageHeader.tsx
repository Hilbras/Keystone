import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, action, className = "" }: PageHeaderProps) {
  return (
    <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 ${className}`}>
      <div>
        <h2 className="text-xl font-semibold txt-head">{title}</h2>
        {description && <p className="text-[13px] txt-muted mt-1">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
