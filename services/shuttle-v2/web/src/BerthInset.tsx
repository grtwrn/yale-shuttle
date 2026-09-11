// "Wait about 55 m past the published stop", and the map that makes it
// believable.
//
// THE RIDER PROBLEM (operator, 2026-09-10): "sometimes the shuttle does not
// stop at the location indicated on the map. That makes it confusing for
// first-time riders to know where to stand." The measurement behind the two
// dots is `berths.ts` / `docs/berth-offsets.md`; the geometry is `berthMap.ts`;
// this file is only what the rider sees.
//
// ── THE COPY IS FIXED BY THE OPERATOR (2026-09-10) ──────────────────────────
// Never "stop sign": "lets not call it 'stop sign' because sometimes there's
// not even a sign. lets just say published stop location and expected stop
// location or something." The published coordinate is what the feed says; a
// physical sign was never verified and often does not exist, so naming one the
// rider cannot find makes the picture look wrong. The two markers are
// "published stop" and "expected stop", and the heading says "past the
// published stop".
//
// ── IT IS A REAL MAP NOW (operator, 2026-09-11) ─────────────────────────────
// "the berth changes are looking good but we might want it to be a real map
// area so I can see the street name and zoom out if needed." Until today this
// was a static SVG: OSM tiles as plain <image> elements at one chosen zoom, the
// whole box rotated so the road lay on its long edge, and two upright <text>
// labels over a white scrim. Neither ask survives that. The street name was
// whatever OSM had baked into the tile at the one zoom we picked — and the scrim
// was there precisely to wash it out so our own labels would win — and there is
// no zooming out of an image.
//
// The reason it was static was `routeThumb.ts`'s: fifteen Leaflet instances on
// one page is not shippable, each with its own tile requests, DOM panes and
// teardown. That objection does not reach this map. The inset renders only
// inside the ONE expanded card — `expandedKey` in TransitMap.tsx is a single
// key — so there is at most one Leaflet instance on the page, and React mounts
// it on expand and destroys it on collapse. The fifteen route thumbnails on the
// All tab are still SVG and must stay so.
//
// ── THE SCROLL TRAP, WHICH IS WHY THIS HAS TWO STATES ───────────────────────
// A pannable map inside a scrolling card steals the gesture: a rider dragging
// the page upward over it drags the map instead and the page stops dead. So the
// map mounts INERT — `dragging`, `touchZoom` and `doubleClickZoom` off. That is
// also what keeps Leaflet's own `leaflet-touch-drag` / `leaflet-touch-zoom`
// classes off the container, and with them the `touch-action: none` those rules
// carry, so a touch that starts on the map scrolls the page exactly as one
// starting on the sentence below it does. One tap arms it; a tap anywhere
// outside, or its own ✕, puts it back. The +/− buttons work in both states,
// because zooming by button steals no gesture at all, and `scrollWheelZoom`
// stays off in both for the same reason no page should zoom under a cursor.
//
// ── WHY THIS IS A COMPONENT AND NOT AN INLINE BLOCK ────────────────────────
// A Leaflet map needs a ref, a mount effect, a teardown, an Escape listener and
// an outside-tap listener — i.e. hooks — and TransitMap.tsx's hook order is
// load-bearing (a dependency array reaching a later `const` is a TDZ crash that
// blank-screens the app). A component of its own keeps all of them out of that
// 6.8k-line render.

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import type { Berth } from "./berths";
import { BERTH_MAP_VIEW, buildBerthGeometry, labelSides } from "./berthMap";
import type { LatLon } from "./geo";

/**
 * Inset height. The card can afford this much and the map needs it: two 44 px
 * zoom buttons stack inside it with room left over for the pair of markers and
 * their labels.
 */
const BOX_HEIGHT = 200;
/**
 * The trip map above quiets its tiles to `grayscale(0.9)`, and the first version
 * of this inset copied that and then laid a 42% white scrim on top so its own
 * 11 px labels would outshout OSM's. Both are dropped here, deliberately: on
 * THIS map the street name is the content the operator asked for, and our
 * labels are Leaflet tooltips with their own opaque background, so they no
 * longer need the basemap dimmed to be read. A touch of desaturation is all
 * that is left, to keep the route line's colour the loudest thing in the box.
 */
