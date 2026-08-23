import { memo, type ReactNode } from "react";

interface AdvancedProps {
  mode: "simple" | "advanced";
  children: ReactNode;
  className?: string;
}

function AdvancedBase({ mode, children, className = "" }: AdvancedProps) {
  if (mode === "simple") return null;
  return <div className={className}>{children}</div>;
}

export const Advanced = memo(AdvancedBase);
