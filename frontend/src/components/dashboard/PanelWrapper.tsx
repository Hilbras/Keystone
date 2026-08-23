import type { ReactNode } from "react";
import { LoadingState } from "../ui/LoadingState.tsx";
import { ErrorState } from "../ui/ErrorState.tsx";

interface PanelWrapperProps<T> {
  state: { data: T | null; loading: boolean; error: string | null };
  loadingMessage?: string;
  errorTitle?: string;
  empty?: boolean;
  emptyContent?: ReactNode;
  children: ReactNode;
}

export function PanelWrapper<T>({
  state,
  loadingMessage,
  errorTitle,
  empty,
  emptyContent,
  children,
}: PanelWrapperProps<T>) {
  if (state.loading) {
    return <LoadingState message={loadingMessage} />;
  }

  if (state.error) {
    return <ErrorState title={errorTitle} message={state.error} className="mt-6" />;
  }

  if (empty && emptyContent) {
    return <>{emptyContent}</>;
  }

  return <div className="animate-slide-up">{children}</div>;
}
