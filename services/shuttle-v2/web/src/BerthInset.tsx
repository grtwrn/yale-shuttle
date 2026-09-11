// "Wait about 55 m past the published stop", and the picture that makes it
// believable.
//
// THE RIDER PROBLEM (operator, 2026-09-10): "sometimes the shuttle does not
// stop at the location indicated on the map. That makes it confusing for
// first-time riders to know where to stand." The measurement behind the two
// dots is `berths.ts` / `docs/berth-offsets.md`; the geometry is
// `berthThumb.ts`; this file is only what the rider sees.
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
// ── WHY THIS IS A COMPONENT AND NOT AN INLINE BLOCK ────────────────────────
// The viewBox has to match the card's RENDERED width or the SVG letterboxes
// inside it — at 430 px the old fixed 300-wide box drew grey gutters either
// side. Measuring the card needs a ref and a ResizeObserver, i.e. hooks, and
// TransitMap.tsx's hook order is load-bearing (a dependency array reaching a
// later `const` is a TDZ crash that blank-screens the app). A component of its
// own keeps those hooks out of that 6.8k-line render.

import { useEffect, useRef, useState } from "react";

import type { Berth } from "./berths";
import { buildBerthThumb } from "./berthThumb";
import type { LatLon } from "./geo";

/** The tile group is quieted exactly as the trip map above quiets its own. */
const TILE_FILTER = "grayscale(0.9) contrast(0.95) brightness(1.05)";
/**
 * And then lifted further: OSM's own street labels outshouted ours at this
 * size, which is the one thing this picture cannot afford — the two words ARE
 * the content. A scrim is what the trip map does not need and this does,
 * because here the annotation is 11 px over a road label of the same size.
 */
const SCRIM_OPACITY = 0.42;
const BOX_HEIGHT = 160;
/**
 * Half the widest label at 11.5 px, in px — `berthThumb` clamps both labels to
 * keep them inside the box, and it cannot measure a font.
 */
