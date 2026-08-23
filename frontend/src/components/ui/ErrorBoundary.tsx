import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Card } from "./Card.tsx";
import { Button } from "./Button.tsx";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Keystone UI error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
          <Card variant="glass" className="w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h1 className="text-[16px] font-semibold txt-head">Something went wrong</h1>
                <p className="text-[12px] txt-muted">The dashboard encountered an unexpected error.</p>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-surface border border-theme/20 mb-4">
              <p className="text-[12px] txt-muted font-mono break-words">
                {this.state.error?.message || "Unknown error"}
              </p>
            </div>
            <Button onClick={() => window.location.reload()} className="w-full">
              <RotateCcw className="w-4 h-4" />
              Reload page
            </Button>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
