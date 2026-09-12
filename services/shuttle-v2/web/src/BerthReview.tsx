// Every berth map we ship, one at a time: `/?review=berth`.
//
// THIS IS THE MEASURING INSTRUMENT, not a rider surface. The inset's defects
// were all of the kind you can only see by looking — a viewBox letterboxed at
// 430 px, OSM's labels clipped mid-word, a route line invisible over an orange
// road — and reaching one through the app means planning a trip that happens to
// board at that stop on that line, which is ten different trips and a live
// fleet. So the same component the card renders is rendered here, off the real
// `/api/buses` payload, and a screenshot at 390 px is the before/after evidence
// (the sibling of `?review=minimap`).
//
// It renders the card's whole berth block — `BerthDisclosure`, i.e. the
// Directions button, the ⚠ toggle beside it and whatever that reveals — and not
// `BerthInset` alone, because since 2026-09-11 the folded row is what a rider
// meets first and a preview of the open state only would measure a screen the
// app no longer has.
//
// It also carries a Collapse/Expand button, which the rider's card does not
// need one of: in the app the block is mounted and unmounted by `expandedKey`,
// and the only way to watch a Leaflet TEARDOWN from outside is to make that
// lifecycle drivable. `scripts/berth-teardown-check.mjs` uses it to prove the
// map really goes — no container left in the DOM, no tile requests afterwards,
// no console error — and that a second expand leaves exactly one, not two.
//
// ONE CELL AT A TIME, since 2026-09-11. This page used to stack all ten at
// once, which was free when each was an SVG and is not now that each is a live
// Leaflet map: ten instances on one page is the very thing `routeThumb.ts`
// refuses, and it would also measure something the app never renders — the app
// shows exactly one, inside the one expanded card. `?cell=<stopId>-<routeId>`
// picks one directly, which is how the screenshots are taken.
//
// Not linked from the app.

import { useEffect, useState } from "react";

import { BerthDisclosure } from "./BerthDisclosure";
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

const keyOf = (b: { stopId: number; routeId: number }) => `${b.stopId}-${b.routeId}`;

export default function BerthReview() {
  const [p, setP] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState(() => {
    const want = new URLSearchParams(window.location.search).get("cell");
    return BERTHS.some((b) => keyOf(b) === want) ? want! : keyOf(BERTHS[0]);
  });
  useEffect(() => {
    fetch("/api/buses").then((r) => r.json()).then(setP).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={{ padding: 16, fontFamily: "system-ui" }}>/api/buses failed: {err}</div>;
  if (!p) return <div style={{ padding: 16, fontFamily: "system-ui" }}>loading /api/buses…</div>;

  const b = BERTHS.find((x) => keyOf(x) === pick)!;
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(b.routeId));
  const name = (p.stop_names?.[String(b.stopId)] ?? `stop ${b.stopId}`).replace(/\s*\/\s*/g, "/");

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", padding: "12px 16px", maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 16, margin: "0 0 4px" }}>Berth map — one cell, as the card renders it</h1>
      <div style={{ fontSize: 12, color: "#5f6368", marginBottom: 8 }}>
        {BERTHS.length} cells in berths.ts · one live map at a time, as in the app
      </div>
      {/* A row of cells rather than a <select>: a screenshot has to be able to
          reach any of them, and ?cell= does it without a click. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {BERTHS.map((x) => {
          const c = ROUTE_LISTS.find((r) => r.busRouteIds.includes(x.routeId));
          const on = keyOf(x) === pick;
          return (
            <button key={keyOf(x)} data-cell={keyOf(x)} onClick={() => setPick(keyOf(x))}
              style={{
                fontSize: 11, padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                border: `1px solid ${on ? (c?.color ?? "#5f6368") : "#dadce0"}`,
                background: on ? (c?.color ?? "#5f6368") : "#fff",
                color: on ? "#fff" : "#3c4043", fontFamily: "inherit",
              }}>
              {(p.stop_names?.[String(x.stopId)] ?? `stop ${x.stopId}`).replace(/\s*\/\s*/g, "/")}
            </button>
          );
        })}
      </div>
      <div data-berth={keyOf(b)}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#202124" }}>
          {name} · {cfg?.label ?? `route ${b.routeId}`} · offset {b.offsetM} m
        </div>
        {/* The card's own lifecycle, made drivable: `expandedKey` mounts and
            unmounts the inset, and this is the same mount and the same
            unmount. */}
        <button
          data-toggle="card"
          onClick={() => setOpen((v) => !v)}
          style={{
            marginTop: 6, minHeight: 44, padding: "0 12px", borderRadius: 8,
            border: "1px solid #dadce0", background: "#fff", cursor: "pointer",
            fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#3c4043",
          }}
        >{open ? "Collapse card" : "Expand card"}</button>
        {/* The card's WHOLE berth block, fold and all — the Directions button,
            the ⚠ toggle beside it, and whatever the toggle reveals. Rendering
            `BerthInset` straight here would measure a state the app no longer
            has: since 2026-09-11 the rider meets the folded row first. */}
        {open && (
          <BerthDisclosure
            berth={b}
            published={asLatLon(p.stop_coords?.[String(b.stopId)])}
            routeLabel={cfg?.label ?? `route ${b.routeId}`}
            color={cfg?.color ?? "#5f6368"}
            stopName={name}
            path={p.route_paths?.[String(b.routeId)] ?? []}
            navHref={`https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}&travelmode=walking`}
            boardName={name}
          />
        )}
      </div>
    </div>
  );
}
