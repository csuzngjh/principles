import { Component, type ReactNode } from "react";
import i18n from "../i18n/index.js";
import { Card, CardContent } from "./ui/card.js";
import { Button } from "./ui/button.js";
import { AlertCircle } from "lucide-react";

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
        <Card className="border-destructive/50">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <h3 className="font-semibold text-destructive">
                {i18n.t("components:errorBoundary.title")}
              </h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {this.state.error?.message ?? i18n.t("components:errorBoundary.description")}
            </p>
            <Button
              variant="outline"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              {i18n.t("components:errorBoundary.retry")}
            </Button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}
