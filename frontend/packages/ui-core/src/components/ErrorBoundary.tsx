import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleX, RotateCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundaryBase extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Panel render failed", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <ErrorFallback error={this.state.error} onReset={this.reset} />
    );
  }
}

function ErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-chat p-6 text-center">
      <CircleX className="h-8 w-8 text-danger" />
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold text-text">{t("common.panelErrorTitle")}</h2>
        <p className="max-w-[480px] truncate text-[12px] text-muted" title={error.message}>
          {error.message}
        </p>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t("common.retry")}
      </button>
    </div>
  );
}

export function ErrorBoundary({ children }: ErrorBoundaryProps) {
  return <ErrorBoundaryBase>{children}</ErrorBoundaryBase>;
}