const LABEL_HALF_W = 44;

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
  const slot = useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(0);

  // The card is not a fixed width: 390 px and 430 px phones differ, and the
  // expanded card itself changes width when a scrollbar appears. The ref is on
  // the SVG's own slot, not on the padded panel around it — measuring the panel
  // includes its 10 px of padding, which is a viewBox 20 px wider than the
  // picture and the same letterboxing in miniature.
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const read = () => setBoxW(+(el.getBoundingClientRect().width || 0).toFixed(1));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = Math.round(Math.abs(berth.offsetM));
  const past = berth.offsetM > 0;
  const th = published && boxW > 40
    ? buildBerthThumb(
        published, { lat: berth.lat, lon: berth.lon },
        path.map(([lat, lon]) => ({ lat, lon })),
        { width: boxW, height: BOX_HEIGHT, labelHalfW: LABEL_HALF_W },
      )
    : null;
  const clip = `berth-clip-${berth.stopId}-${berth.routeId}`;

  return (
    <div style={{
      marginTop: 10, padding: "8px 10px", borderRadius: 8,
      background: "#f8f9fa", fontSize: 13, lineHeight: 1.45, color: "#3c4043",
    }}>
      <div ref={slot}>
      {th && (
        <svg viewBox={th.viewBox} width="100%" height={th.height}
          role="img"
          style={{ display: "block", marginBottom: 6, borderRadius: 6, background: "#eeeae3" }}
          aria-label={`${routeLabel} stops about ${m} metres ${past ? "past" : "before"} the published ${stopName} stop`}>
          <defs>
            <clipPath id={clip}><rect x={0} y={0} width={th.width} height={th.height} /></clipPath>
          </defs>
          {/* The same tiles Leaflet would draw, as plain images — a map object
              per expanded card is what routeThumb.ts exists to avoid. Streets
              behind the dots are what make them mean anything (operator,
              2026-09-10). The group carries the rotation that puts the
              direction of travel to the right; the annotation below does not,
              so every word stays upright. */}
          <g clipPath={`url(#${clip})`}>
            <g style={{ filter: TILE_FILTER }}>
              <g transform={th.tileTransform}>
                {th.tiles.map((t) => (
                  <image key={`${t.z}/${t.x}/${t.y}`}
                    href={`https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`}
                    x={t.px} y={t.py} width={t.size} height={t.size} />
                ))}
              </g>
            </g>
            <rect x={0} y={0} width={th.width} height={th.height} fill="#fff" opacity={SCRIM_OPACITY} />
            {/* The route, at full opacity with a white casing. At 0.35 over an
                orange OSM road it was invisible, and this line is what makes
                "past" a direction rather than a guess. */}
            {th.road.length > 1 && (<>
              <polyline points={th.road.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none" stroke="#fff" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={th.road.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            </>)}
            {/* One arrowhead, in the direction buses drive. Without it "past"
                cannot be resolved from a picture at all. */}
            {th.arrow && (
              <g transform={`translate(${th.arrow.x} ${th.arrow.y}) rotate(${th.arrow.deg})`}>
                <path d="M -5 -5 L 6 0 L -5 5 Z" fill={color} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
              </g>
            )}
            {/* Where the published coordinate is off the kerb (36.7 m at 300
                George St) the dot needs tying to its own place on the road, or
                it reads as the picture being broken. */}
            {th.publishedLink && (
              <line x1={th.publishedLink.x1} y1={th.publishedLink.y1} x2={th.publishedLink.x2} y2={th.publishedLink.y2}
                stroke="#5f6368" strokeWidth={1.2} strokeDasharray="2 3" opacity={0.9} />
            )}
            <circle cx={th.published.x} cy={th.published.y} r={5.5} fill="#fff" stroke="#5f6368" strokeWidth={2.5} />
            <circle cx={th.berth.x} cy={th.berth.y} r={6.5} fill={color} stroke="#fff" strokeWidth={2.5} />
            {/* A white halo under every word, because the ground under it is a
                photograph of a city and not a background colour. */}
            <g paintOrder="stroke" stroke="#fff" strokeWidth={3.5} strokeLinejoin="round">
              <text x={th.publishedLabel.x} y={th.publishedLabel.y} textAnchor="middle"
                fontSize={11.5} fontWeight={600} fill="#3c4043">published stop</text>
              <text x={th.berthLabel.x} y={th.berthLabel.y} textAnchor="middle"
                fontSize={11.5} fontWeight={700} fill={color}>expected stop</text>
              {/* The scale bar is the cue the first version had no answer for:
                  one zoom for every cell is only checkable if the picture says
                  what a pixel is worth. */}
              <g transform={`translate(10 ${th.height - 12})`}>
                <path d={`M 0 -4 L 0 0 L ${th.scale.px} 0 L ${th.scale.px} -4`}
                  fill="none" stroke="#fff" strokeWidth={3.5} />
                <path d={`M 0 -4 L 0 0 L ${th.scale.px} 0 L ${th.scale.px} -4`}
                  fill="none" stroke="#3c4043" strokeWidth={1.4} />
                <text x={th.scale.px / 2} y={-6} textAnchor="middle"
                  fontSize={10} fontWeight={600} fill="#3c4043">{th.scale.m} m</text>
              </g>
              {/* Tile policy: the tiles are openstreetmap.org's, so the credit
                  travels with them even in a 160 px inset. */}
              <text x={th.width - 5} y={th.height - 5} textAnchor="end"
                fontSize={8.5} fill="#5f6368">© OpenStreetMap contributors</text>
            </g>
          </g>
        </svg>
      )}
      </div>
      <span style={{ fontWeight: 650 }}>
        Wait about {m} m {past ? "past" : "before"} the published stop
      </span>
      <br />
      {routeLabel} buses actually stop there — seen {berth.seen} of the last{" "}
      {berth.of} times one served this stop.
    </div>
  );
}
