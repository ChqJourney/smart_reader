import React, { Component, ReactNode } from "react";
import i18n from "i18next";
import { openLogsDir } from "../services/logs";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleOpenLogs = async () => {
    try {
      await openLogsDir();
    } catch (e) {
      console.error("Failed to open logs directory:", e);
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2>{i18n.t("errorBoundary.title")}</h2>
          <p>{i18n.t("errorBoundary.description")}</p>
          {this.state.error && (
            <pre className="error-boundary-details">
              {this.state.error.toString()}
            </pre>
          )}
          <div className="error-boundary-actions">
            <button type="button" onClick={this.handleReload}>
              {i18n.t("errorBoundary.reload")}
            </button>
            <button type="button" onClick={this.handleOpenLogs}>
              {i18n.t("errorBoundary.openLogs")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
