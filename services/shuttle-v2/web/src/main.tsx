import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import TransitMap from "./TransitMap";
import MinimapReview from "./MinimapReview";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React crash:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", fontSize: 14 }}>
          <b style={{ color: "red" }}>App crashed</b>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const params = new URLSearchParams(window.location.search);
const Page = params.get("review") === "minimap" ? MinimapReview : TransitMap;

// Installable-app support. Registered after load so it never competes with the
// first paint; failures are silently ignored — the app works identically
// without it, the SW only adds the offline shell and installability.
// Installed-app pull-to-refresh: standalone mode has no browser chrome, so
// Safari's native gesture is gone. No-op in a normal tab.
import("./pullToRefresh").then((m) => m.installPullToRefresh()).catch(() => {});

if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Page />
    </ErrorBoundary>
  </StrictMode>
);
