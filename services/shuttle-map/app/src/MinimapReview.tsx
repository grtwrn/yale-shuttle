import React, { useEffect, useMemo, useState, type FC } from "react";

// ─────────────────────────────────────────────────────────────────────
//  Round 4 — 10 different *backbones*, not just reskins. Each design
//  shows a genuinely different underlying world: full streets vs just
//  arterials vs no streets at all vs buildings vs blocks etc.
//  Visit /?review=minimap.
// ─────────────────────────────────────────────────────────────────────

type LatLon = { lat: number; lon: number };

interface TripProps {
  color: string;
  boardId: number;
  alightId: number;
  segStops: number[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, LatLon>;
  allStops: number[]; // full route, for transit-only backbone
}

// ─── Data: streets (major + minor), buildings, parks ────────────────

type Street = { name: string; points: LatLon[]; kind: "arterial" | "local" };
const STREETS: Street[] = [
  // N-S arterials
  { name: "Whitney Ave", kind: "arterial", points: [{lat:41.3300,lon:-72.9200},{lat:41.3190,lon:-72.9215},{lat:41.3120,lon:-72.9220},{lat:41.3060,lon:-72.9252}] },
  { name: "Prospect St", kind: "arterial", points: [{lat:41.3290,lon:-72.9228},{lat:41.3200,lon:-72.9240},{lat:41.3120,lon:-72.9257}] },
  { name: "Orange St",   kind: "arterial", points: [{lat:41.3260,lon:-72.9200},{lat:41.3080,lon:-72.9230}] },
  { name: "College St",  kind: "arterial", points: [{lat:41.3160,lon:-72.9285},{lat:41.3070,lon:-72.9285},{lat:41.3000,lon:-72.9320}] },
  { name: "Church St",   kind: "arterial", points: [{lat:41.3160,lon:-72.9258},{lat:41.3010,lon:-72.9258}] },
  { name: "York St",     kind: "arterial", points: [{lat:41.3150,lon:-72.9320},{lat:41.3050,lon:-72.9300}] },
  // N-S local
  { name: "Temple St",   kind: "local", points: [{lat:41.3140,lon:-72.9270},{lat:41.3040,lon:-72.9270}] },
  { name: "High St",     kind: "local", points: [{lat:41.3140,lon:-72.9300},{lat:41.3070,lon:-72.9295}] },
  { name: "Park St",     kind: "local", points: [{lat:41.3130,lon:-72.9335},{lat:41.3040,lon:-72.9318}] },
  // E-W arterials
  { name: "Grove St",    kind: "arterial", points: [{lat:41.3128,lon:-72.9330},{lat:41.3128,lon:-72.9200}] },
  { name: "Elm St",      kind: "arterial", points: [{lat:41.3088,lon:-72.9340},{lat:41.3088,lon:-72.9200}] },
  { name: "Chapel St",   kind: "arterial", points: [{lat:41.3072,lon:-72.9340},{lat:41.3072,lon:-72.9180}] },
  { name: "George St",   kind: "arterial", points: [{lat:41.3040,lon:-72.9335},{lat:41.3040,lon:-72.9200}] },
  { name: "Cedar St",    kind: "arterial", points: [{lat:41.3015,lon:-72.9340},{lat:41.3015,lon:-72.9230}] },
  // E-W local
  { name: "Humphrey St", kind: "local", points: [{lat:41.3180,lon:-72.9310},{lat:41.3180,lon:-72.9160}] },
  { name: "Cottage St",  kind: "local", points: [{lat:41.3165,lon:-72.9295},{lat:41.3165,lon:-72.9175}] },
  { name: "Edwards St",  kind: "local", points: [{lat:41.3215,lon:-72.9260},{lat:41.3215,lon:-72.9180}] },
  { name: "Canner St",   kind: "local", points: [{lat:41.3255,lon:-72.9240},{lat:41.3255,lon:-72.9160}] },
  { name: "Sachem St",   kind: "local", points: [{lat:41.3150,lon:-72.9275},{lat:41.3150,lon:-72.9215}] },
  { name: "Wall St",     kind: "local", points: [{lat:41.3108,lon:-72.9330},{lat:41.3108,lon:-72.9210}] },
  { name: "Crown St",    kind: "local", points: [{lat:41.3057,lon:-72.9335},{lat:41.3057,lon:-72.9200}] },
  { name: "Trumbull St", kind: "local", points: [{lat:41.3123,lon:-72.9300},{lat:41.3123,lon:-72.9210}] },
  { name: "Audubon St",  kind: "local", points: [{lat:41.3116,lon:-72.9270},{lat:41.3116,lon:-72.9205}] },
];

// Yale building footprints (rough rectangles).
type Building = { name: string; lat: number; lon: number; dLat: number; dLon: number };
const BUILDINGS: Building[] = [
  { name: "Sterling",      lat: 41.3113, lon: -72.9286, dLat: 0.0007, dLon: 0.0006 },
  { name: "Beinecke",      lat: 41.3115, lon: -72.9272, dLat: 0.0004, dLon: 0.0004 },
  { name: "Harkness",      lat: 41.3107, lon: -72.9297, dLat: 0.0003, dLon: 0.0002 },
  { name: "Old Campus",    lat: 41.3099, lon: -72.9298, dLat: 0.0010, dLon: 0.0013 },
  { name: "SOM",           lat: 41.3166, lon: -72.9252, dLat: 0.0005, dLon: 0.0006 },
  { name: "Peabody",       lat: 41.3154, lon: -72.9225, dLat: 0.0005, dLon: 0.0005 },
  { name: "Payne Whitney", lat: 41.3116, lon: -72.9219, dLat: 0.0006, dLon: 0.0006 },
  { name: "Ingalls Rink",  lat: 41.3115, lon: -72.9185, dLat: 0.0005, dLon: 0.0007 },
  { name: "Kline Biology", lat: 41.3180, lon: -72.9232, dLat: 0.0006, dLon: 0.0005 },
  { name: "Rosenkranz",    lat: 41.3147, lon: -72.9246, dLat: 0.0004, dLon: 0.0004 },
  { name: "Kroon Hall",    lat: 41.3184, lon: -72.9223, dLat: 0.0005, dLon: 0.0005 },
  { name: "LEPH",          lat: 41.3033, lon: -72.9317, dLat: 0.0006, dLon: 0.0006 },
];

const GREENS = [
  { name: "The Green",    bounds: { n: 41.3096, s: 41.3068, w: -72.9294, e: -72.9250 } },
  { name: "Old Campus",   bounds: { n: 41.3107, s: 41.3093, w: -72.9306, e: -72.9287 } },
  { name: "Cross Campus", bounds: { n: 41.3117, s: 41.3108, w: -72.9302, e: -72.9276 } },
];

type Landmark = { name: string; lat: number; lon: number };
const LANDMARKS: Landmark[] = [
  { name: "Sterling",       lat: 41.3113, lon: -72.9286 },
  { name: "Beinecke",       lat: 41.3115, lon: -72.9272 },
  { name: "Payne Whitney",  lat: 41.3116, lon: -72.9219 },
  { name: "Ingalls Rink",   lat: 41.3115, lon: -72.9185 },
  { name: "Peabody",        lat: 41.3154, lon: -72.9225 },
  { name: "SOM",            lat: 41.3166, lon: -72.9252 },
  { name: "Divinity",       lat: 41.3269, lon: -72.9235 },
  { name: "LEPH",           lat: 41.3033, lon: -72.9317 },
  { name: "Union Station",  lat: 41.2973, lon: -72.9263 },
];

// ─── Helpers ────────────────────────────────────────────────────────

function shortName(name: string): string {
  return name.replace(/\s*\(.+?\)\s*/g, "").replace(/\s*\/\s*/g, "/");
}

function useProj(stopCoords: Record<number, LatLon>, segStops: number[], w: number, h: number, pad: number) {
  return useMemo(() => {
    const coords: LatLon[] = [];
    for (const sid of segStops) if (stopCoords[sid]) coords.push(stopCoords[sid]);
    for (const l of LANDMARKS) coords.push(l);
    for (const s of STREETS) for (const p of s.points) coords.push(p);
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const c of coords) {
      if (c.lat < minLat) minLat = c.lat;
      if (c.lat > maxLat) maxLat = c.lat;
      if (c.lon < minLon) minLon = c.lon;
      if (c.lon > maxLon) maxLon = c.lon;
    }
    const dLat = maxLat - minLat, dLon = maxLon - minLon;
    const scale = Math.min((w - 2 * pad) / dLon, (h - 2 * pad) / dLat);
    const ox = (w - dLon * scale) / 2, oy = (h - dLat * scale) / 2;
    const project = (c: LatLon) => ({
      x: ox + (c.lon - minLon) * scale,
      y: oy + (maxLat - c.lat) * scale,
    });
    return { project, minLat, maxLat, minLon, maxLon, scale };
  }, [stopCoords, segStops, w, h, pad]);
}

