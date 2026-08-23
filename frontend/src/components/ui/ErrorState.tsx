import { AlertCircle } from "lucide-react";
import { Alert } from "./Alert.tsx";

interface ErrorStateProps {
  title?: string;
  message: string;
  className?: string;
}

export function ErrorState({ title = "Error", message, className = "" }: ErrorStateProps) {
  return (
    <div className={className}>
      <Alert variant="error">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{title}</p>
            <p className="text-[13px] opacity-90">{message}</p>
          </div>
        </div>
      </Alert>
    </div>
  );
}
