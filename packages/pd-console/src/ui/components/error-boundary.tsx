import { Component, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import i18n from "../i18n/index.js";
import { Card, CardContent } from "./ui/card.js";
import { Button } from "./ui/button.js";
import { AlertCircle, MessageSquare } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
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

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <ErrorBoundaryCard
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function ErrorBoundaryCard({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const reportHref = `/report-problem?source=${encodeURIComponent("error")}&message=${encodeURIComponent(
    error?.message ?? "",
  )}&from=${encodeURIComponent(location.pathname + location.search)}`;
  return (
    <Card className="border-destructive/50">
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <h3 className="font-semibold text-destructive">
            {i18n.t("components:errorBoundary.title")}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {error?.message ?? i18n.t("components:errorBoundary.description")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onRetry}>
            {i18n.t("components:errorBoundary.retry")}
          </Button>
          <Button variant="ghost" onClick={() => navigate(reportHref)}>
            <MessageSquare className="h-4 w-4 mr-2" />
            {i18n.t("components:errorBoundary.reportAction")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
