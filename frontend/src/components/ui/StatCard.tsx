import type { ReactNode } from "react";
import { Card } from "./Card.tsx";

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
  className?: string;
}

export function StatCard({ label, value, icon, iconClassName = "", className = "" }: StatCardProps) {
  return (
    <Card variant="glass" className={`p-5 flex items-start gap-4 ${className}`}>
      {icon && (
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconClassName}`}>
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[12px] txt-muted uppercase tracking-wide font-semibold">{label}</p>
        <div className="text-[13px] txt-head font-medium break-all mt-0.5">{value}</div>
      </div>
    </Card>
  );
}
