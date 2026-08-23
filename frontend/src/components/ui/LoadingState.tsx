import { Loader2 } from "lucide-react";

interface LoadingStateProps {
  message?: string;
  className?: string;
}

export function LoadingState({ message = "Loading…", className = "" }: LoadingStateProps) {
  return (
    <div className={`py-20 flex flex-col items-center gap-3 text-muted-foreground ${className}`}>
      <Loader2 className="w-8 h-8 animate-spin text-gold" />
      <p className="text-[14px]">{message}</p>
    </div>
  );
}
