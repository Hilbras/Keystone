import { Inbox } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  className?: string;
}

export function EmptyState({
  title = "Nothing here yet",
  description = "No items to display.",
  className = "",
}: EmptyStateProps) {
  return (
    <div className={`py-16 flex flex-col items-center gap-3 text-muted-foreground ${className}`}>
      <div className="w-12 h-12 rounded-xl bg-surface border border-theme/30 flex items-center justify-center">
        <Inbox className="w-6 h-6" />
      </div>
      <p className="text-[14px] font-medium txt-head">{title}</p>
      <p className="text-[13px] txt-muted text-center max-w-sm">{description}</p>
    </div>
  );
}
