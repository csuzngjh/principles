import { Component, type ReactNode } from "react";
import { COLORS } from "../styles/constants.js";

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

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          style={{
            padding: "24px",
            textAlign: "center",
            color: COLORS.danger,
            backgroundColor: "#fff2f0",
            borderRadius: "8px",
            border: "1px solid #ffccc7",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
            Something went wrong
          </div>
          <div style={{ fontSize: "13px", color: "#666" }}>
            {this.state.error?.message ?? "An unexpected error occurred"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: "12px",
              border: "1px solid #d9d9d9",
              borderRadius: "6px",
              padding: "6px 16px",
              fontSize: "13px",
              cursor: "pointer",
              backgroundColor: "#fff",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
