import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "20px", color: "red", backgroundColor: "#fff", height: "100vh", overflow: "auto" }}>
          <h1>Something went wrong.</h1>
          <h3>{this.state.error?.toString()}</h3>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "11px", backgroundColor: "#f0f0f0", padding: "10px" }}>
            {this.state.errorInfo?.componentStack}
          </pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: "10px", padding: "8px 16px" }}>
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
