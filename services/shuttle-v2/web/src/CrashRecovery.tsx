import { useEffect, useRef, type CSSProperties } from "react";

const button: CSSProperties = {
  font: "inherit", fontWeight: 600, padding: "12px 18px", minHeight: 44,
  borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", color: "#1f2937",
  cursor: "pointer",
};
const summary: CSSProperties = { minHeight: 44, padding: "10px 0", boxSizing: "border-box", cursor: "pointer" };

/** Keep recovery independent of the failed map, live data and browser storage. */
export default function CrashRecovery({ error }: { error: Error }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A crash removes the app's focused control. Preserve any surviving focus
    // outside the failed tree instead of moving it after an intentional change.
    if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
  }, []);

  return (
    <main aria-labelledby="crash-heading" style={{ padding: 24, maxWidth: 520, margin: "0 auto", fontFamily: "system-ui, sans-serif", fontSize: 16, lineHeight: 1.5, color: "#1f2937", background: "#fff" }}>
      <h1 ref={heading} id="crash-heading" tabIndex={-1} style={{ fontSize: 24, lineHeight: 1.25, margin: "0 0 12px" }}>The shuttle app couldn’t open</h1>
      <p>Try reloading to get back to your trip. Reload keeps your saved data.</p>
      <button onClick={() => window.location.reload()} style={{ ...button, background: "#00356b", borderColor: "#00356b", color: "#fff" }}>Reload</button>

      <details style={{ marginTop: 24 }}>
        <summary style={summary}>Still having trouble?</summary>
        <p id="crash-reset-effects">Reset clears this app’s saved data in this browser, including saved and recent places, alerts, ride tracking and preferences.</p>
        <p id="crash-reset-reports">Your submitted reports remain, but will no longer appear in “Your reports” on this browser. The trip plan in this tab is kept.</p>
        <button aria-describedby="crash-reset-effects crash-reset-reports" onClick={() => {
          try { localStorage.clear(); } catch { /* blocked — reload is still available */ }
          window.location.reload();
        }} style={button}>Reset saved data &amp; reload</button>
      </details>

      <details style={{ marginTop: 16 }}>
        <summary style={summary}>Technical details</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, padding: 12, background: "#f3f4f6", borderRadius: 8 }}>
          {error.message}{"\n\n"}{error.stack}
        </pre>
      </details>
    </main>
  );
}