function streetPath(points: LatLon[], project: (c: LatLon) => { x: number; y: number }): string {
  if (points.length < 2) return "";
  const [a, ...rest] = points.map(project);
  return `M ${a.x},${a.y} ` + rest.map((p) => `L ${p.x},${p.y}`).join(" ");
}

function catmullRom(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i], p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

function greenRect(g: typeof GREENS[number], project: (c: LatLon) => { x: number; y: number }) {
  const tl = project({ lat: g.bounds.n, lon: g.bounds.w });
  const br = project({ lat: g.bounds.s, lon: g.bounds.e });
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

function buildingRect(b: Building, project: (c: LatLon) => { x: number; y: number }) {
  const tl = project({ lat: b.lat + b.dLat, lon: b.lon - b.dLon });
  const br = project({ lat: b.lat - b.dLat, lon: b.lon + b.dLon });
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

function streetLabel(s: Street, project: (c: LatLon) => { x: number; y: number }) {
  const n = s.points.length;
  const a = project(s.points[Math.floor(n / 2) - 1] ?? s.points[0]);
  const b = project(s.points[Math.floor(n / 2)] ?? s.points[n - 1]);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const adj = angle > 90 || angle < -90 ? angle + 180 : angle;
  return { x: mx, y: my, angle: adj };
}

// ─── Style 1: Arterials only ─────────────────────────────────────────

const Style1_Arterials: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 360;
  const { project } = useProj(stopCoords, segStops, W, H, 30);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#F7F4EC", borderRadius: 10 }}>
      {/* Park — lightest signal */}
      {GREENS.filter(g => g.name === "The Green").map((g, i) => {
        const r = greenRect(g, project);
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#D8E9C6" rx={2} />;
      })}
      {/* only arterials, thick, clean */}
      <g stroke="#e4d4a8" strokeWidth="8" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} />
        ))}
      </g>
      <g stroke="#ffffff" strokeWidth="5" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} />
        ))}
      </g>
      {/* street labels */}
      {STREETS.filter(s => s.kind === "arterial").map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 3} fontSize="10" fontWeight={600}
                textAnchor="middle" fill="#50402d"
                fontFamily="'Inter', sans-serif"
                stroke="#F7F4EC" strokeWidth="3" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3} fill={isEnd ? "#fff" : "#fff"}
                    stroke={color} strokeWidth={isEnd ? 2.4 : 1.3} />
            {isEnd && (
              <text x={p.x} y={p.y - 12} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a"
                    stroke="#F7F4EC" strokeWidth="3" paintOrder="stroke fill">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 2: Only the trip's streets ────────────────────────────────
//  "Skeleton": render only streets that the route actually touches
//  based on nearest-street-to-stop. Removes clutter entirely.

const Style2_Skeleton: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 320;
  const { project } = useProj(stopCoords, segStops, W, H, 30);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  // pick the 4 streets nearest to any trip stop
  const stopsCoords = segStops.map((s) => stopCoords[s]).filter(Boolean) as LatLon[];
  const streetScore = STREETS.map((s) => {
    let minD = Infinity;
    for (const sc of stopsCoords) {
      for (const p of s.points) {
        const d = Math.hypot(p.lat - sc.lat, p.lon - sc.lon);
        if (d < minD) minD = d;
      }
    }
    return { s, d: minD };
  }).sort((a, b) => a.d - b.d).slice(0, 6).map(x => x.s);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#FDFCF8", borderRadius: 10 }}>
      <g stroke="#d8d4c6" strokeWidth="3.5" fill="none" strokeLinecap="round">
        {streetScore.map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      {streetScore.map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y - 6} fontSize="9.5" textAnchor="middle"
                fontFamily="'Inter', sans-serif" fill="#5c6470" fontWeight={500}
                stroke="#FDFCF8" strokeWidth="3" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y - 6})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3.5}
                    fill={isEnd ? color : "#fff"} stroke={color} strokeWidth={isEnd ? 2.2 : 1.4} />
            {isEnd && (
              <text x={p.x} y={p.y - 12} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 3: Blocks as positive space ───────────────────────────────
//  Entire background is "land" color; streets cut through as bright gaps.

const Style3_Blocks: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 360;
  const { project } = useProj(stopCoords, segStops, W, H, 20);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#EDE6D1", borderRadius: 10 }}>
      {/* Parks */}
      {GREENS.map((g, i) => {
        const r = greenRect(g, project);
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#CADCA4" rx={2} />;
      })}
      {/* Wide street casing — this is the "cut" */}
      <g stroke="#ffffff" strokeLinecap="round" fill="none">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="8" />
        ))}
        {STREETS.filter(s => s.kind === "local").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="5" />
        ))}
      </g>
      {/* thin darker centerline on arterials for hierarchy */}
      <g stroke="#e6d6a8" strokeLinecap="round" fill="none" strokeDasharray="0">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="1" opacity="0.6" />
        ))}
      </g>
      {STREETS.map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2} fontSize={s.kind === "arterial" ? 9 : 7.5}
                textAnchor="middle" fontFamily="'Inter', sans-serif"
                fill="#5a4e2a" fontWeight={s.kind === "arterial" ? 600 : 400}
                stroke="#ffffff" strokeWidth="2" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="7.5"
            strokeLinecap="round" strokeLinejoin="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3} fill="#fff" stroke={color}
                    strokeWidth={isEnd ? 2.4 : 1.3} />
            {isEnd && (
              <text x={p.x} y={p.y - 11} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a"
                    stroke="#EDE6D1" strokeWidth="3" paintOrder="stroke fill">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 4: Streets + Yale building footprints ─────────────────────

const Style4_Buildings: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 380;
  const { project } = useProj(stopCoords, segStops, W, H, 30);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#F6F4EE", borderRadius: 10 }}>
      {/* Parks */}
      {GREENS.map((g, i) => {
        const r = greenRect(g, project);
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#D3E4B7" rx={2} />;
      })}
      {/* streets with casings */}
      <g stroke="#d4c79c" strokeWidth="6" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      <g stroke="#cfc7ae" strokeWidth="3.5" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "local").map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      <g stroke="#ffffff" strokeWidth="4" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      <g stroke="#ffffff" strokeWidth="2" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "local").map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      {/* buildings */}
      {BUILDINGS.map((b, i) => {
        const r = buildingRect(b, project);
        return (
          <g key={i}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#D5CCB0" stroke="#8f7a42" strokeWidth="0.6" rx={1.5} />
            <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 3} fontSize="7" textAnchor="middle"
                  fontFamily="'Inter', sans-serif" fill="#5a4a1f" fontWeight={600}>
              {b.name.length > 9 ? b.name.slice(0, 8) + "…" : b.name}
            </text>
          </g>
        );
      })}
      {/* street labels */}
      {STREETS.filter(s => s.kind === "arterial").map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2} fontSize="9" textAnchor="middle"
                fontFamily="'Inter', sans-serif" fill="#3e3117" fontWeight={600}
                stroke="#F6F4EE" strokeWidth="2.5" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="7"
            strokeLinecap="round" strokeLinejoin="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3} fill="#fff" stroke={color}
                    strokeWidth={isEnd ? 2.2 : 1.3} />
            {isEnd && (
              <text x={p.x} y={p.y - 11} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 5: Transit-only (no streets) ──────────────────────────────

const Style5_TransitOnly: FC<TripProps> = ({ color, segStops, allStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 340;
  const { project } = useProj(stopCoords, segStops, W, H, 40);
  const allProj = allStops.map((sid) => stopCoords[sid] && project(stopCoords[sid])).filter(Boolean) as Array<{ x: number; y: number }>;
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  const segSet = new Set(segStops);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#ffffff", borderRadius: 10 }}>
      {/* faint full-loop route */}
      <path d={catmullRom(allProj)} fill="none" stroke="#e0ddd8" strokeWidth="3" strokeLinecap="round" />
      {/* non-trip stops */}
      {allStops.map((sid, i) => {
        if (segSet.has(sid)) return null;
        const p = allProj[i]; if (!p) return null;
        return <circle key={sid} cx={p.x} cy={p.y} r="2.2" fill="#c3c3c3" />;
      })}
      {/* trip line */}
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {/* trip stops with labels */}
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        const name = (stopNames[sid] ?? "").replace(/\s*\(.+?\)\s*/g, "").replace(/\s*\/\s*/g, "/");
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 4} fill="#fff"
                    stroke={color} strokeWidth={isEnd ? 2.4 : 1.6} />
            <text x={p.x + 9} y={p.y + 3.5} fontSize={isEnd ? 10.5 : 9}
                  fontFamily="'Inter', sans-serif" fontWeight={isEnd ? 700 : 500}
                  fill="#263238">
              {isEnd ? `${sid === boardId ? "Board" : "Alight"} · ${name}` : name}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 6: Landmark constellation (no streets) ────────────────────

const Style6_Constellation: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 380;
  const { project } = useProj(stopCoords, segStops, W, H, 40);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#0F172A", borderRadius: 10 }}>
      {/* subtle starfield */}
      {Array.from({ length: 60 }, (_, i) => (
        <circle key={i} cx={(i * 97) % W} cy={(i * 61 + 17) % H} r={(i % 3) === 0 ? 1 : 0.6}
                fill="#FFFFFF" opacity={0.3 + ((i * 11) % 5) * 0.08} />
      ))}
      {/* landmarks as bubbles */}
      {LANDMARKS.map((l) => {
        const p = project(l);
        return (
          <g key={l.name}>
            <circle cx={p.x} cy={p.y} r="9" fill="#1F2A44" stroke="#4D5876" strokeWidth="0.8" />
            <circle cx={p.x} cy={p.y} r="3" fill="#8BA4D6" />
            <text x={p.x} y={p.y + 22} fontSize="9" textAnchor="middle"
                  fontFamily="'Inter', sans-serif" fontWeight={500} fill="#B8C4DC">
              {l.name}
            </text>
          </g>
        );
      })}
      {/* route threading between stops */}
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="2.5"
            strokeDasharray="5 4" strokeLinecap="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 8 : 3.5} fill={color} opacity={isEnd ? 1 : 0.7} />
            {isEnd && (
              <>
                <circle cx={p.x} cy={p.y} r="14" fill="none" stroke={color} opacity="0.35" strokeWidth="1.2" />
                <text x={p.x} y={p.y - 16} fontSize="11" fontWeight={700} textAnchor="middle"
                      fontFamily="'Inter', sans-serif" fill="#F4F6FB">
                  {shortName(stopNames[sid] ?? "")}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 7: Radial rings around board stop ─────────────────────────

const Style7_Radial: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 360;
  const { project } = useProj(stopCoords, segStops, W, H, 40);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  const boardP = project(stopCoords[boardId]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#F6F2E7", borderRadius: 10 }}>
      {/* rings around board */}
      {[30, 70, 120, 180, 250].map((r, i) => (
        <circle key={i} cx={boardP.x} cy={boardP.y} r={r} fill="none"
                stroke="#d4c59a" strokeWidth="0.9" opacity={0.75 - i * 0.1}
                strokeDasharray="1 4" />
      ))}
      {/* streets faded underneath */}
      <g stroke="#c4b58a" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.55">
        {STREETS.map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      {STREETS.filter(s => s.kind === "arterial").map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2} fontSize="8" textAnchor="middle"
                fontFamily="'Inter', sans-serif" fill="#7b6a3b" fontWeight={500}
                stroke="#F6F2E7" strokeWidth="2" paintOrder="stroke fill" opacity="0.8"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      {/* distance rings label */}
      {[{ r: 70, t: "2 min walk" }, { r: 180, t: "5 min walk" }].map((ring, i) => (
        <text key={i} x={boardP.x + ring.r * Math.cos(Math.PI / 6)}
              y={boardP.y + ring.r * Math.sin(Math.PI / 6) - 3}
              fontSize="8" fontFamily="'Inter', sans-serif" fill="#7b6a3b" fontStyle="italic">
          {ring.t}
        </text>
      ))}
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3.5} fill="#fff" stroke={color}
                    strokeWidth={isEnd ? 2.4 : 1.4} />
            {isEnd && (
              <text x={p.x} y={p.y - 12} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a"
                    stroke="#F6F2E7" strokeWidth="3" paintOrder="stroke fill">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 8: Heatmap-like block density ─────────────────────────────

const Style8_Density: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 360;
  const { project } = useProj(stopCoords, segStops, W, H, 20);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  // Density heat — use density of BUILDINGS proximity as a proxy
  // Draw faint hot spots around each building.
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#1F2B36", borderRadius: 10 }}>
      <defs>
        <radialGradient id="g8" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e47b8e" stopOpacity="0.7" />
          <stop offset="50%" stopColor="#e0a070" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#1F2B36" stopOpacity="0" />
        </radialGradient>
      </defs>
      {BUILDINGS.map((b, i) => {
        const p = project(b);
        return <circle key={i} cx={p.x} cy={p.y} r="55" fill="url(#g8)" />;
      })}
      <g stroke="#3b4c5e" strokeWidth="1" fill="none" strokeLinecap="round">
        {STREETS.map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      <g stroke="#6e809a" strokeWidth="2.4" fill="none" strokeLinecap="round">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      {STREETS.filter(s => s.kind === "arterial").map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2} fontSize="8" textAnchor="middle"
                fontFamily="'JetBrains Mono', monospace" fill="#c8d3e1" fontWeight={600}
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="2.5"
            strokeDasharray="1 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 8 : 3.5} fill="#1F2B36"
                    stroke={color} strokeWidth={isEnd ? 2.6 : 1.5} />
            {isEnd && (
              <text x={p.x} y={p.y - 13} fontSize="10.5" fontWeight={700} textAnchor="middle"
                    fontFamily="'JetBrains Mono', monospace" fill="#fff">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 9: Campus-zone highlight (streets faint, campus glows) ────

const Style9_Campus: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 360;
  const { project } = useProj(stopCoords, segStops, W, H, 30);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  // Compute Yale campus bounding box from buildings
  const bldgRects = BUILDINGS.map(b => buildingRect(b, project));
  const campus = {
    x: Math.min(...bldgRects.map(r => r.x)) - 10,
    y: Math.min(...bldgRects.map(r => r.y)) - 10,
    w: Math.max(...bldgRects.map(r => r.x + r.w)) - Math.min(...bldgRects.map(r => r.x)) + 20,
    h: Math.max(...bldgRects.map(r => r.y + r.h)) - Math.min(...bldgRects.map(r => r.y)) + 20,
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#F4F1E8", borderRadius: 10 }}>
      {/* faint streets */}
      <g stroke="#cbc2a8" strokeWidth="1.6" fill="none" strokeLinecap="round">
        {STREETS.map((s, i) => <path key={i} d={streetPath(s.points, project)} />)}
      </g>
      {/* Yale campus glow */}
      <rect x={campus.x} y={campus.y} width={campus.w} height={campus.h} rx={12}
            fill="#E9D899" opacity="0.5" stroke="#b0962f" strokeWidth="1" strokeDasharray="4 4" />
      {/* Buildings */}
      {BUILDINGS.map((b, i) => {
        const r = buildingRect(b, project);
        return (
          <g key={i}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#E2C97A" stroke="#8f6b10" strokeWidth="0.6" rx={1.5} />
          </g>
        );
      })}
      {/* Campus label */}
      <text x={campus.x + campus.w / 2} y={campus.y - 6} fontSize="11" fontWeight={700}
            textAnchor="middle" fontFamily="'Inter', sans-serif" fill="#6b5010"
            letterSpacing="3">
        YALE CAMPUS
      </text>
      {/* arterial labels */}
      {STREETS.filter(s => s.kind === "arterial").map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2} fontSize="8" textAnchor="middle"
                fontFamily="'Inter', sans-serif" fill="#8a7a50"
                stroke="#F4F1E8" strokeWidth="2" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="7"
            strokeLinecap="round" strokeLinejoin="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3} fill="#fff" stroke={color}
                    strokeWidth={isEnd ? 2.4 : 1.4} />
            {isEnd && (
              <text x={p.x} y={p.y - 11} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'Inter', sans-serif" fill="#1a1a1a">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Style 10: Full-detail OSM-dense ─────────────────────────────────

const Style10_Dense: FC<TripProps> = ({ color, segStops, boardId, alightId, stopNames, stopCoords }) => {
  const W = 600, H = 420;
  const { project } = useProj(stopCoords, segStops, W, H, 25);
  const pts = segStops.map((sid) => project(stopCoords[sid])).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#F2EFE6", borderRadius: 10 }}>
      {/* Parks */}
      {GREENS.map((g, i) => {
        const r = greenRect(g, project);
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#BAD387" stroke="#82a246" strokeWidth="0.7" rx={2} />;
      })}
      {/* street casings */}
      <g stroke="#c09566" strokeLinecap="round" fill="none">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="6" />
        ))}
      </g>
      <g stroke="#aaaaaa" strokeLinecap="round" fill="none">
        {STREETS.filter(s => s.kind === "local").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="4" />
        ))}
      </g>
      <g stroke="#FBDC93" strokeLinecap="round" fill="none">
        {STREETS.filter(s => s.kind === "arterial").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="3.8" />
        ))}
      </g>
      <g stroke="#FFFFFF" strokeLinecap="round" fill="none">
        {STREETS.filter(s => s.kind === "local").map((s, i) => (
          <path key={i} d={streetPath(s.points, project)} strokeWidth="2.6" />
        ))}
      </g>
      {/* buildings */}
      {BUILDINGS.map((b, i) => {
        const r = buildingRect(b, project);
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#D7CBB0" stroke="#9a8657" strokeWidth="0.5" />;
      })}
      {/* street labels */}
      {STREETS.map((s, i) => {
        const l = streetLabel(s, project);
        return (
          <text key={i} x={l.x} y={l.y + 2}
                fontSize={s.kind === "arterial" ? 8.5 : 7.5}
                textAnchor="middle" fontFamily="'DejaVu Sans','Arial',sans-serif"
                fill="#2a2a2a"
                fontWeight={s.kind === "arterial" ? 500 : 400}
                stroke="#F2EFE6" strokeWidth="2.2" paintOrder="stroke fill"
                transform={`rotate(${l.angle}, ${l.x}, ${l.y + 2})`}>
            {s.name}
          </text>
        );
      })}
      {/* landmark labels */}
      {LANDMARKS.map((l) => {
        const p = project(l);
        return (
          <text key={l.name} x={p.x} y={p.y - 5} fontSize="8.5" textAnchor="middle"
                fontFamily="'DejaVu Sans','Arial',sans-serif" fill="#5a4320" fontStyle="italic"
                stroke="#F2EFE6" strokeWidth="2.4" paintOrder="stroke fill">
            {l.name}
          </text>
        );
      })}
      <path d={catmullRom(pts)} fill="none" stroke="#fff" strokeWidth="7.5"
            strokeLinecap="round" strokeLinejoin="round" />
      <path d={catmullRom(pts)} fill="none" stroke={color} strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
      {segStops.map((sid, i) => {
        const p = pts[i]; if (!p) return null;
        const isEnd = sid === boardId || sid === alightId;
        return (
          <g key={sid}>
            <circle cx={p.x} cy={p.y} r={isEnd ? 7 : 3} fill={isEnd ? color : "#fff"}
                    stroke={isEnd ? "#fff" : color} strokeWidth={isEnd ? 2.4 : 1.4} />
            {isEnd && (
              <text x={p.x} y={p.y - 11} fontSize="11" fontWeight={700} textAnchor="middle"
                    fontFamily="'DejaVu Sans','Arial',sans-serif" fill="#1a1a1a"
                    stroke="#F2EFE6" strokeWidth="3" paintOrder="stroke fill">
                {shortName(stopNames[sid] ?? "")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Host page ───────────────────────────────────────────────────────

const MinimapReview: FC = () => {
  const [stopNames, setStopNames] = useState<Record<number, string>>({});
  const [stopCoords, setStopCoords] = useState<Record<number, LatLon>>({});
  const [routeStops, setRouteStops] = useState<Record<string, number[]>>({});

  useEffect(() => {
    fetch("https://yale-shuttle.fly.dev/api/buses")
      .then((r) => r.json())
      .then((d) => {
        setStopNames(d.stop_names);
        setStopCoords(d.stop_coords);
        setRouteStops(d.routes);
      });
  }, []);

  if (!Object.keys(stopNames).length) {
    return <div style={{ padding: 40, fontFamily: "Inter, sans-serif" }}>Loading…</div>;
  }

  const routeId = "3";
  const all = routeStops[routeId] ?? [];
  const boardId = 3;
  const alightId = 41;
  const bi = all.indexOf(boardId), ai = all.indexOf(alightId);
  const seg = bi <= ai ? all.slice(bi, ai + 1) : [...all.slice(bi), ...all.slice(0, ai + 1)];
  const props: TripProps = {
    color: "#C62828",
    boardId, alightId,
    segStops: seg, allStops: all, stopNames, stopCoords,
  };

  const entries: Array<{ n: number; title: string; desc: string; cmp: FC<TripProps> }> = [
    { n: 1, title: "Arterials only",              desc: "Just the major streets (Whitney, Prospect, College, Church, Elm, Chapel…). Stark, high-signal.", cmp: Style1_Arterials },
    { n: 2, title: "Route-neighborhood skeleton", desc: "Only the 6 streets nearest to the trip's stops — everything else stripped.", cmp: Style2_Skeleton },
    { n: 3, title: "Blocks (streets as cuts)",    desc: "The whole area is 'land' in beige; streets punch through as bright white gaps. Classic real-map feel.", cmp: Style3_Blocks },
    { n: 4, title: "Streets + building footprints", desc: "Real street grid plus labeled Yale buildings as rectangles (Sterling, Beinecke, SOM, Peabody…).", cmp: Style4_Buildings },
    { n: 5, title: "Transit-only",                 desc: "No streets at all — the full Red loop drawn faintly in gray, trip segment highlighted, all stops labeled.", cmp: Style5_TransitOnly },
    { n: 6, title: "Landmark constellation",       desc: "Night-mode starfield. No streets. Landmarks as labeled bubbles; route threads between them.", cmp: Style6_Constellation },
    { n: 7, title: "Radial from board stop",       desc: "Concentric distance rings (2/5 min walk) around where you board; streets fade underneath.", cmp: Style7_Radial },
    { n: 8, title: "Density heatmap",              desc: "Dark slate; hotspots of warmth around dense building clusters; streets in cool blue lines.", cmp: Style8_Density },
    { n: 9, title: "Campus zone highlight",        desc: "Yale campus filled as a glowing beige zone with buildings inside; streets faint but labeled.", cmp: Style9_Campus },
    { n: 10, title: "Full-detail OSM-dense",       desc: "Streets + casings + buildings + parks + italic landmark labels — max information density.", cmp: Style10_Dense },
  ];

  return (
    <div style={{
      fontFamily: "'Inter', sans-serif", background: "#F5F3EF", minHeight: "100vh",
      padding: "24px 0",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 24px" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 6px", color: "#263238" }}>
          Minimap review · round 4 — different backbones
        </h1>
        <div style={{ fontSize: 12, color: "#546e7a", marginBottom: 24 }}>
          Each design has a genuinely different underlying structure — not just reskinned streets.
          Range: arterials-only, pure transit-only, constellation, building footprints, etc.
          Sample trip: Red · 130 Prospect St (N) → College/Wall (N).
        </div>
        {entries.map(({ n, title, desc, cmp: Cmp }) => (
          <div key={n} style={{
            marginBottom: 24, background: "#fff", borderRadius: 12,
            border: "1px solid #e0ddd8", boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            overflow: "hidden",
          }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #ececec" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#263238" }}>{n}. {title}</div>
              <div style={{ fontSize: 11, color: "#78909c", marginTop: 2 }}>{desc}</div>
            </div>
            <div style={{ padding: 10 }}>
              <Cmp {...props} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MinimapReview;
