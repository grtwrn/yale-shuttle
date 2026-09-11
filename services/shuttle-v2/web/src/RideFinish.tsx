import type { FC } from "react";

/** Ending the bus ride should not discard the rider's final destination. */
export const RideFinish: FC<{
  ride: { toLat?: number; toLon?: number; toText?: string };
  onDismiss: () => void;
}> = ({ ride, onDismiss }) => {
  if (!ride.toText || !Number.isFinite(ride.toLat) || !Number.isFinite(ride.toLon)) return null;
  // Omit origin so Maps starts from the rider's current location, including
  // when they deliberately end tracking before the planned exit stop.
  const href = `https://www.google.com/maps/dir/?api=1&destination=${ride.toLat},${ride.toLon}&travelmode=walking`;
  return (
    <section aria-label="Finish your trip" style={{
      width: "calc(100% - 32px)", maxWidth: 528, margin: "16px auto 8px",
      padding: 16, border: "1px solid #e0ddd8", borderRadius: 12, background: "#fff",
    }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Ride ended</div>
      <p style={{ margin: "8px 0 12px", fontSize: 14 }}>Continue to {ride.toText}</p>
      <a href={href} target="_blank" rel="noopener noreferrer" style={{
        minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px solid #1a73e8", borderRadius: 8, color: "#1a73e8",
        padding: "8px 12px", fontSize: 14, textDecoration: "none",
      }}>🚶 Walking directions · Google Maps</a>
      <button onClick={onDismiss} style={{
        minHeight: 44, marginTop: 8, width: "100%", border: "none",
        background: "transparent", color: "#546e7a", fontSize: 14, cursor: "pointer",
      }}>Dismiss</button>
    </section>
  );
};