const TILE_FILTER = "saturate(0.9)";

export function BerthInset({
  berth, published, routeLabel, color, stopName, path,
}: {
  berth: Berth;
  /** The published stop coordinate — what the map draws today. */
  published: LatLon | undefined;
  routeLabel: string;
  color: string;
  stopName: string;
  path: readonly [number, number][];
}) {
  const host = useRef<HTMLDivElement | null>(null);
  /** The whole berth panel — a tap outside THIS is what disarms the map. */
  const panel = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  /** Armed for panning and pinching, i.e. the rider has tapped it. */
  const [live, setLive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const m = Math.round(Math.abs(berth.offsetM));
  const past = berth.offsetM > 0;
  const label = `${routeLabel} stops about ${m} metres ${past ? "past" : "before"} the published ${stopName} stop`;

  // ── Mount once per cell ────────────────────────────────────────────────────
  // Keyed on scalars rather than on the objects: `path` comes down out of a
  // payload replaced on every 5 s poll, and rebuilding the map every five
  // seconds would throw the rider's own zoom away twelve times a minute.
  const pubLat = published?.lat, pubLon = published?.lon;
  useEffect(() => {
    const el = host.current;
    if (!el || pubLat === undefined || pubLon === undefined) return;
    const pub: LatLon = { lat: pubLat, lon: pubLon };
    const spot: LatLon = { lat: berth.lat, lon: berth.lon };
    const g = buildBerthGeometry(pub, spot, path.map(([lat, lon]) => ({ lat, lon })));

    // zoomAnimation off for the reason the trip map has it off: these embedded
    // maps unmount freely (a card collapse), and an interrupted CSS zoom fires
    // _onZoomTransitionEnd on a dead map (the _leaflet_pos crash).
    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      zoomAnimation: false,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    // The route, with a white casing under it. At 0.35 opacity over an orange
    // OSM road it was invisible, and this line is what makes "past" a direction
    // rather than a guess.
    if (g.road.length > 1) {
      const pts = g.road.map((p) => [p.lat, p.lon] as [number, number]);
      L.polyline(pts, { color: "#fff", weight: 8, opacity: 0.9, lineCap: "round", interactive: false }).addTo(map);
      L.polyline(pts, { color, weight: 4, opacity: 1, lineCap: "round", interactive: false }).addTo(map);
    }
    // Where the published coordinate is off the kerb (36.7 m at 300 George St)
    // the dot needs tying to its own place on the road, or it reads as the map
    // being broken.
    if (g.publishedLink) {
      L.polyline(g.publishedLink.map((p) => [p.lat, p.lon] as [number, number]), {
        color: "#5f6368", weight: 1.5, dashArray: "3 4", opacity: 0.9, interactive: false,
      }).addTo(map);
    }
    // One arrowhead, in the direction buses drive. Without it "past" cannot be
    // resolved from a picture at all. Leaflet's frame is north-up and never
    // rotates, so a compass bearing IS a screen rotation.
    if (g.arrow) {
      L.marker([g.arrow.lat, g.arrow.lon], {
        interactive: false,
        icon: L.divIcon({
          className: "berth-arrow",
          html: `<div style="width:22px;height:22px;transform:rotate(${g.arrow.bearingDeg}deg)">`
            + `<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true">`
            + `<path d="M 0 -7 L 5.5 6 L 0 3 L -5.5 6 Z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>`
            + `</svg></div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      }).addTo(map);
    }

    // The two markers. `circleMarker` keeps a fixed PIXEL radius, so both dots
    // stay the same legible size at every zoom the rider reaches — a
    // metre-radius circle would vanish on the way out — and a permanent tooltip
    // carries its own opaque box, so the words stay readable over any tile.
    const sides = labelSides(pub, spot);
    L.circleMarker([pub.lat, pub.lon], {
      radius: 6, color: "#5f6368", weight: 2.5, fillColor: "#fff", fillOpacity: 1, interactive: false,
    }).addTo(map).bindTooltip("published stop", {
      permanent: true, direction: sides.published, className: "berth-tip", opacity: 1,
    });
    L.circleMarker([spot.lat, spot.lon], {
      radius: 7, color: "#fff", weight: 2.5, fillColor: color, fillOpacity: 1, interactive: false,
    }).addTo(map).bindTooltip("expected stop", {
      permanent: true, direction: sides.berth, className: "berth-tip berth-tip-expected", opacity: 1,
    });

    // The opening view is the pair with margin, capped at the scale the static
    // inset drew every cell at (0.45 m/px, tile z18) — so the map opens at the
    // detail this picture has always had, and zooming OUT is the rider's to do.
    map.fitBounds(
      L.latLngBounds([[pub.lat, pub.lon], [spot.lat, spot.lon]]),
      {
        padding: [BERTH_MAP_VIEW.paddingPx, BERTH_MAP_VIEW.paddingPx],
        maxZoom: BERTH_MAP_VIEW.maxZoom,
        animate: false,
      },
    );

    // Arm on a tap on the map itself. Leaflet raises `click` from a touch too,
    // and with dragging off there is no drag for it to be confused with.
    map.on("click", () => setLive(true));

    // A card can change width without remounting (rotation, a scrollbar
    // appearing), and a Leaflet map that is not told renders its tiles into the
    // old box.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => mapRef.current?.invalidateSize());
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      mapRef.current = null;
      map.remove();
    };
  }, [berth.stopId, berth.routeId, berth.lat, berth.lon, pubLat, pubLon, color, path.length]);

  // ── Inert vs armed ────────────────────────────────────────────────────────
  // Enabling the handlers is also what puts `leaflet-touch-drag` /
  // `leaflet-touch-zoom` on the container, so this one switch owns both the
  // behaviour and the `touch-action` that decides whether the PAGE scrolls when
  // a finger lands on the map.
  const armed = live || fullscreen;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const h of [map.dragging, map.touchZoom, map.doubleClickZoom]) {
      if (armed) h.enable(); else h.disable();
    }
  }, [armed]);

  // A tap anywhere off the berth panel disarms the map — the rider is reading
  // the rest of the card again. The panel, not the map, because the row that
  // toggles it sits below the map and must not be read as "outside".
  useEffect(() => {
    if (!live || fullscreen) return;
    const onDown = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && panel.current?.contains(t)) return;
      setLive(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [live, fullscreen]);

  // Fullscreen is the app's own expanded map, reached from here: the same
  // wrapper-plus-`map-fs` class, the same Back-at-top-left beside ✕-at-top-right
  // (operator, 2026-09-02 — on a phone the thumb that got there came from the
  // left), the same Escape. Nothing new is opened; THIS map fills the viewport,
  // so the two markers and the line are the same objects by construction.
  useEffect(() => {
    const t = setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      map.invalidateSize();
      if (pubLat === undefined || pubLon === undefined) return;
      map.fitBounds(
        L.latLngBounds([[pubLat, pubLon], [berth.lat, berth.lon]]),
        {
          padding: fullscreen ? [80, 80] : [BERTH_MAP_VIEW.paddingPx, BERTH_MAP_VIEW.paddingPx],
          maxZoom: BERTH_MAP_VIEW.maxZoom,
          animate: false,
        },
      );
    }, 80);
    return () => clearTimeout(t);
  }, [fullscreen, pubLat, pubLon, berth.lat, berth.lon]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);
  // Leaving fullscreen returns the inset to inert: it is back inside a
  // scrolling card, and the safe default there is the one that scrolls.
  useEffect(() => { if (!fullscreen) setLive(false); }, [fullscreen]);

  const btn = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    position: "absolute", zIndex: 1000,
    minWidth: 44, height: 44, border: "none", borderRadius: 8,
    background: "rgba(255,255,255,0.94)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
    cursor: "pointer", fontSize: 18, lineHeight: 1, color: "#37474f",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "inherit", padding: 0,
    ...extra,
  });

  const wrapperStyle: React.CSSProperties = fullscreen
    ? { position: "fixed", inset: 0, zIndex: 9999, borderRadius: 0, border: "none", overflow: "hidden" }
    : {
        position: "relative", height: BOX_HEIGHT, marginBottom: 6,
        borderRadius: 6, border: "1px solid #e0ddd8", overflow: "hidden",
        background: "#eeeae3",
      };

  return (
    <div ref={panel} style={{
      marginTop: 10, padding: "8px 10px", borderRadius: 8,
      background: "#f8f9fa", fontSize: 13, lineHeight: 1.45, color: "#3c4043",
    }}>
      {published && (
        <div
          className={`berth-map-wrap${fullscreen ? " map-fs" : ""}`}
          style={wrapperStyle}
          role="group"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Scoped to this wrapper, so the trip map's own grey filter is left
              alone. The zoom buttons are grown to the 44 px this app promises
              every touch target — Leaflet ships 30. */}
          <style>{`
            .berth-map-wrap .leaflet-tile-pane { filter: ${TILE_FILTER}; }
            .berth-map-wrap .leaflet-control-zoom a {
              width: 44px; height: 44px; line-height: 44px; font-size: 20px;
            }
            .berth-map-wrap .leaflet-control-attribution { font-size: 9px; padding: 0 4px; }
            .berth-map-wrap .leaflet-tooltip.berth-tip {
              padding: 1px 5px; font-size: 11.5px; font-weight: 600; line-height: 1.4;
              color: #3c4043; background: rgba(255,255,255,0.96);
              border: 1px solid #bdc1c6; box-shadow: none; white-space: nowrap;
            }
            .berth-map-wrap .leaflet-tooltip.berth-tip-expected { color: ${color}; font-weight: 700; }
            /* Leaflet's own pointer is kept: with the label offset from its dot,
               it is what says WHICH dot it names. The two labels open away from
               each other (see labelSides) — the northern dot's above it, the
               southern dot's below — so they cannot collide however far the
               rider zooms out and however close the dots draw together. */
            .berth-map-wrap .leaflet-tooltip-top.berth-tip::before { border-top-color: rgba(255,255,255,0.96); }
            .berth-map-wrap .leaflet-tooltip-bottom.berth-tip::before { border-bottom-color: rgba(255,255,255,0.96); }
            .berth-map-wrap.map-fs .leaflet-top.leaflet-left { margin-top: 52px; }
          `}</style>
          <div ref={host} style={{ position: "absolute", inset: 0 }} />
          {/* Back, top-left, beside the ✕ rather than instead of it — the app's
              existing fullscreen close path, not a second one. */}
          {fullscreen && (
            <button
              onClick={(e) => { e.stopPropagation(); setFullscreen(false); }}
              title="Back" aria-label="Back"
              style={btn({ top: 8, left: 8, padding: "0 14px 0 10px", fontSize: 14, gap: 4 })}
            >
              <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>‹</span>
              Back
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setFullscreen((v) => !v); }}
            title={fullscreen ? "Exit fullscreen" : "Full map"}
            aria-label={fullscreen ? "Exit fullscreen" : "Full map"}
            style={btn({ top: 8, right: 8 })}
          >
            {fullscreen ? "✕" : "⤢"}
          </button>
        </div>
      )}
      {/* The affordance, and the way back, live UNDER the map rather than on
          it. Both overlay positions were tried and captured: a pill at the
          bottom-left sat straight over "expected stop" on Red at Division /
          Prospect, and moving it to the top-centre put it over "published stop"
          on the same cell — `fitBounds` centres the PAIR, so on a north-south
          offset (7 of the 10 cells) one label is always near an edge. In a
          200 px box there is no empty corner to claim; a row below it costs
          22 px and covers nothing. Tapping the map itself still arms it, so
          this is a label a rider can also press, not the only way in. */}
      {published && !fullscreen && (
        <button
          onClick={(e) => { e.stopPropagation(); setLive(!armed); }}
          aria-pressed={armed}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            width: "100%", minHeight: 44, marginBottom: 2, padding: 0,
            background: "none", border: "none", cursor: "pointer",
            fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
            color: armed ? "#1a73e8" : "#5f6368", textAlign: "left",
          }}
        >
          <span aria-hidden="true">{armed ? "✕" : "👆"}</span>
          {armed ? "Done — stop panning the map" : "Tap the map to zoom and pan"}
        </button>
      )}
      <span style={{ fontWeight: 650 }}>
        Wait about {m} m {past ? "past" : "before"} the published stop
      </span>
      <br />
      {routeLabel} buses actually stop there — seen {berth.seen} of the last{" "}
      {berth.of} times one served this stop.
    </div>
  );
}
