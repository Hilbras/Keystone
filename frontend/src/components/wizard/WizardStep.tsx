import type { ReactNode } from "react";
import { Button } from "../ui/Button.tsx";
import { Alert } from "../ui/Alert.tsx";

interface WizardStepProps {
  title?: string;
  description?: string;
  children: ReactNode;
  error?: string | null;
  success?: string | null;
  primaryAction?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
    disabled?: boolean;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function WizardStep({
  title,
  description,
  children,
  error,
  success,
  primaryAction,
  secondaryAction,
  className = "",
}: WizardStepProps) {
  return (
    <div className={`space-y-4 ${className}`}>
      {title && <p className="text-[13px] txt-muted">{description || title}</p>}
      {error && (
        <Alert variant="error" className="mb-2">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mb-2">
          {success}
        </Alert>
      )}
      {children}
      <div className="flex flex-col sm:flex-row gap-2 pt-2">
        {primaryAction && (
          <Button
            onClick={primaryAction.onClick}
            isLoading={primaryAction.loading}
            disabled={primaryAction.disabled}
            className="w-full sm:w-auto"
          >
            {primaryAction.label}
          </Button>
        )}
        {secondaryAction && (
          <Button variant="secondary" onClick={secondaryAction.onClick} className="w-full sm:w-auto">
            {secondaryAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}
