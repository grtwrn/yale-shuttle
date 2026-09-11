// Every berth inset we ship, on one page: `/?review=berth`.
//
// THIS IS THE MEASURING INSTRUMENT, not a rider surface. The inset's defects
// were all of the kind you can only see by looking — a viewBox letterboxed at
// 430 px, OSM's labels clipped mid-word, a route line invisible over an orange
// road — and reaching one through the app means planning a trip that happens to
// board at that stop on that line, which is ten different trips and a live
// fleet. So the same component the card renders is rendered here for all ten
// cells at once, off the real `/api/buses` payload, and a screenshot at 390 px
// and 430 px is the before/after evidence (the sibling of `?review=minimap`).
//
// Not linked from the app.

import { useEffect, useState } from "react";

import { BerthInset } from "./BerthInset";
import { BERTHS } from "./berths";
import { ROUTE_LISTS } from "./routes";
import type { LatLon } from "./geo";

type Payload = {
  stop_names?: Record<string, string>;
  stop_coords?: Record<string, LatLon | [number, number]>;
  route_paths?: Record<string, [number, number][]>;
};

const asLatLon = (v: LatLon | [number, number] | undefined): LatLon | undefined =>
  Array.isArray(v) ? { lat: v[0], lon: v[1] } : v;

export default function BerthReview() {
  const [p, setP] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/buses").then((r) => r.json()).then(setP).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={{ padding: 16, fontFamily: "system-ui" }}>/api/buses failed: {err}</div>;
  if (!p) return <div style={{ padding: 16, fontFamily: "system-ui" }}>loading /api/buses…</div>;

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", padding: "12px 16px", maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 16, margin: "0 0 4px" }}>Berth insets — every cell in berths.ts</h1>
      <div style={{ fontSize: 12, color: "#5f6368", marginBottom: 12 }}>
        {BERTHS.length} cells · the card's own component, at this viewport's width
      </div>
      {BERTHS.map((b) => {
        const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(b.routeId));
        const name = (p.stop_names?.[String(b.stopId)] ?? `stop ${b.stopId}`).replace(/\s*\/\s*/g, "/");
        return (
          <div key={`${b.stopId}-${b.routeId}`} data-berth={`${b.stopId}-${b.routeId}`} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#202124" }}>
              {name} · {cfg?.label ?? `route ${b.routeId}`} · offset {b.offsetM} m
            </div>
            <BerthInset
              berth={b}
              published={asLatLon(p.stop_coords?.[String(b.stopId)])}
              routeLabel={cfg?.label ?? `route ${b.routeId}`}
              color={cfg?.color ?? "#5f6368"}
              stopName={name}
              path={p.route_paths?.[String(b.routeId)] ?? []}
            />
          </div>
        );
      })}
    </div>
  );
}
