import React, { useState, useEffect, useMemo, useRef, type FC } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  stations, routes, stopToStation, routeColorMap, routeNameMap,
  type Station, type Route, type BusData,
} from "./map-data";

// ── SVG constants ──────────────────────────────────────────────────────────

const SVG_W = 960;
const SVG_H = 1120;
const LINE_W = 5;
const DOT_R = 8;
const DOT_R_HOME = 10;
const ARROW_SIZE = 7;
const BUS_R = 12;

// ── Sub-components ─────────────────────────────────────────────────────────

const RouteLine: FC<{ route: Route }> = ({ route }) => (
  <g>
    {route.segments.map((seg, i) => (
      <polyline
        key={i}
        points={seg.points.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke={route.color}
        strokeWidth={LINE_W}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={route.dashed ? "12 6" : undefined}
        strokeOpacity={route.dashed ? 1 : 0.55}
      />
    ))}
  </g>
);

const StationDot: FC<{ station: Station; saved?: boolean; routeColors?: string[] }> = ({ station: s, saved, routeColors = [] }) => {
  const isSaved = saved || s.isHome;
  const numRoutes = Math.max(routeColors.length, 1);
  const r = isSaved ? DOT_R_HOME : DOT_R;
  const fill = isSaved ? "#2E7D32" : "#fff";
  const stroke = isSaved ? "#fff" : "#263238";
  const sw = isSaved ? 3 : 2.5;

  const labelOffset = { l: [-14, 4], r: [14, 4], t: [0, -12], b: [0, 18] };
  const anchor = { l: "end" as const, r: "start" as const, t: "middle" as const, b: "middle" as const };
  const [dx, dy] = labelOffset[s.labelSide];

  // HK MTR style: stretch into oval/pill for multi-route interchanges
  // Each route gets a colored segment inside the pill
  const pillWidth = numRoutes > 1 ? r + (numRoutes - 1) * 5 : r;

  return (
    <g>
      {isSaved && (
        <rect
          x={s.x - pillWidth - 2} y={s.y - r - 2}
          width={(pillWidth + 2) * 2} height={(r + 2) * 2}
          rx={r + 2} fill="none" stroke="#2E7D32" strokeWidth={1.5} opacity={0.3}
        />
      )}
      {numRoutes > 1 ? (
        <>
          {/* Pill outline */}
          <rect
            x={s.x - pillWidth} y={s.y - r}
            width={pillWidth * 2} height={r * 2}
            rx={r} fill={fill} stroke={stroke} strokeWidth={sw}
          />
          {/* Colored segments inside the pill */}
          {routeColors.map((color, i) => {
            const segW = (pillWidth * 2 - sw * 2) / numRoutes;
            const sx = s.x - pillWidth + sw + segW * i;
            return (
              <rect key={i}
                x={sx} y={s.y - r + sw}
                width={segW} height={r * 2 - sw * 2}
                rx={i === 0 ? r - sw : i === numRoutes - 1 ? r - sw : 0}
                fill={color} opacity={0.7}
              />
            );
          })}
        </>
      ) : (
        <circle cx={s.x} cy={s.y} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />
      )}
      {s.dir && (
        <text x={s.x} y={s.y} textAnchor="middle" dominantBaseline="central"
              fontSize={numRoutes > 1 ? 7 : 6} fontWeight={700}
              fill={isSaved ? "#fff" : "#263238"} opacity={0.6}>
          {s.dir}
        </text>
      )}
      <text
        x={s.x + dx}
        y={s.y + dy}
        textAnchor={anchor[s.labelSide]}
        fontSize={isSaved ? 12 : 10.5}
        fontWeight={isSaved ? 700 : 500}
        fill={isSaved ? "#2E7D32" : "#455a64"}
      >
        {s.label}
      </text>
    </g>
  );
};

interface BusMarkerProps {
  bus: BusData;
  station: Station;
  nextStation: Station | null;
  pulse: boolean;
}

const BusMarker: FC<BusMarkerProps> = ({ bus, station, nextStation, pulse }) => {
  const color = routeColorMap[bus.route_id] ?? "#666";
  const name = bus.bus_name.replace("#", "");
  const bx = station.x + 20;
  const by = station.y - 18;
  const headingRad = ((bus.heading - 90) * Math.PI) / 180;

  return (
    <g>
      {/* Pulse ring */}
      <circle cx={bx} cy={by} r={BUS_R + 6} fill={color} opacity={pulse ? 0.3 : 0}>
        <animate attributeName="r" values={`${BUS_R};${BUS_R + 10};${BUS_R}`} dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite" />
      </circle>

      {/* Heading arrow */}
      <line
        x1={bx + Math.cos(headingRad) * BUS_R}
        y1={by + Math.sin(headingRad) * BUS_R}
        x2={bx + Math.cos(headingRad) * (BUS_R + 10)}
        y2={by + Math.sin(headingRad) * (BUS_R + 10)}
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        opacity={0.8}
      />

      {/* Dot */}
      <circle
        cx={bx} cy={by} r={BUS_R}
        fill={color} stroke="#fff" strokeWidth={2.5}
        style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.25))" }}
      />

      {/* Number */}
      <text x={bx} y={by} textAnchor="middle" dominantBaseline="central"
            fontSize={9} fontWeight={700} fill="#fff">
        {name}
      </text>

      {/* Next-stop blink */}
      {nextStation && (
        <circle cx={nextStation.x} cy={nextStation.y} r={DOT_R} fill="none"
                stroke={color} strokeWidth={3}>
          <animate attributeName="r" values="6;18;6" dur="1.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;0.8;0" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
};

// ── Stop list sidebar ──────────────────────────────────────────────────────

interface RouteListConfig {
  /** Route IDs to pull stops from (first one is primary, rest are merged) */
  routeIds: string[];
  /** Route IDs to match buses against */
  busRouteIds: number[];
  label: string;
  color: string;
  dashed?: boolean;
  sliceStart?: number;
  sliceEnd?: number;
}

const ROUTE_LISTS: RouteListConfig[] = [
  { routeIds: ["3"],  busRouteIds: [3],        label: "Red",           color: "#C62828" },
  { routeIds: ["1"],  busRouteIds: [1],        label: "Blue Day",      color: "#1565C0" },
  { routeIds: ["4"],  busRouteIds: [4],        label: "Blue Weekend",  color: "#42A5F5" },
  { routeIds: ["13"], busRouteIds: [13],       label: "Blue Night",    color: "#1E88E5" },
  { routeIds: ["16"], busRouteIds: [16],       label: "Blue West",     color: "#00838F" },
  { routeIds: ["2"],  busRouteIds: [2],        label: "Orange Day",    color: "#E65100" },
  { routeIds: ["14"], busRouteIds: [14],       label: "Orange Night",  color: "#E65100" },
  { routeIds: ["17"], busRouteIds: [17],       label: "Orange East",   color: "#E65100" },
  { routeIds: ["19"], busRouteIds: [19],       label: "Brown",         color: "#795548" },
  { routeIds: ["8"],  busRouteIds: [8],        label: "Pink",          color: "#AD1457" },
  { routeIds: ["9"],  busRouteIds: [9],        label: "Green",         color: "#43A047" },
  { routeIds: ["10"], busRouteIds: [10],       label: "Purple",        color: "#7B1FA2" },
  { routeIds: ["15"], busRouteIds: [15],       label: "Gold",          color: "#F9A825" },
  { routeIds: ["6"],  busRouteIds: [6],        label: "Grocery TJ",    color: "#5D4037" },
  { routeIds: ["18"], busRouteIds: [18],       label: "Grocery Ham",   color: "#8D6E63" },
];

// Map route_id numbers to our list routeIds for matching buses
const ROUTE_ID_GROUP: Record<number, string> = {
  3: "3", 1: "1", 13: "1", 4: "1", 2: "2", 14: "2", 17: "2", 16: "16",
};

// Map route_id → toggle label for filtering
const ROUTE_ID_TO_TOGGLE: Record<number, string> = {
  1: "Blue", 4: "Blue Weekend", 13: "Blue Night",
  3: "Red",
  2: "Orange", 14: "Orange Night", 17: "Orange East",
  16: "Blue West",
  19: "Brown", 8: "Pink", 9: "Green", 10: "Purple",
  15: "Gold", 6: "Grocery TJ", 18: "Grocery Ham",
};

// Map map-data route.label → toggle label
const ROUTE_LABEL_TO_TOGGLE: Record<string, string> = {
  "Red": "Red", "Red NB": "Red", "Red SB": "Red",
  "Blue": "Blue", "Blue Weekend": "Blue Weekend", "Blue Night": "Blue Night", "Blue West": "Blue West",
  "Orange": "Orange", "Orange Night": "Orange Night", "Orange East": "Orange East",
  "Brown": "Brown", "Pink": "Pink", "Green": "Green", "Purple": "Purple",
  "Gold": "Gold", "Grocery TJ": "Grocery TJ", "Grocery Ham": "Grocery Ham",
};

type StopGroup = { id: string; name: string; stopIds: number[] };

type SavedTrip = {
  id: string;
  name: string;
  fromText: string; fromLat: number; fromLon: number;
  toText: string; toLat: number; toLon: number;
};

type LatLon = { lat: number; lon: number };

type GeocodeResult = { display_name: string; lat: number; lon: number; type?: string; class?: string };

type TripOption = {
  mode: "shuttle" | "walk";
  routeLabel: string; color: string;
  boardStopId: number; alightStopId: number;
  walkToSec: number; waitSec: number; rideSec: number; walkFromSec: number;
  totalSec: number; busName: string;
  directWalkSec: number;
};

const WALK_SPEED_M_S = 1.3;

function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const BUS_SPEED_M_S = 6;   // fallback speed when segment-time data is missing
const MAX_RIDE_SEC = 25 * 60; // don't keep looping past a boarding point

function planTrip(
  from: LatLon, to: LatLon,
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>,
): TripOption[] {
  const MAX_WALK_M = 1200;
  const directWalkM = haversineMeters(from, to);
  const directWalkSec = directWalkM / WALK_SPEED_M_S;

  const fromDist: Record<number, number> = {};
  const toDist: Record<number, number> = {};
  for (const [k, c] of Object.entries(stopCoords)) {
    const sid = Number(k);
    fromDist[sid] = haversineMeters(from, c);
    toDist[sid] = haversineMeters(to, c);
  }
  const options: TripOption[] = [];

  for (const cfg of ROUTE_LISTS) {
    const stops: number[] = [];
    const seen = new Set<number>();
    for (const rid of cfg.routeIds) {
      for (const sid of (routeStops[rid] ?? [])) {
        if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
      }
    }
    if (stops.length < 2) continue;
    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};

    for (let i = 0; i < stops.length; i++) {
      const b = stops[i];
      if (fromDist[b] === undefined || fromDist[b] > MAX_WALK_M) continue;
      // Compute ride-time cumulatively as we walk forward along the route.
      let cumRide = 0;
      for (let j = i + 1; j < stops.length; j++) {
        const prev = stops[j - 1];
        const cur = stops[j];
        const seg = routeSegs[`${prev}-${cur}`];
        if (seg && seg.n >= 1) {
          cumRide += seg.avg;
        } else {
          // Fall back to haversine / bus-speed when we have no observed
          // segment time. Using a fixed 180 s default inflated long
          // routes to unusable totals whenever a route had no active
          // buses collecting data.
          const pc = stopCoords[prev], cc = stopCoords[cur];
          if (pc && cc) {
            cumRide += Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
          } else {
            cumRide += 90;
          }
        }
        // Stop searching along this route once the ride would wrap past
        // 25 minutes — any further alight would mean the bus is just
        // circling back near the boarding point.
        if (cumRide > MAX_RIDE_SEC) break;
        if (toDist[cur] === undefined || toDist[cur] > MAX_WALK_M) continue;
        const walkToSec = fromDist[b] / WALK_SPEED_M_S;
        const walkFromSec = toDist[cur] / WALK_SPEED_M_S;
        // Skip options that require more total walking than just walking
        // direct — no point suggesting a shuttle that leaves you footsore.
        if (walkToSec + walkFromSec >= directWalkSec) continue;
        // Next bus ETA at boarding stop. Only surface an option when a
        // bus is actually on the route — "what if the weekday route were
        // running" guesses were noisy, and users only want rides they
        // can actually take right now.
        const arrivals = computeUpcomingArrivals([b], buses, routeStops, stopCoords, segmentTimes);
        const next = arrivals.find((a) => a.routeLabel === cfg.label);
        if (!next) continue;
        const waitSec = Math.max(0, next.eta - walkToSec);
        const busName = next.busName;
        const totalSec = walkToSec + waitSec + cumRide + walkFromSec;
        options.push({
          mode: "shuttle",
          routeLabel: cfg.label, color: cfg.color,
          boardStopId: b, alightStopId: cur,
          walkToSec, waitSec, rideSec: cumRide, walkFromSec,
          totalSec, busName,
          directWalkSec,
        });
      }
    }
  }
  // Per-route pick: the option with the shortest walk to the boarding
  // stop, then shortest walk from the alight, then shortest total.
  // Prefers "catch the bus right outside" over "walk 10 min to a stop for
  // a 30-second ride" — even if the latter total is lower.
  const bestPerRoute = new Map<string, TripOption>();
  for (const o of options) {
    const prev = bestPerRoute.get(o.routeLabel);
    const key = (x: TripOption) => x.walkToSec * 1e9 + x.walkFromSec * 1e4 + x.totalSec;
    if (!prev || key(o) < key(prev)) bestPerRoute.set(o.routeLabel, o);
  }
  // Sort the chosen options by total time for display.
  const dedup = [...bestPerRoute.values()]
    .sort((a, b) => a.totalSec - b.totalSec)
    .slice(0, 3);
  // Include the direct-walk option and sort the whole list by totalSec
  // so the FASTEST badge actually lands on the fastest one — previously
  // walk was hard-prepended and always got the badge.
  const walkOption: TripOption = {
    mode: "walk",
    routeLabel: "Walk",
    color: "#546e7a",
    boardStopId: 0, alightStopId: 0,
    walkToSec: 0, waitSec: 0, rideSec: 0, walkFromSec: 0,
    totalSec: directWalkSec, busName: "",
    directWalkSec,
  };
  return [walkOption, ...dedup].sort((a, b) => a.totalSec - b.totalSec);
}

// Leaflet + OSM tile map for a single trip option. Shows start (green),
// end (red), the shuttle boarding/alighting stops and route polyline,
// and dashed lines for the walking segments. Mounts/unmounts with the
// expanded card, so we only hold one map instance at a time.
const TripMap: FC<{
  from: LatLon;
  to: LatLon;
  shuttleStops?: LatLon[];
  bus?: { lat: number; lon: number; name?: string } | null;
  color: string;
}> = ({ from, to, shuttleStops, bus, color }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const points: [number, number][] = [[from.lat, from.lon], [to.lat, to.lon]];

    L.circleMarker([from.lat, from.lon], {
      radius: 8, color: "#fff", fillColor: "#2E7D32", fillOpacity: 1, weight: 2,
    }).addTo(map).bindTooltip("Start", { direction: "top" });
    L.circleMarker([to.lat, to.lon], {
      radius: 8, color: "#fff", fillColor: "#C62828", fillOpacity: 1, weight: 2,
    }).addTo(map).bindTooltip("End", { direction: "top" });

    if (shuttleStops && shuttleStops.length >= 2) {
      const board = shuttleStops[0];
      const alight = shuttleStops[shuttleStops.length - 1];
      for (const s of shuttleStops.slice(1, -1)) {
        L.circleMarker([s.lat, s.lon], {
          radius: 3, color, fillColor: color, fillOpacity: 0.85, weight: 0,
        }).addTo(map);
        points.push([s.lat, s.lon]);
      }
      L.polyline(shuttleStops.map((s) => [s.lat, s.lon] as [number, number]), {
        color, weight: 5, opacity: 0.75,
      }).addTo(map);
      L.circleMarker([board.lat, board.lon], {
        radius: 7, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2.5,
      }).addTo(map).bindTooltip("Board", { direction: "top" });
      L.circleMarker([alight.lat, alight.lon], {
        radius: 7, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2.5,
      }).addTo(map).bindTooltip("Get off", { direction: "top" });
      L.polyline([[from.lat, from.lon], [board.lat, board.lon]], {
        color: "#546e7a", weight: 2, dashArray: "4 6", opacity: 0.85,
      }).addTo(map);
      L.polyline([[alight.lat, alight.lon], [to.lat, to.lon]], {
        color: "#546e7a", weight: 2, dashArray: "4 6", opacity: 0.85,
      }).addTo(map);
      points.push([board.lat, board.lon], [alight.lat, alight.lon]);

      if (bus) {
        const busIcon = L.divIcon({
          className: "bus-pin",
          html: `<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.45));">🚌</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        L.marker([bus.lat, bus.lon], { icon: busIcon, zIndexOffset: 1000 })
          .addTo(map)
          .bindTooltip(bus.name ? `Bus #${bus.name}` : "Bus", { direction: "top" });
        points.push([bus.lat, bus.lon]);
      }
    } else {
      L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
        color: "#546e7a", weight: 2, dashArray: "4 6", opacity: 0.85,
      }).addTo(map);
    }

    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
    // Tile sizes are computed from the container's measured size. When the
    // card expands the div hits layout one frame later, so nudge Leaflet.
    setTimeout(() => map.invalidateSize(), 60);

    return () => { map.remove(); };
  }, []);

  return <div ref={ref} style={{ height: 240, borderRadius: 8, border: "1px solid #e0ddd8", overflow: "hidden", marginBottom: 10 }} />;
};


const TripPlanner: FC<{
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, LatLon>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
  locating?: boolean;
  locateError?: string | null;
  savedTrips: SavedTrip[];
  onSaveTrip: (trip: SavedTrip) => void;
  onDeleteSaved: (id: string) => void;
  recentTrips: SavedTrip[];
  onRecordRecent: (trips: SavedTrip[]) => void;
  onDeleteRecent: (id: string) => void;
  pendingTrip: SavedTrip | null;
  onConsumePending: () => void;
}> = ({ buses, stopNames, stopCoords, routeStops, segmentTimes, userLatLon, onRequestLocate, locating, locateError, savedTrips, onSaveTrip, onDeleteSaved, recentTrips, onRecordRecent, onDeleteRecent, pendingTrip, onConsumePending }) => {
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [fromLL, setFromLL] = useState<LatLon | null>(null);
  const [toLL, setToLL] = useState<LatLon | null>(null);
  const [fromSugg, setFromSugg] = useState<GeocodeResult[]>([]);
  const [toSugg, setToSugg] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState<"from" | "to" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // AbortControllers per field so pickFrom/pickTo can cancel a debounced
  // fetch that was already in flight — otherwise the late response would
  // reopen the dropdown right after the user picked a location.
  const fromAbortRef = useRef<AbortController | null>(null);
  const toAbortRef = useRef<AbortController | null>(null);

  const pickFrom = (g: GeocodeResult) => {
    fromAbortRef.current?.abort();
    fromAbortRef.current = null;
    setFromLL({ lat: g.lat, lon: g.lon });
    setFromText(g.display_name.split(",").slice(0, 2).join(", "));
    setFromSugg([]);
  };
  const pickTo = (g: GeocodeResult) => {
    toAbortRef.current?.abort();
    toAbortRef.current = null;
    setToLL({ lat: g.lat, lon: g.lon });
    setToText(g.display_name.split(",").slice(0, 2).join(", "));
    setToSugg([]);
  };

  const geocode = async (q: string, which: "from" | "to", opts: { autoPick?: boolean } = {}) => {
    if (!q.trim()) return;
    const autoPick = opts.autoPick !== false;
    // Supersede any in-flight fetch for this field, including a stale
    // debounced one from the last keystroke.
    const abortRef = which === "from" ? fromAbortRef : toAbortRef;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(which); setError(null);
    // Nominatim matches poorly on conjunction words like "and" or "&" in
    // intersections. Normalize "X and Y" / "X & Y" → "X Y" before querying.
    const normalized = q.replace(/\s+(?:and|&)\s+/gi, " ").replace(/\s+/g, " ").trim();
    try {
      // Cache-bust: earlier deploys sent max-age=86400, so browsers may
      // still hold a stale response for short queries. A unique query
      // param forces a fresh fetch while the server-side cache still
      // protects upstream geocoders.
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(normalized)}&_=${Date.now()}`, {
        cache: "no-store", signal: controller.signal,
      });
      const d = await r.json();
      // If a newer request (or a pick) has superseded us, bail quietly.
      if (abortRef.current !== controller) return;
      const results: GeocodeResult[] = d.results ?? [];
      if (results.length === 0) {
        if (which === "from") setFromSugg([]); else setToSugg([]);
        if (autoPick) setError("No matches found");
        return;
      }
      // Auto-pick when confidence is high (explicit search only): a Yale
      // landmark, a single result, or an exact address/stop hit. On-type
      // autocomplete always shows the dropdown so typos don't lock in.
      const top = results[0];
      const highConfidence =
        results.length === 1 ||
        top.class === "yale" ||
        top.type === "bus_stop" ||
        top.type === "house";
      if (autoPick && highConfidence) {
        if (which === "from") pickFrom(top); else pickTo(top);
      } else {
        if (which === "from") setFromSugg(results); else setToSugg(results);
      }
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
      if (autoPick) setError("Geocode request failed");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setSearching(null);
      }
    }
  };

  // Debounced autocomplete: fetch suggestions 300ms after the user stops
  // typing. Skips when the field has already been locked to a pick (*LL set)
  // or is showing the "Current location" label. Timer refs let Enter clear
  // a pending debounce so it can't preempt an autoPick fetch moments later.
  const fromTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (fromLL || !fromText.trim() || fromText === "Current location") return;
    fromTimerRef.current = setTimeout(() => {
      fromTimerRef.current = null;
      geocode(fromText, "from", { autoPick: false });
    }, 300);
    return () => {
      if (fromTimerRef.current) { clearTimeout(fromTimerRef.current); fromTimerRef.current = null; }
    };
  }, [fromText, fromLL]);
  useEffect(() => {
    if (toLL || !toText.trim()) return;
    toTimerRef.current = setTimeout(() => {
      toTimerRef.current = null;
      geocode(toText, "to", { autoPick: false });
    }, 300);
    return () => {
      if (toTimerRef.current) { clearTimeout(toTimerRef.current); toTimerRef.current = null; }
    };
  }, [toText, toLL]);

  const [awaitingLocation, setAwaitingLocation] = useState(false);
  const useCurrent = () => {
    console.log("[locate] 📍 clicked; userLatLon:", userLatLon);
    if (userLatLon) {
      setFromLL(userLatLon);
      setFromText("Current location");
      setFromSugg([]);
      return;
    }
    // First click: geolocation isn't resolved yet. Request it and flag
    // that we want to auto-apply the result as soon as it arrives.
    setAwaitingLocation(true);
    onRequestLocate();
  };
  // Auto-apply the user's location once it lands if they had clicked
  // the locate button. Avoids a second click.
  useEffect(() => {
    if (awaitingLocation && userLatLon) {
      setFromLL(userLatLon);
      setFromText("Current location");
      setFromSugg([]);
      setAwaitingLocation(false);
    }
  }, [awaitingLocation, userLatLon]);

  const options = (fromLL && toLL)
    ? planTrip(fromLL, toLL, buses, routeStops, stopCoords, segmentTimes)
    : null;

  // Apply a "plan this saved trip" request from Favorites: fills both
  // fields and clears the pending channel so the next route change doesn't
  // keep re-applying it.
  useEffect(() => {
    if (!pendingTrip) return;
    setFromText(pendingTrip.fromText);
    setFromLL({ lat: pendingTrip.fromLat, lon: pendingTrip.fromLon });
    setFromSugg([]);
    setToText(pendingTrip.toText);
    setToLL({ lat: pendingTrip.toLat, lon: pendingTrip.toLon });
    setToSugg([]);
    onConsumePending();
  }, [pendingTrip]);

  const sameCoords = (a: { fromLat: number; fromLon: number; toLat: number; toLon: number },
                      b: { fromLat: number; fromLon: number; toLat: number; toLon: number }) =>
    Math.abs(a.fromLat - b.fromLat) < 1e-4 && Math.abs(a.fromLon - b.fromLon) < 1e-4
      && Math.abs(a.toLat - b.toLat) < 1e-4 && Math.abs(a.toLon - b.toLon) < 1e-4;

  const alreadySaved = fromLL && toLL && savedTrips.some(
    (t) => sameCoords(t, { fromLat: fromLL.lat, fromLon: fromLL.lon, toLat: toLL.lat, toLon: toLL.lon })
  );

  // Record each newly-planned from+to pair as a recent trip. De-dup by
  // coord, promote most-recent to the front, cap at 10. Skip pairs already
  // in saved so the two lists don't duplicate.
  useEffect(() => {
    if (!fromLL || !toLL || !fromText || !toText) return;
    const key = { fromLat: fromLL.lat, fromLon: fromLL.lon, toLat: toLL.lat, toLon: toLL.lon };
    if (savedTrips.some((t) => sameCoords(t, key))) return;
    const filtered = recentTrips.filter((t) => !sameCoords(t, key));
    const entry: SavedTrip = {
      id: `r${Date.now().toString(36)}`,
      name: `${fromText} → ${toText}`,
      fromText, fromLat: fromLL.lat, fromLon: fromLL.lon,
      toText, toLat: toLL.lat, toLon: toLL.lon,
    };
    const next = [entry, ...filtered].slice(0, 10);
    // Only persist if there's an actual change — avoids a write loop.
    if (next.length !== recentTrips.length || next[0].id !== recentTrips[0]?.id) {
      onRecordRecent(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLL?.lat, fromLL?.lon, toLL?.lat, toLL?.lon]);

  const applyTrip = (t: SavedTrip) => {
    setFromText(t.fromText);
    setFromLL({ lat: t.fromLat, lon: t.fromLon });
    setFromSugg([]);
    setToText(t.toText);
    setToLL({ lat: t.toLat, lon: t.toLon });
    setToSugg([]);
  };
  const handleSaveTrip = () => {
    if (!fromLL || !toLL) return;
    const name = fromText && toText ? `${fromText} → ${toText}` : "Saved trip";
    onSaveTrip({
      id: `t${Date.now().toString(36)}`,
      name,
      fromText, fromLat: fromLL.lat, fromLon: fromLL.lon,
      toText, toLat: toLL.lat, toLon: toLL.lon,
    });
  };

  // When a fresh trip is planned, auto-expand the best shuttle option so the
  // map + board/alight list appear immediately. Depending only on the
  // endpoint coords avoids re-expanding on every bus tick.
  useEffect(() => {
    if (!fromLL || !toLL || !options) { setExpandedIdx(null); return; }
    const idx = options.findIndex((o) => o.mode === "shuttle");
    setExpandedIdx(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLL?.lat, fromLL?.lon, toLL?.lat, toLL?.lon]);

  const fmtMin = (s: number) => {
    const m = Math.round(s / 60);
    return m < 1 ? "<1m" : `${m}m`;
  };
  const fmtClock = (s: number) => {
    const d = new Date(Date.now() + s * 1000);
    let h = d.getHours();
    const mm = d.getMinutes();
    const ampm = h >= 12 ? "p" : "a";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(mm).padStart(2, "0")}${ampm}`;
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, fontSize: 13, padding: "6px 10px",
    border: "1px solid #ccc", borderRadius: 8, fontFamily: "inherit",
  };
  const btnStyle: React.CSSProperties = {
    padding: "6px 12px", borderRadius: 8, border: "1px solid #bbb",
    background: "#fff", color: "#546e7a", fontSize: 12,
    cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
  };

  const renderTripRow = (t: SavedTrip, onDelete: () => void, starred: boolean) => (
    <div key={t.id} style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "5px 8px", borderRadius: 4, background: "#fff",
      border: "1px solid #e0ddd8", cursor: "pointer",
    }} onClick={() => applyTrip(t)}>
      {starred && <span style={{ color: "#2E7D32", fontSize: 10 }}>★</span>}
      <span style={{
        flex: 1, minWidth: 0, fontSize: 11, color: "#263238",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        <span style={{ color: "#2E7D32", fontWeight: 600 }}>{t.fromText}</span>
        <span style={{ color: "#9e9e9e", margin: "0 4px" }}>→</span>
        <span style={{ color: "#C62828", fontWeight: 600 }}>{t.toText}</span>
      </span>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{
        border: "none", background: "transparent", color: "#9e9e9e",
        fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
      }} title="Remove">✕</button>
    </div>
  );

  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", padding: "8px 16px" }}>
      {/* From field */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#78909c", marginBottom: 3, letterSpacing: 1, textTransform: "uppercase" }}>From</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={fromText} onChange={(e) => { setFromText(e.target.value); setFromLL(null); }}
                 onKeyDown={(e) => {
                   if (e.key !== "Enter") return;
                   if (fromTimerRef.current) { clearTimeout(fromTimerRef.current); fromTimerRef.current = null; }
                   if (fromSugg.length > 0) pickFrom(fromSugg[0]);
                   else geocode(fromText, "from");
                 }}
                 placeholder="Address or place" style={inputStyle} />
          <button onClick={useCurrent} disabled={locating} style={btnStyle} title="Use current location">
            {locating || awaitingLocation ? "…" : "📍"}
          </button>
          <button onClick={() => geocode(fromText, "from")} disabled={searching === "from"} style={btnStyle}>
            {searching === "from" ? "…" : "Search"}
          </button>
        </div>
        {fromSugg.length > 0 && (
          <div style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginTop: 4, background: "#fff" }}>
            {fromSugg.map((g, i) => (
              <div key={i} onClick={() => pickFrom(g)}
                   style={{ padding: "6px 10px", fontSize: 11, cursor: "pointer", borderBottom: i === fromSugg.length - 1 ? "none" : "1px solid #f0ede8" }}>
                {g.display_name}
              </div>
            ))}
          </div>
        )}
        {fromLL && <div style={{ fontSize: 10, color: "#2E7D32", marginTop: 3 }}>✓ Set</div>}
        {locateError && (
          <div style={{ fontSize: 10, color: "#C62828", marginTop: 3 }}>
            📍 {locateError}
          </div>
        )}
      </div>

      {/* To field */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#78909c", marginBottom: 3, letterSpacing: 1, textTransform: "uppercase" }}>To</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={toText} onChange={(e) => { setToText(e.target.value); setToLL(null); }}
                 onKeyDown={(e) => {
                   if (e.key !== "Enter") return;
                   if (toTimerRef.current) { clearTimeout(toTimerRef.current); toTimerRef.current = null; }
                   if (toSugg.length > 0) pickTo(toSugg[0]);
                   else geocode(toText, "to");
                 }}
                 placeholder="Address or place" style={inputStyle} />
          <button onClick={() => geocode(toText, "to")} disabled={searching === "to"} style={btnStyle}>
            {searching === "to" ? "…" : "Search"}
          </button>
        </div>
        {toSugg.length > 0 && (
          <div style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginTop: 4, background: "#fff" }}>
            {toSugg.map((g, i) => (
              <div key={i} onClick={() => pickTo(g)}
                   style={{ padding: "6px 10px", fontSize: 11, cursor: "pointer", borderBottom: i === toSugg.length - 1 ? "none" : "1px solid #f0ede8" }}>
                {g.display_name}
              </div>
            ))}
          </div>
        )}
        {toLL && <div style={{ fontSize: 10, color: "#2E7D32", marginTop: 3 }}>✓ Set</div>}
      </div>

      {savedTrips.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3, padding: "0 2px" }}>Saved</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {savedTrips.map((t) => renderTripRow(t, () => onDeleteSaved(t.id), true))}
          </div>
        </div>
      )}
      {recentTrips.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3, padding: "0 2px" }}>Recent</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {recentTrips.slice(0, 5).map((t) => renderTripRow(t, () => onDeleteRecent(t.id), false))}
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: "#C62828", marginBottom: 8 }}>{error}</div>}

      {fromLL && toLL && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button
            onClick={handleSaveTrip}
            disabled={!!alreadySaved}
            title={alreadySaved ? "Already saved" : "Save this trip to Favorites"}
            style={{
              fontSize: 11, padding: "4px 10px", borderRadius: 6, fontFamily: "inherit",
              cursor: alreadySaved ? "default" : "pointer",
              border: "1px solid " + (alreadySaved ? "#c5e1a5" : "#bbb"),
              background: alreadySaved ? "#f1f8e9" : "#fff",
              color: alreadySaved ? "#2E7D32" : "#546e7a",
            }}
          >
            {alreadySaved ? "★ Saved" : "☆ Save trip"}
          </button>
        </div>
      )}

      {/* Results */}
      {options && options.length === 0 && (
        <div style={{ fontSize: 12, color: "#9e9e9e", padding: "24px 8px", textAlign: "center" }}>
          No trip options found between these locations.
        </div>
      )}
      {options && options.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {options.length === 1 && options[0].mode === "walk" && (
            <div style={{ fontSize: 11, color: "#78909c", padding: "0 4px 8px" }}>
              Walking beats every shuttle here — no bus nearby saves time.
            </div>
          )}
          {options.map((o, i) => {
            const isBest = i === 0;
            const isExpanded = expandedIdx === i;
            const clickable = true;
            return (
              <div key={i} style={{
                padding: "10px 12px", background: "#fff", borderRadius: 10, marginBottom: 8,
                border: isBest ? "1.5px solid #2E7D32" : "1px solid #e0ddd8",
                boxShadow: isBest ? "0 1px 4px rgba(46,125,50,0.15)" : "0 1px 2px rgba(0,0,0,0.04)",
                cursor: clickable ? "pointer" : "default",
              }}
              onClick={clickable ? () => setExpandedIdx(isExpanded ? null : i) : undefined}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: o.color }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: o.color }}>
                    {o.mode === "walk" ? "🚶 Walk" : o.routeLabel}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#263238" }}>
                    {fmtMin(o.totalSec)}
                  </span>
                  {isBest && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, color: "#2E7D32",
                      background: "#E8F5E9", padding: "2px 6px", borderRadius: 4,
                    }}>FASTEST</span>
                  )}
                  <span style={{ fontSize: 10, color: "#9e9e9e", marginLeft: "auto" }}>
                    arrive {fmtClock(o.totalSec)}
                  </span>
                  {clickable && (
                    <span style={{ fontSize: 10, color: "#90a4ae", marginLeft: 4 }}>
                      {isExpanded ? "▴" : "▾"}
                    </span>
                  )}
                </div>
                {o.mode === "walk" ? null : (
                  <div style={{ fontSize: 11, color: "#546e7a", lineHeight: 1.5 }}>
                    🚶 {fmtMin(o.walkToSec)} to <b>{(stopNames[o.boardStopId] ?? "").replace(/\s*\/\s*/g, "/")}</b>
                    <br />
                    ⏳ wait {fmtMin(o.waitSec)} for {o.busName ? `#${o.busName}` : "next shuttle"}
                    <br />
                    🚌 {fmtMin(o.rideSec)} to <b>{(stopNames[o.alightStopId] ?? "").replace(/\s*\/\s*/g, "/")}</b>
                    <br />
                    🚶 {fmtMin(o.walkFromSec)} to destination
                  </div>
                )}
                {isExpanded && o.mode === "walk" && fromLL && toLL && (
                  <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                    <TripMap from={fromLL} to={toLL} color={o.color} />
                  </div>
                )}
                {isExpanded && o.mode === "shuttle" && (() => {
                  // Find the route config, then slice its stop sequence
                  // from board → alight so users see the exact path the
                  // bus takes — just the relevant stops, not the full loop.
                  const cfg = ROUTE_LISTS.find((c) => c.label === o.routeLabel);
                  if (!cfg) return null;
                  const allStops: number[] = [];
                  const seen = new Set<number>();
                  for (const rid of cfg.routeIds) {
                    for (const sid of (routeStops[rid] ?? [])) {
                      if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
                    }
                  }
                  const bi = allStops.indexOf(o.boardStopId);
                  const ai = allStops.indexOf(o.alightStopId);
                  if (bi === -1 || ai === -1) return null;
                  const segStops = bi <= ai
                    ? allStops.slice(bi, ai + 1)
                    : [...allStops.slice(bi), ...allStops.slice(0, ai + 1)];
                  const segCoords = segStops
                    .map((sid) => stopCoords[sid])
                    .filter((c): c is LatLon => !!c);
                  // Pick the specific bus the option was planned against, so
                  // its current GPS position pins to the route segment.
                  // Normalize "#123" / "123" — the API mixes both forms.
                  const normBus = (s: string) => s.replace(/^#/, "");
                  const busMatch = buses.find((b) =>
                    normBus(b.bus_name) === normBus(o.busName) &&
                    cfg.busRouteIds.includes(b.route_id)
                  );
                  // How many stops until the bus reaches the boarding stop,
                  // going forward around the loop.
                  let stopsAway: number | null = null;
                  if (busMatch) {
                    const busIdx = allStops.indexOf(busMatch.last_stop_id);
                    if (busIdx >= 0) {
                      stopsAway = (bi - busIdx + allStops.length) % allStops.length;
                    }
                  }
                  return (
                    <div style={{
                      marginTop: 10, padding: "8px 10px",
                      background: "#fafaf8", borderRadius: 8,
                      border: "1px solid #ececec",
                    }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
                        <div style={{ flex: "1 1 260px", minWidth: 220 }}>
                          {fromLL && toLL && segCoords.length >= 2 && (
                            <TripMap
                              from={fromLL} to={toLL}
                              shuttleStops={segCoords}
                              bus={busMatch ? { lat: busMatch.lat, lon: busMatch.lon, name: normBus(busMatch.bus_name) } : null}
                              color={o.color}
                            />
                          )}
                        </div>
                        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                          <div style={{ fontSize: 10, color: "#78909c", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Route — {segStops.length} stops, ~{fmtMin(o.rideSec)} ride
                          </div>
                          {stopsAway !== null && (() => {
                            const busEta = o.walkToSec + o.waitSec;
                            const away = stopsAway === 0
                              ? "is at boarding stop"
                              : `is ${stopsAway} stop${stopsAway === 1 ? "" : "s"} away`;
                            return (
                              <div style={{ fontSize: 11, color: o.color, fontWeight: 600, marginBottom: 6 }}>
                                🚌 Bus #{normBus(busMatch!.bus_name)} {away} · arrives in {fmtMin(busEta)} ({fmtClock(busEta)})
                              </div>
                            );
                          })()}
                          <div style={{ position: "relative", paddingLeft: 16 }}>
                            {/* Vertical line connecting the stops */}
                            <span style={{
                              position: "absolute", left: 6, top: 6, bottom: 6,
                              width: 2, background: o.color, opacity: 0.6,
                            }} />
                            {segStops.map((sid, j) => {
                              const isBoard = j === 0;
                              const isAlight = j === segStops.length - 1;
                              const isEnd = isBoard || isAlight;
                              const name = (stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/");
                              return (
                                <div key={j} style={{
                                  position: "relative", display: "flex", alignItems: "center",
                                  padding: isEnd ? "4px 6px" : "2px 0",
                                  marginLeft: isEnd ? -6 : 0,
                                  borderRadius: 4,
                                  background: isEnd ? `${o.color}1f` : "transparent",
                                }}>
                                  <span style={{
                                    position: "absolute", left: isEnd ? -8 : -14, top: "50%",
                                    transform: "translateY(-50%)",
                                    width: isEnd ? 14 : 8, height: isEnd ? 14 : 8,
                                    borderRadius: "50%",
                                    background: isEnd ? o.color : "#fff",
                                    border: `2px solid ${o.color}`,
                                    boxShadow: isEnd ? `0 0 0 2px #fff, 0 0 0 3px ${o.color}` : "none",
                                    boxSizing: "border-box",
                                  }} />
                                  <span style={{
                                    fontSize: 11,
                                    fontWeight: isEnd ? 700 : 400,
                                    color: isEnd ? "#263238" : "#546e7a",
                                    marginLeft: 8,
                                  }}>
                                    {isBoard && <span style={{ fontSize: 9, fontWeight: 800, color: o.color, letterSpacing: 0.5, marginRight: 6 }}>BOARD</span>}
                                    {isAlight && <span style={{ fontSize: 9, fontWeight: 800, color: o.color, letterSpacing: 0.5, marginRight: 6 }}>GET OFF</span>}
                                    {name}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

type UpcomingArrival = {
  eta: number; low: number; high: number;
  routeLabel: string; color: string; busName: string; stopId: number;
};

function computeUpcomingArrivals(
  targetStopIds: number[],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, { lat: number; lon: number }>,
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>,
): UpcomingArrival[] {
  const result: UpcomingArrival[] = [];
  const targetSet = new Set(targetStopIds);
  for (const cfg of ROUTE_LISTS) {
    const seen = new Set<number>();
    const stops: number[] = [];
    for (const rid of cfg.routeIds) {
      for (const sid of (routeStops[rid] ?? [])) {
        if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
      }
    }
    const hitsTarget = stops.some((s) => targetSet.has(s));
    if (!hitsTarget) continue;

    const routeBuses = buses.filter((b) => cfg.busRouteIds.includes(b.route_id));
    if (routeBuses.length === 0) continue;

    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};
    const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
    const avgSeg = segValues.length > 0
      ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
      : 0;
    const fallbackSd = avgSeg * 0.5;

    for (const bus of routeBuses) {
      let busIdx = -1;
      if (bus.lat && bus.lon) {
        let bestD = Infinity;
        for (let i = 0; i < stops.length; i++) {
          const sc = stopCoords[stops[i]];
          if (!sc) continue;
          const d = (bus.lat - sc.lat) ** 2 + (bus.lon - sc.lon) ** 2;
          if (d < bestD) { bestD = d; busIdx = i; }
        }
      }
      if (busIdx === -1) {
        busIdx = stops.indexOf(bus.last_stop_id);
        if (busIdx === -1) continue;
      }

      let cumulative = 0;
      let cumulativeVar = 0;
      const totalStops = stops.length;
      // Only take the FIRST target stop encountered per bus (next time it arrives there).
      const recordedForStop = new Set<number>();
      for (let step = 1; step < totalStops; step++) {
        const prevI = (busIdx + step - 1) % totalStops;
        const curI = (busIdx + step) % totalStops;
        const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
        if (seg && seg.n >= 1) {
          cumulative += seg.avg;
          cumulativeVar += (seg.sd ?? 0) ** 2;
        } else if (avgSeg > 0) {
          cumulative += avgSeg;
          cumulativeVar += fallbackSd * fallbackSd;
        } else {
          // No route-level data yet — estimate from stop-to-stop distance.
          const pc = stopCoords[stops[prevI]], cc = stopCoords[stops[curI]];
          const est = pc && cc
            ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S)
            : 90;
          cumulative += est;
          cumulativeVar += (est * 0.5) ** 2;
        }
        const sid = stops[curI];
        if (targetSet.has(sid) && !recordedForStop.has(sid) && cumulative > 0) {
          recordedForStop.add(sid);
          const sd = Math.sqrt(cumulativeVar);
          result.push({
            eta: cumulative,
            low: Math.max(0, cumulative - sd),
            high: cumulative + sd,
            routeLabel: cfg.label,
            color: cfg.color,
            busName: bus.bus_name.replace("#", ""),
            stopId: sid,
          });
        }
      }
    }
  }
  result.sort((a, b) => a.eta - b.eta);
  return result;
}

function formatClockAt(sec: number): string {
  const d = new Date(Date.now() + sec * 1000);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "p" : "a";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

function formatEtaRange(a: { eta: number; low: number; high: number }): string {
  const lo = Math.round(a.low / 60);
  if (a.eta < 60) return "<1m";
  return `${lo}m`;
}

const NextShuttles: FC<{
  buses: BusData[];
  savedStops: Set<number>;
  stopNames: Record<number, string>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  tick: number;
}> = ({ buses, savedStops, stopNames, stopCoords, routeStops, segmentTimes }) => {
  if (savedStops.size === 0) return null;

  const all = computeUpcomingArrivals(Array.from(savedStops), buses, routeStops, stopCoords, segmentTimes);
  const arrivals: Record<number, UpcomingArrival[]> = {};
  for (const a of all) {
    (arrivals[a.stopId] ??= []).push(a);
  }

  const formatEta = formatEtaRange;
  const formatClock = formatClockAt;

  return (
    <div style={{ width: "100%", maxWidth: 480, margin: "0 auto", padding: "8px 16px" }}>
      {Array.from(savedStops).map((stopId) => {
        const next = (arrivals[stopId] ?? []).slice(0, 2);
        const name = (stopNames[stopId] ?? `Stop ${stopId}`).replace(/\s*\/\s*/g, "/");
        return (
          <div key={stopId} style={{
            padding: "8px 12px",
            background: "#fff", borderRadius: 8, marginBottom: 8,
            border: "1px solid #e0ddd8", boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#2E7D32", marginBottom: 4 }}>
              ★ {name}
            </div>
            {next.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9e9e9e", paddingLeft: 12 }}>no buses incoming</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {next.map((a, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: a.color, flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 700, color: a.color, minWidth: 90 }}>{a.routeLabel}</span>
                    <span style={{ fontWeight: 700, color: "#455a64" }}>
                      {formatEta(a)}
                    </span>
                    <span style={{ color: "#9e9e9e", fontVariantNumeric: "tabular-nums" }}>
                      · {formatClock(a.eta)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// Picker: search a location (or use current), see the nearest ~15 stops on a
// Leaflet map with tap-to-toggle markers and a parallel text list.
const NearbyStopsPicker: FC<{
  selected: Set<number>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  stopNames: Record<number, string>;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
  onToggle: (sid: number) => void;
}> = ({ selected, stopCoords, stopNames, userLatLon, onRequestLocate, onToggle }) => {
  const [text, setText] = useState("");
  const [ll, setLL] = useState<LatLon | null>(null);
  const [sugg, setSugg] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Record<number, L.CircleMarker>>({});

  const pick = (g: GeocodeResult) => {
    abortRef.current?.abort(); abortRef.current = null;
    setLL({ lat: g.lat, lon: g.lon });
    setText(g.display_name.split(",").slice(0, 2).join(", "));
    setSugg([]);
  };

  const geocode = async (q: string, opts: { autoPick?: boolean } = {}) => {
    if (!q.trim()) return;
    const autoPick = opts.autoPick !== false;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true); setError(null);
    const norm = q.replace(/\s+(?:and|&)\s+/gi, " ").replace(/\s+/g, " ").trim();
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(norm)}&_=${Date.now()}`, {
        cache: "no-store", signal: ctrl.signal,
      });
      const d = await r.json();
      if (abortRef.current !== ctrl) return;
      const results: GeocodeResult[] = d.results ?? [];
      if (results.length === 0) {
        setSugg([]);
        if (autoPick) setError("No matches found");
        return;
      }
      const top = results[0];
      const high = results.length === 1 || top.class === "yale" || top.type === "house" || top.type === "bus_stop";
      if (autoPick && high) pick(top); else setSugg(results);
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
      if (autoPick) setError("Lookup failed");
    } finally {
      if (abortRef.current === ctrl) { abortRef.current = null; setSearching(false); }
    }
  };

  useEffect(() => {
    if (ll || !text.trim() || text === "Current location") return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null; geocode(text, { autoPick: false });
    }, 300);
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [text, ll]);

  const useCurrent = () => {
    if (userLatLon) { setLL(userLatLon); setText("Current location"); setSugg([]); return; }
    setAwaiting(true);
    onRequestLocate();
  };
  useEffect(() => {
    if (awaiting && userLatLon) {
      setLL(userLatLon); setText("Current location"); setSugg([]); setAwaiting(false);
    }
  }, [awaiting, userLatLon]);

  const nearbyStops = useMemo(() => {
    if (!ll) return [];
    const rows: { id: number; name: string; lat: number; lon: number; d: number }[] = [];
    for (const [sidStr, c] of Object.entries(stopCoords)) {
      const id = Number(sidStr);
      const dlat = (c.lat - ll.lat) * 111_000;
      const dlon = (c.lon - ll.lon) * 84_000;
      const d = Math.sqrt(dlat * dlat + dlon * dlon);
      rows.push({ id, name: stopNames[id] ?? `Stop ${id}`, lat: c.lat, lon: c.lon, d });
    }
    rows.sort((a, b) => a.d - b.d);
    return rows.slice(0, 15);
  }, [ll?.lat, ll?.lon, stopCoords, stopNames]);

  // Mount the Leaflet map once we have a location. Rebuild when the pinned
  // location changes or the set of nearest stops shifts.
  useEffect(() => {
    if (!mapDivRef.current || !ll) return;
    const map = L.map(mapDivRef.current, { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);
    L.circleMarker([ll.lat, ll.lon], {
      radius: 8, color: "#fff", fillColor: "#2E7D32", fillOpacity: 1, weight: 2,
    }).addTo(map).bindTooltip("You're here", { direction: "top" });
    const points: [number, number][] = [[ll.lat, ll.lon]];
    markersRef.current = {};
    for (const s of nearbyStops) {
      points.push([s.lat, s.lon]);
      const sel = selected.has(s.id);
      const m = L.circleMarker([s.lat, s.lon], {
        radius: sel ? 7 : 5,
        color: "#fff", weight: 2,
        fillColor: sel ? "#1976D2" : "#78909c",
        fillOpacity: 1,
      }).addTo(map).bindTooltip(s.name, { direction: "top" });
      m.on("click", () => onToggle(s.id));
      markersRef.current[s.id] = m;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 17 });
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); markersRef.current = {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ll?.lat, ll?.lon, nearbyStops]);

  // Restyle markers in place when selection changes — avoids tearing down the map.
  useEffect(() => {
    for (const [sidStr, m] of Object.entries(markersRef.current)) {
      const sid = Number(sidStr);
      const sel = selected.has(sid);
      m.setStyle({ radius: sel ? 7 : 5, fillColor: sel ? "#1976D2" : "#78909c" });
    }
  }, [selected]);

  return (
    <div style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginBottom: 8, background: "#fafaf8", padding: 8 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setLL(null); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
            if (sugg.length > 0) pick(sugg[0]); else geocode(text);
          }}
          placeholder="Search a location (address, cafe, landmark)"
          style={{ flex: 1, fontSize: 11, padding: "5px 8px", border: "1px solid #cfd8dc", borderRadius: 4, fontFamily: "inherit" }}
        />
        <button onClick={useCurrent} title="Use current location"
                style={{ fontSize: 11, padding: "4px 8px", border: "1px solid #bbb", background: "#fff", borderRadius: 4, cursor: "pointer" }}>
          {awaiting ? "…" : "📍"}
        </button>
      </div>
      {sugg.length > 0 && (
        <div style={{ border: "1px solid #e0ddd8", borderRadius: 4, background: "#fff", marginBottom: 6 }}>
          {sugg.map((g, i) => (
            <div key={i} onClick={() => pick(g)} style={{
              padding: "4px 8px", fontSize: 11, cursor: "pointer",
              borderBottom: i === sugg.length - 1 ? "none" : "1px solid #f0ede8",
            }}>
              {g.display_name}
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ fontSize: 10, color: "#C62828", marginBottom: 6 }}>{error}</div>}
      {ll && (
        <>
          <div ref={mapDivRef} style={{ height: 240, borderRadius: 6, border: "1px solid #e0ddd8", overflow: "hidden", marginBottom: 6 }} />
          <div style={{ fontSize: 10, color: "#78909c", marginBottom: 4 }}>
            Nearest {nearbyStops.length} stops — tap to toggle
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto" }}>
            {nearbyStops.map((s) => {
              const sel = selected.has(s.id);
              return (
                <div key={s.id} onClick={() => onToggle(s.id)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 4,
                  cursor: "pointer", background: sel ? "#1976D215" : "transparent",
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: sel ? "#1976D2" : "#9e9e9e", flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 11, color: sel ? "#1976D2" : "#263238", fontWeight: sel ? 600 : 400, flex: 1 }}>
                    {s.name.replace(/\s*\/\s*/g, "/")}
                  </span>
                  <span style={{ fontSize: 10, color: "#9e9e9e" }}>
                    {s.d < 1000 ? `${Math.round(s.d)}m` : `${(s.d / 1000).toFixed(1)}km`}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

const FavoriteStopsPage: FC<{
  groups: StopGroup[];
  setGroups: (groups: StopGroup[]) => void;
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  tick: number;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
  savedTrips: SavedTrip[];
  setSavedTrips: (t: SavedTrip[]) => void;
  onPlanTrip: (t: SavedTrip) => void;
}> = ({ groups, setGroups, buses, stopNames, stopCoords, routeStops, segmentTimes, userLatLon, onRequestLocate, savedTrips, setSavedTrips, onPlanTrip }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nearbyGroupId, setNearbyGroupId] = useState<string | null>(null);

  const updateGroup = (id: string, patch: Partial<StopGroup>) => {
    setGroups(groups.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };
  const deleteGroup = (id: string) => {
    setGroups(groups.filter((g) => g.id !== id));
  };
  const addGroup = () => {
    const id = `g${Date.now().toString(36)}`;
    setGroups([...groups, { id, name: "New Group", stopIds: [] }]);
    setEditingId(id);
  };
  const moveGroup = (id: string, dir: -1 | 1) => {
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= groups.length) return;
    const copy = [...groups];
    [copy[idx], copy[next]] = [copy[next], copy[idx]];
    setGroups(copy);
  };

  // All stops, sorted by name — for the add-stop picker
  const allStopEntries = Object.entries(stopNames)
    .map(([sid, n]) => ({ id: Number(sid), name: n }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", padding: "8px 16px" }}>
      {savedTrips.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, padding: "0 4px 6px" }}>
            Saved trips
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e0ddd8", overflow: "hidden" }}>
            {savedTrips.map((t, i) => (
              <div key={t.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                borderBottom: i === savedTrips.length - 1 ? "none" : "1px solid #f0ede8",
              }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#263238", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: "#2E7D32", fontWeight: 700 }}>{t.fromText}</span>
                  <span style={{ color: "#9e9e9e", margin: "0 6px" }}>→</span>
                  <span style={{ color: "#C62828", fontWeight: 700 }}>{t.toText}</span>
                </div>
                <button onClick={() => onPlanTrip(t)} style={{
                  fontSize: 11, padding: "3px 10px", border: "1px solid #2E7D32",
                  background: "#fff", color: "#2E7D32", borderRadius: 4, fontFamily: "inherit", cursor: "pointer",
                }}>Plan</button>
                <button onClick={() => setSavedTrips(savedTrips.filter((x) => x.id !== t.id))} style={{
                  border: "none", background: "transparent", color: "#9e9e9e",
                  fontSize: 14, cursor: "pointer", padding: "0 4px",
                }} title="Remove">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {groups.length === 0 && (
        <div style={{ textAlign: "center", padding: "24px 16px", color: "#9e9e9e", fontSize: 12 }}>
          No stop groups yet. Create one to track arrivals across multiple stops.
        </div>
      )}
      {groups.map((g, idx) => {
        const arrivals = computeUpcomingArrivals(g.stopIds, buses, routeStops, stopCoords, segmentTimes).slice(0, 5);
        const editing = editingId === g.id;
        return (
          <div key={g.id} style={{
            padding: "10px 14px", background: "#fff", borderRadius: 10, marginBottom: 10,
            border: "1px solid #e0ddd8", boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}>
            {/* Header row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              {editing ? (
                <input
                  value={g.name}
                  onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                  onBlur={() => setEditingId(null)}
                  onKeyDown={(e) => { if (e.key === "Enter") setEditingId(null); }}
                  autoFocus
                  style={{
                    flex: 1, fontSize: 13, fontWeight: 700, color: "#2E7D32",
                    border: "1px solid #c5e1a5", background: "#f1f8e9",
                    borderRadius: 4, padding: "2px 6px", fontFamily: "inherit",
                  }}
                />
              ) : (
                <span
                  onClick={() => setEditingId(g.id)}
                  style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "#2E7D32", cursor: "pointer" }}
                >
                  ★ {g.name}
                </span>
              )}
              <button onClick={() => moveGroup(g.id, -1)} disabled={idx === 0} style={{
                border: "none", background: "transparent",
                color: idx === 0 ? "#d0d0d0" : "#78909c",
                fontSize: 14, cursor: idx === 0 ? "default" : "pointer", padding: "0 3px",
              }} title="Move up">▲</button>
              <button onClick={() => moveGroup(g.id, 1)} disabled={idx === groups.length - 1} style={{
                border: "none", background: "transparent",
                color: idx === groups.length - 1 ? "#d0d0d0" : "#78909c",
                fontSize: 14, cursor: idx === groups.length - 1 ? "default" : "pointer", padding: "0 3px",
              }} title="Move down">▼</button>
              <button onClick={() => deleteGroup(g.id)} style={{
                border: "none", background: "transparent", color: "#9e9e9e",
                fontSize: 14, cursor: "pointer", padding: "0 4px",
              }} title="Delete group">✕</button>
            </div>

            {/* Stop chips + add picker */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {g.stopIds.map((sid) => (
                <span key={sid} style={{
                  fontSize: 10.5, padding: "2px 6px", background: "#eceff1",
                  color: "#455a64", borderRadius: 4, display: "inline-flex",
                  alignItems: "center", gap: 4,
                }}>
                  {(stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/")}
                  <button
                    onClick={() => updateGroup(g.id, { stopIds: g.stopIds.filter((s) => s !== sid) })}
                    style={{
                      border: "none", background: "transparent", color: "#78909c",
                      cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1,
                    }}
                    title="Remove"
                  >✕</button>
                </span>
              ))}
              <button
                onClick={() => setNearbyGroupId(nearbyGroupId === g.id ? null : g.id)}
                style={{
                  fontSize: 10.5, padding: "2px 8px", background: nearbyGroupId === g.id ? "#1976D2" : "#fff",
                  border: "1px dashed #b0bec5", color: nearbyGroupId === g.id ? "#fff" : "#546e7a",
                  borderRadius: 4, fontFamily: "inherit", cursor: "pointer",
                }}
              >
                {nearbyGroupId === g.id ? "✓ done" : "🔍 near a place"}
              </button>
              <select
                value=""
                onChange={(e) => {
                  const sid = Number(e.target.value);
                  if (!sid || g.stopIds.includes(sid)) return;
                  updateGroup(g.id, { stopIds: [...g.stopIds, sid] });
                }}
                style={{
                  fontSize: 10.5, padding: "2px 6px", background: "#fff",
                  border: "1px dashed #b0bec5", color: "#546e7a", borderRadius: 4,
                  fontFamily: "inherit", cursor: "pointer",
                }}
              >
                <option value="">+ add stop</option>
                {allStopEntries
                  .filter((s) => !g.stopIds.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
            </div>

            {/* Nearby-a-place picker */}
            {nearbyGroupId === g.id && (
              <NearbyStopsPicker
                selected={new Set(g.stopIds)}
                stopCoords={stopCoords}
                stopNames={stopNames}
                userLatLon={userLatLon}
                onRequestLocate={onRequestLocate}
                onToggle={(sid) => {
                  const has = g.stopIds.includes(sid);
                  updateGroup(g.id, {
                    stopIds: has ? g.stopIds.filter((s) => s !== sid) : [...g.stopIds, sid],
                  });
                }}
              />
            )}

            {/* Arrivals — next 5 across all routes, sorted by ETA */}
            {g.stopIds.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9e9e9e", paddingLeft: 12 }}>add stops to see arrivals</div>
            ) : arrivals.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9e9e9e", paddingLeft: 12 }}>no buses incoming</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {arrivals.map((a, i) => {
                  const sName = (stopNames[a.stopId] ?? `Stop ${a.stopId}`).replace(/\s*\/\s*/g, "/");
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: "50%",
                        background: a.color, flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 700, color: a.color, minWidth: 80 }}>{a.routeLabel}</span>
                      <span style={{ color: "#546e7a", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {sName}
                      </span>
                      <span style={{ fontWeight: 700, color: "#455a64" }}>
                        {formatEtaRange(a)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <button onClick={addGroup} style={{
        width: "100%", padding: "8px 12px", borderRadius: 8,
        border: "1px dashed #b0bec5", background: "transparent",
        color: "#546e7a", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
      }}>
        + New group
      </button>
    </div>
  );
};

const StopGroupsSummary: FC<{
  groups: StopGroup[];
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  tick: number;
}> = ({ groups, buses, stopNames, stopCoords, routeStops, segmentTimes }) => {
  if (groups.length === 0) return null;
  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", padding: "8px 16px" }}>
      {groups.map((g) => {
        const arrivals = computeUpcomingArrivals(g.stopIds, buses, routeStops, stopCoords, segmentTimes).slice(0, 5);
        const name = g.name || "Unnamed";
        return (
          <div key={g.id} style={{
            padding: "8px 12px", background: "#fff", borderRadius: 8, marginBottom: 8,
            border: "1px solid #e0ddd8", boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#2E7D32", marginBottom: 4 }}>
              ★ {name}
            </div>
            {g.stopIds.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9e9e9e", paddingLeft: 12 }}>no stops in group</div>
            ) : arrivals.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9e9e9e", paddingLeft: 12 }}>no buses incoming</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {arrivals.map((a, i) => {
                  const sName = (stopNames[a.stopId] ?? `Stop ${a.stopId}`).replace(/\s*\/\s*/g, "/");
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, color: a.color, minWidth: 80 }}>{a.routeLabel}</span>
                      <span style={{ color: "#546e7a", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {sName}
                      </span>
                      <span style={{ fontWeight: 700, color: "#455a64" }}>{formatEtaRange(a)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const StopList: FC<{
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>;
  tick: number;
  listView: "all" | "favorites" | "accuracy";
  activeOnly?: boolean;
  hiddenRoutes?: Set<string>;
  favoriteStopIds?: Set<number>;
  favorites: Set<string>;
  onToggleFavorite: (routeId: string) => void;
  savedStops: Set<number>;
  onToggleSavedStop: (stopId: number) => void;
}> = ({ buses, stopNames, stopCoords, routeStops, segmentTimes, dwellTimes, tick, listView, activeOnly, hiddenRoutes, favoriteStopIds, favorites, onToggleFavorite, savedStops, onToggleSavedStop }) => {

  // GPS-based: find nearest route stop for each bus
  function nearestRouteStop(bus: BusData, routeIds: string[]): number | null {
    if (!bus.lat || !bus.lon) return null;
    let bestStop: number | null = null;
    let bestD = Infinity;
    for (const rid of routeIds) {
      for (const sid of routeStops[rid] ?? []) {
        const sc = stopCoords[sid];
        if (!sc) continue;
        const dLat = bus.lat - sc.lat;
        const dLon = bus.lon - sc.lon;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestD) { bestD = d; bestStop = sid; }
      }
    }
    return bestStop;
  }
  // Build bus-at-stop lookup: for each config entry, map stopId → bus
  const busLookups: Record<number, Record<number, BusData>> = {}; // keyed by list index
  const nextLookups: Record<number, Set<number>> = {};
  ROUTE_LISTS.forEach((cfg, idx) => {
    busLookups[idx] = {};
    nextLookups[idx] = new Set();
    for (const bus of buses) {
      if (!cfg.busRouteIds.includes(bus.route_id)) continue;
      // Use GPS to find nearest stop on this route (more accurate than last_stop_id)
      const gpsStop = nearestRouteStop(bus, cfg.routeIds);
      const busStop = gpsStop ?? bus.last_stop_id;
      busLookups[idx][busStop] = bus;
      // Compute next stop from the bus's actual route
      const stops = routeStops[String(bus.route_id)];
      if (stops) {
        const i = stops.indexOf(busStop);
        if (i !== -1) nextLookups[idx].add(stops[(i + 1) % stops.length]);
      }
    }
  });

  return (
    <div style={{
      display: "flex", gap: 4, overflowX: "auto",
      padding: "4px 8px", fontSize: 10.5, color: "#455a64",
      maxWidth: "100%",
    }}>
      {ROUTE_LISTS.map((cfg, listIdx) => {
        // Merge stops from all route IDs in this config (deduplicated, preserving order)
        const seen = new Set<number>();
        let stops: number[] = [];
        for (const rid of cfg.routeIds) {
          for (const sid of routeStops[rid] ?? []) {
            if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
          }
        }
        if (stops.length === 0) return null;
        if (cfg.sliceStart !== undefined || cfg.sliceEnd !== undefined) {
          stops = stops.slice(cfg.sliceStart ?? 0, cfg.sliceEnd);
        }
        const busMap = busLookups[listIdx] ?? {};
        const nextSet = nextLookups[listIdx] ?? new Set<number>();
        const hasBuses = Object.keys(busMap).length > 0;
        const primaryRouteId = cfg.routeIds[0];
        const isFav = favorites.has(primaryRouteId);

        // Filter by view
        if (activeOnly && !hasBuses) return null;
        if (listView === "favorites") {
          if (!hasBuses) return null;
          if (favoriteStopIds && favoriteStopIds.size > 0) {
            const hitsFav = stops.some((sid) => favoriteStopIds.has(sid));
            if (!hitsFav) return null;
          } else if (!isFav) {
            return null;
          }
        }
        if (hiddenRoutes) {
          const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
          if (toggle && hiddenRoutes.has(toggle)) return null;
        }
        const blinkOn = tick % 2 === 0;

        return (
          <div key={`${cfg.routeIds.join("-")}-${listIdx}`} style={{
            minWidth: 145, maxWidth: 170, flexShrink: 0,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: cfg.color,
              padding: "4px 10px", letterSpacing: 1, textTransform: "uppercase",
              borderBottom: cfg.dashed
                ? `2px dashed ${cfg.color}`
                : `2px solid ${cfg.color}`,
              marginBottom: 2,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>{cfg.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(primaryRouteId); }}
                style={{ cursor: "pointer", fontSize: 12, opacity: isFav ? 1 : 0.25 }}
              >
                ★
              </span>
            </div>
            {(() => {
              // Pre-compute cumulative ETAs from each bus to downstream stops
              const routeSegs = segmentTimes[primaryRouteId] ?? {};
              const routeDwells = dwellTimes[primaryRouteId] ?? {};

              // Compute average segment time for this route as fallback
              const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
              const avgSeg = segValues.length > 0
                ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
                : 0;

              const etaAtStop: Record<number, { eta: number; low: number; high: number; busName: string; estimated: boolean }> = {};
              for (const [sid, b] of Object.entries(busMap)) {
                const busIdx = stops.indexOf(Number(sid));
                if (busIdx === -1) continue;
                let cumulative = 0;
                let cumulativeVar = 0;
                let hasAnyData = false;
                const totalStops = stops.length;
                const fallbackSd = avgSeg * 0.5;
                // Segments are arrival-to-arrival (include dwell at origin) — don't add dwells separately.
                for (let step = 1; step < totalStops; step++) {
                  const prevIdx = (busIdx + step - 1) % totalStops;
                  const curIdx = (busIdx + step) % totalStops;

                  const seg = routeSegs[`${stops[prevIdx]}-${stops[curIdx]}`];
                  if (seg && seg.n >= 1) {
                    cumulative += seg.avg;
                    cumulativeVar += (seg.sd ?? 0) ** 2;
                    hasAnyData = true;
                  } else if (avgSeg > 0) {
                    cumulative += avgSeg;
                    cumulativeVar += fallbackSd * fallbackSd;
                  } else {
                    break;
                  }
                  if (cumulative > 0) {
                    const sd = Math.sqrt(cumulativeVar);
                    const existing = etaAtStop[stops[curIdx]];
                    if (!existing || cumulative < existing.eta) {
                      etaAtStop[stops[curIdx]] = {
                        eta: cumulative,
                        low: Math.max(0, cumulative - sd),
                        high: cumulative + sd,
                        busName: (b as BusData).bus_name,
                        estimated: !hasAnyData,
                      };
                    }
                  }
                }
              }

              return stops.map((stopId, i) => {
              const name = stopNames[stopId] ?? `Stop ${stopId}`;
              const shortName = name.replace(/ \([NS]\)$/, "").replace(/^\d+ /, "");
              const bus = busMap[stopId];
              const isNext = nextSet.has(stopId);

              const isSaved = savedStops.has(stopId);
              const dwell = (dwellTimes[primaryRouteId] ?? {})[String(stopId)];
              // Only surface significant timing-point dwells (>= 5 min typical).
              const longDwell = dwell && dwell.n >= 3 && dwell.med >= 300 ? dwell : null;
              const dwellLabel = longDwell
                ? (() => {
                    const lo = Math.max(1, Math.round(longDwell.med / 60));
                    const hi = Math.round((longDwell.med + longDwell.sd) / 60);
                    return lo < hi ? `${lo}-${hi}m` : `${lo}m`;
                  })()
                : null;

              return (<React.Fragment key={`${primaryRouteId}-${stopId}-${i}`}>
                <div
                  onClick={() => onToggleSavedStop(stopId)}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: isSaved ? "4px 10px" : "2px 10px",
                    cursor: "pointer",
                    background: bus ? `${cfg.color}18`
                      : isNext && blinkOn ? `${cfg.color}0D`
                      : isSaved ? "#2E7D3220" : "transparent",
                    fontWeight: bus ? 600 : isSaved ? 700 : isNext ? 500 : 400,
                    transition: "all 0.3s",
                    borderLeft: isSaved ? "4px solid #2E7D32" : "4px solid transparent",
                    borderRadius: isSaved ? 4 : 0,
                    margin: isSaved ? "2px 0" : 0,
                    boxShadow: isSaved ? "0 1px 4px rgba(46,125,50,0.15)" : "none",
                  }}
                >
                  <div style={{
                    width: isSaved ? 10 : 6, height: isSaved ? 10 : 6,
                    borderRadius: "50%", flexShrink: 0,
                    background: bus ? cfg.color
                      : isNext && blinkOn ? cfg.color
                      : isSaved ? "#2E7D32" : "#fff",
                    border: `${isSaved ? 2 : 1.5}px solid ${isSaved ? "#2E7D32" : cfg.color}`,
                    boxShadow: isSaved ? "0 0 6px rgba(46,125,50,0.4)"
                      : isNext && blinkOn ? `0 0 6px ${cfg.color}` : "none",
                    transition: "all 0.3s",
                  }} />
                  <span style={{
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: isSaved ? 11.5 : 10,
                    color: isNext ? cfg.color : isSaved ? "#2E7D32" : undefined,
                  }}>
                    {shortName}
                    {longDwell && dwellLabel && !(bus && bus.at_stop_id === stopId) && (
                      <span title={`Often pauses here ~${dwellLabel} (n=${longDwell.n})`}
                            style={{
                              marginLeft: 4, fontSize: 7.5, color: "#fff",
                              background: "#FFA726", borderRadius: 4, padding: "0 3px",
                              fontWeight: 700, verticalAlign: "middle",
                            }}>
                        ⏸ {dwellLabel}
                      </span>
                    )}
                  </span>
                  {etaAtStop[stopId] && !bus && (
                    <span style={{ display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
                      {(() => {
                        const e = etaAtStop[stopId];
                        const lo = Math.round(e.low / 60);
                        const label = `${lo}m`;
                        return (
                          <>
                            <span style={{ fontSize: 8, color: cfg.color, fontWeight: 600, opacity: e.estimated ? 0.5 : 1 }}>
                              {e.estimated ? "~" : ""}{label}
                            </span>
                            <span style={{ fontSize: 8, color: "#9e9e9e", fontVariantNumeric: "tabular-nums", opacity: e.estimated ? 0.5 : 1 }}>
                              {formatClockAt(e.eta)}
                            </span>
                          </>
                        );
                      })()}
                    </span>
                  )}
                  {isSaved && !bus && !isNext && (
                    <span style={{ fontSize: 8, color: "#2E7D32", opacity: 0.6 }}>★</span>
                  )}
                  {bus && (() => {
                    // If bus is parked at a known-dwell stop, count up how long it's been sitting
                    // and show next to the expected dwell: "X:XX / ~Ym"
                    let countdown: string | null = null;
                    if (longDwell && dwellLabel && bus.at_stop_id === stopId && bus.at_stop_since) {
                      const elapsedSec = Math.max(0, (Date.now() - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
                      const totalSec = Math.floor(elapsedSec);
                      const mm = Math.floor(totalSec / 60);
                      const ss = totalSec % 60;
                      const elapsed = mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${ss}s`;
                      countdown = `${elapsed} / ~${dwellLabel}`;
                    }
                    return (
                      <>
                        {countdown && (
                          <span title={longDwell ? `Sitting / typical pause (n=${longDwell.n})` : undefined}
                                style={{
                                  fontSize: 8, fontWeight: 700, color: "#fff",
                                  background: "#FFA726", borderRadius: 6, padding: "0 4px",
                                  lineHeight: "14px", marginRight: 3,
                                }}>
                            ⏸ {countdown}
                          </span>
                        )}
                        <span style={{
                          fontSize: 8, fontWeight: 700, color: "#fff",
                          background: cfg.color, borderRadius: 6, padding: "0 4px",
                          lineHeight: "14px",
                        }}>
                          {bus.bus_name.replace("#", "")}
                        </span>
                      </>
                    );
                  })()}
                  {isNext && !bus && (
                    <span style={{
                      fontSize: 7, fontWeight: 600, color: cfg.color,
                      opacity: blinkOn ? 1 : 0.3,
                      transition: "opacity 0.3s",
                    }}>
                      NEXT
                    </span>
                  )}
                </div>
              </React.Fragment>);
              });
            })()}
          </div>
        );
      })}
    </div>
  );
};

// ── Track loop visualization ───────────────────────────────────────────────

const TRACK_W = 520;
const TRACK_H = 340;
const TRACK_RX = 60;       // corner radius
const TRACK_PAD = 80;      // room for outward labels

/** Compute tangent angle (degrees) at a given t — direction of travel */
function trackTangent(t: number): number {
  const [x1, y1] = trackPoint(t);
  const [x2, y2] = trackPoint((t + 0.001) % 1);
  return Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
}

/** Compute outward normal direction (away from center) at a given t */
function trackNormal(t: number): [number, number] {
  const [x, y] = trackPoint(t);
  const cx = TRACK_W / 2, cy = TRACK_H / 2;
  const dx = x - cx, dy = y - cy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [dx / len, dy / len];
}

/** Compute a point along a rounded-rectangle perimeter (0–1 = full loop) */
function trackPoint(t: number): [number, number] {
  const w = TRACK_W - TRACK_PAD * 2;
  const h = TRACK_H - TRACK_PAD * 2;
  const straight = (w - TRACK_RX * 2) * 2 + (h - TRACK_RX * 2) * 2;
  const curve = 2 * Math.PI * TRACK_RX;
  const perimeter = straight + curve;
  let d = ((t % 1) + 1) % 1 * perimeter;

  const cx = TRACK_PAD, cy = TRACK_PAD;
  const topLen = w - TRACK_RX * 2;
  const rightLen = h - TRACK_RX * 2;

  // Top straight (left to right)
  if (d < topLen) return [cx + TRACK_RX + d, cy];
  d -= topLen;
  // Top-right curve
  const qCurve = Math.PI * TRACK_RX / 2;
  if (d < qCurve) {
    const a = -Math.PI / 2 + (d / qCurve) * (Math.PI / 2);
    return [cx + w - TRACK_RX + Math.cos(a) * TRACK_RX, cy + TRACK_RX + Math.sin(a) * TRACK_RX];
  }
  d -= qCurve;
  // Right straight (top to bottom)
  if (d < rightLen) return [cx + w, cy + TRACK_RX + d];
  d -= rightLen;
  // Bottom-right curve
  if (d < qCurve) {
    const a = (d / qCurve) * (Math.PI / 2);
    return [cx + w - TRACK_RX + Math.cos(a) * TRACK_RX, cy + h - TRACK_RX + Math.sin(a) * TRACK_RX];
  }
  d -= qCurve;
  // Bottom straight (right to left)
  if (d < topLen) return [cx + w - TRACK_RX - d, cy + h];
  d -= topLen;
  // Bottom-left curve
  if (d < qCurve) {
    const a = Math.PI / 2 + (d / qCurve) * (Math.PI / 2);
    return [cx + TRACK_RX + Math.cos(a) * TRACK_RX, cy + h - TRACK_RX + Math.sin(a) * TRACK_RX];
  }
  d -= qCurve;
  // Left straight (bottom to top)
  if (d < rightLen) return [cx, cy + h - TRACK_RX - d];
  d -= rightLen;
  // Top-left curve (from left at (cx, cy+TRACK_RX) to top at (cx+TRACK_RX, cy))
  if (d < qCurve) {
    const a = Math.PI + (d / qCurve) * (Math.PI / 2);
    return [cx + TRACK_RX + Math.cos(a) * TRACK_RX, cy + TRACK_RX + Math.sin(a) * TRACK_RX];
  }
  return [cx + TRACK_RX, cy];
}

interface TrackLoopProps {
  label: string;
  color: string;
  stops: number[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  buses: BusData[];
  savedStops: Set<number>;
  tick: number;
}

const TrackLoop: FC<TrackLoopProps & {
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>;
  routeId: string;
}> = (
  { label, color, stops, stopNames, stopCoords, buses, savedStops, tick, segmentTimes, dwellTimes, routeId }
) => {
  if (stops.length === 0) return null;

  const n = stops.length;

  // Find northernmost stop and use it as offset so it appears at the top of the loop
  let northIdx = 0;
  let maxLat = -Infinity;
  for (let i = 0; i < n; i++) {
    const coord = stopCoords[stops[i]];
    if (coord && coord.lat > maxLat) {
      maxLat = coord.lat;
      northIdx = i;
    }
  }
  // Offset function: rotate stop positions so northIdx maps to t=0 (top of track)
  const toT = (idx: number) => ((idx - northIdx + n) % n) / n;

  // Segment data for this route
  const routeSegs = segmentTimes[routeId] ?? {};
  const segValues = Object.values(routeSegs).filter((s) => s.n >= 1);
  const avgSeg = segValues.length > 0 ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length : 0;

  // Find buses on this route — use GPS to find the nearest route stop
  // (more accurate than last_stop_id which can be stale or zero)
  const busPositions: Array<{ name: string; idx: number; t: number; stationary: boolean; dwellElapsed: number | null; dwellExpected: number | null }> = [];
  for (const bus of buses) {
    let bestIdx = -1;
    if (bus.lat && bus.lon) {
      let bestD2 = Infinity;
      for (let i = 0; i < stops.length; i++) {
        const sc = stopCoords[stops[i]];
        if (!sc) continue;
        const dLat = bus.lat - sc.lat;
        const dLon = bus.lon - sc.lon;
        const d2 = dLat * dLat + dLon * dLon;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
    }
    if (bestIdx === -1) {
      if (bus.last_stop_id === 0) continue;
      bestIdx = stops.indexOf(bus.last_stop_id);
      if (bestIdx === -1) continue;
    }
    // Count up elapsed sitting time if bus is parked at a known long-dwell stop
    let dwellElapsed: number | null = null;
    let dwellExpected: number | null = null;
    const atStopId = bus.at_stop_id ?? stops[bestIdx];
    const atStopIdx = stops.indexOf(atStopId);
    const dw = (dwellTimes[routeId] ?? {})[String(atStopId)];
    if (dw && dw.n >= 3 && dw.med >= 300 && bus.at_stop_since && atStopIdx === bestIdx) {
      dwellElapsed = Math.max(0, (Date.now() - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
      dwellExpected = dw.med;
    }
    busPositions.push({
      name: bus.bus_name.replace("#", ""),
      idx: bestIdx, t: toT(bestIdx),
      stationary: !!bus.stationary,
      dwellElapsed,
      dwellExpected,
    });
  }

  // Compute ETA (+ over/under range) from nearest upstream bus for EVERY stop
  const routeDwells = dwellTimes[routeId] ?? {};
  const stopEtas: Record<number, { eta: number; low: number; high: number }> = {};
  const fallbackSd = avgSeg * 0.5;
  // Segments are arrival-to-arrival (include dwell at origin) — don't add dwells separately.
  for (const bp of busPositions) {
    let cumulative = 0;
    let cumulativeVar = 0;
    for (let step = 1; step < n; step++) {
      const prevIdx = (bp.idx + step - 1) % n;
      const curIdx = (bp.idx + step) % n;

      const seg = routeSegs[`${stops[prevIdx]}-${stops[curIdx]}`];
      if (seg && seg.n >= 1) {
        cumulative += seg.avg;
        cumulativeVar += (seg.sd ?? 0) ** 2;
      } else {
        const a = avgSeg > 0 ? avgSeg : 60;
        cumulative += a;
        cumulativeVar += fallbackSd * fallbackSd;
      }
      const sd = Math.sqrt(cumulativeVar);
      const existing = stopEtas[stops[curIdx]];
      if (!existing || cumulative < existing.eta) {
        stopEtas[stops[curIdx]] = {
          eta: cumulative,
          low: Math.max(0, cumulative - sd),
          high: cumulative + sd,
        };
      }
    }
  }

  // Stops currently hosting a parked bus whose dwell pill is being rendered —
  // suppress the stop-level ⏸Xm hint there to avoid duplication.
  const parkedDwellIdxs = new Set<number>();
  for (const bp of busPositions) {
    if (bp.dwellExpected !== null) parkedDwellIdxs.add(bp.idx);
  }

  // Label ALL stops. Collapse only adjacent N/S twins (back-to-back same-name
  // stops look like one); leave non-adjacent twins labeled so opposite-side
  // occurrences don't turn into unlabeled gaps.
  const labeledStops: Array<{ idx: number; t: number; name: string; saved: boolean; eta: string | null; dwellMin: number | null }> = [];
  let lastLabeledName: string | null = null;
  for (let i = 0; i < n; i++) {
    const rawName = stopNames[stops[i]] ?? `Stop ${stops[i]}`;
    const shortName = rawName.replace(/ \([NS]\)$/, "").replace(/\s*\/\s*/g, "/").trim().slice(0, 16);
    const isSaved = savedStops.has(stops[i]);
    if (shortName === lastLabeledName && !isSaved) continue;
    lastLabeledName = shortName;
    const e = stopEtas[stops[i]];
    let etaStr: string | null = null;
    if (e) {
      if (e.eta < 60) {
        etaStr = "<1m";
      } else {
        etaStr = `${Math.round(e.low / 60)}m`;
      }
    }
    const dw = routeDwells[String(stops[i])];
    const dwellMin = dw && dw.n >= 3 && dw.med >= 300 && !parkedDwellIdxs.has(i) ? Math.round(dw.med / 60) : null;
    labeledStops.push({ idx: i, t: toT(i), name: shortName, saved: isSaved, eta: etaStr, dwellMin });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, width: "100%", maxWidth: TRACK_W }}>
      <div style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
      <svg viewBox={`0 0 ${TRACK_W} ${TRACK_H}`} style={{ width: "100%", maxWidth: TRACK_W, height: "auto", display: "block" }}>
        {/* Track outline */}
        <rect
          x={TRACK_PAD} y={TRACK_PAD}
          width={TRACK_W - TRACK_PAD * 2} height={TRACK_H - TRACK_PAD * 2}
          rx={TRACK_RX} fill="none" stroke={color} strokeWidth={3} opacity={0.15}
        />

        {/* Stop tick marks */}
        {stops.map((_, i) => {
          const [x, y] = trackPoint(toT(i));
          return <circle key={i} cx={x} cy={y} r={1.5} fill={color} opacity={0.25} />;
        })}

        {/* Labeled stops — radial, text pointing outward from center */}
        {labeledStops.map((ls) => {
          const [x, y] = trackPoint(ls.t);
          const [nx, ny] = trackNormal(ls.t);
          // More spacing on top/bottom (vertical normal) than sides
          const isVertical = Math.abs(ny) > Math.abs(nx) * 0.5;
          const offset = isVertical ? 12 : 8;
          const lx = x + nx * offset;
          const ly = y + ny * offset;

          // All angled labels use the same angle: -45° (up-and-to-the-right tilt).
          // Which side of the text touches the loop depends on the dot's position:
          //   top of loop    → anchor=start (text extends up-right, LEFT edge at dot)
          //   bottom of loop → anchor=end   (text extends down-left, RIGHT edge at dot)
          //   right side     → anchor=start (horizontal, LEFT edge at dot)
          //   left side      → anchor=end   (horizontal, RIGHT edge at dot)
          const onBottom = ny > 0;
          const onLeft = nx < 0;
          const isAngled = Math.abs(ny) > Math.abs(nx) * 0.5;
          const angle = isAngled ? -45 : 0;
          // Pick anchor: end for bottom labels and left-side labels
          const textAnchor = (isAngled ? onBottom : onLeft) ? "end" : "start";

          return (
            <g key={`l${ls.idx}`}>
              <circle cx={x} cy={y} r={ls.saved ? 5 : 3}
                      fill={ls.saved ? "#2E7D32" : "#fff"}
                      stroke={ls.saved ? "#fff" : color}
                      strokeWidth={ls.saved ? 2 : 1.5} />
              {ls.dwellMin && (
                <g>
                  <title>Often pauses ~{ls.dwellMin}m here</title>
                  <circle cx={x} cy={y} r={ls.saved ? 9 : 7} fill="none"
                          stroke="#FFA726" strokeWidth={1.5} strokeDasharray="2 2" opacity={0.8} />
                  <text x={x - 8} y={y - 8} textAnchor="end" dominantBaseline="central"
                        fontSize={9} fontWeight={700} fill="#E65100">
                    ⏸{ls.dwellMin}m
                  </text>
                </g>
              )}
              <text
                x={lx} y={ly}
                textAnchor={textAnchor}
                dominantBaseline="central"
                transform={`rotate(${angle}, ${lx}, ${ly})`}
                fontSize={11}
                fill={ls.saved ? "#2E7D32" : "#78909C"}>
                {(() => {
                  const parts = ls.name.split("/").map((p) => p.trim()).filter(Boolean);
                  const nameColor = ls.saved ? "#2E7D32" : "#455a64";
                  const nameWeight = ls.saved ? 700 : 500;
                  const line1 = parts[0];
                  const line2 = parts.slice(1).join("/");
                  const multiline = parts.length > 1;
                  return (
                    <>
                      <tspan fontWeight={nameWeight} fill={nameColor}>{line1}</tspan>
                      {multiline && (
                        <tspan x={lx} dy="1em" dx={textAnchor === "start" ? 6 : -6}
                               fontWeight={nameWeight} fill={nameColor}>
                          {line2}
                        </tspan>
                      )}
                    </>
                  );
                })()}
              </text>
              {ls.eta && (() => {
                // Place ETA on the inside of the loop (opposite side of the dot from the label).
                const etaOffset = 8;
                const ex = x - nx * etaOffset;
                const ey = y - ny * etaOffset;
                const etaAnchor = textAnchor === "start" ? "end" : "start";
                const etaSize = ls.saved ? 11 : 9;
                const etaWeight = ls.saved ? 800 : 700;
                return (
                  <text x={ex} y={ey} textAnchor={etaAnchor} dominantBaseline="central"
                        transform={`rotate(${angle}, ${ex}, ${ey})`}
                        fontSize={etaSize} fontWeight={etaWeight} fill={color}>
                    {ls.eta}
                  </text>
                );
              })()}
            </g>
          );
        })}

        {/* Direction arrows */}
        {[0.15, 0.65].map((t, i) => {
          const [ax, ay] = trackPoint(t);
          const [bx, by] = trackPoint(t + 0.01);
          const angle = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
          return (
            <g key={`arr${i}`} transform={`translate(${ax},${ay}) rotate(${angle})`}>
              <polygon points="5,0 -3,-3 -3,3" fill={color} opacity={0.35} />
            </g>
          );
        })}

        {/* Bus dots — offset when multiple buses at same stop */}
        {busPositions.map((bp, i) => {
          const [x, y] = trackPoint(bp.t);
          // Count how many buses at the same idx, and which offset this one is
          const sameStopBuses = busPositions.filter((b) => b.idx === bp.idx);
          const orderAtStop = sameStopBuses.findIndex((b) => b.name === bp.name);
          // Offset perpendicular to track using normal direction
          const [nx, ny] = trackNormal(bp.t);
          const spacing = 15;
          const offset = sameStopBuses.length > 1
            ? (orderAtStop - (sameStopBuses.length - 1) / 2) * spacing
            : 0;
          const bx = x + nx * offset;
          const by = y + ny * offset;
          return (
            <g key={`b${bp.name}`}>
              <g opacity={bp.stationary ? 0.45 : 1}>
                {!bp.stationary && (
                  <circle cx={bx} cy={by} r={8} fill={color} opacity={0.15}>
                    <animate attributeName="r" values="8;14;8" dur="2s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle cx={bx} cy={by} r={8}
                        fill={bp.stationary ? "#999" : color}
                        stroke="#fff" strokeWidth={1.5}
                        strokeDasharray={bp.stationary ? "2 2" : undefined} />
                <text x={bx} y={by} textAnchor="middle" dominantBaseline="central"
                      fontSize={9} fontWeight={700} fill="#fff">{bp.name}</text>
              </g>
              {bp.dwellElapsed !== null && (() => {
                const s = Math.floor(bp.dwellElapsed);
                const mm = Math.floor(s / 60);
                const ss = s % 60;
                const elapsed = mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${ss}s`;
                const expMin = bp.dwellExpected !== null ? Math.max(1, Math.round(bp.dwellExpected / 60)) : null;
                const label = expMin !== null ? `${elapsed}/~${expMin}m` : elapsed;
                const width = expMin !== null ? 66 : 48;
                return (
                  <g>
                    <rect x={bx - width / 2} y={by + 10} width={width} height={14}
                          rx={3} fill="#FFA726" opacity={0.95} />
                    <text x={bx} y={by + 17} textAnchor="middle" dominantBaseline="central"
                          fontSize={9.5} fontWeight={700} fill="#fff">⏸ {label}</text>
                  </g>
                );
              })()}
            </g>
          );
        })}

        {/* Center label — count placed vs unplaced */}
        {(() => {
          const placed = busPositions.length;
          const unplaced = buses.length - placed;
          return (
            <>
              <text x={TRACK_W / 2} y={TRACK_H / 2 - 4} textAnchor="middle" dominantBaseline="central"
                    fontSize={11} fontWeight={600} fill={color} opacity={0.5}>
                {placed > 0 ? `${placed} bus${placed > 1 ? "es" : ""}` : "no buses"}
              </text>
              {unplaced > 0 && (
                <text x={TRACK_W / 2} y={TRACK_H / 2 + 10} textAnchor="middle" dominantBaseline="central"
                      fontSize={8} fill="#999">
                  +{unplaced} off-route
                </text>
              )}
            </>
          );
        })()}
      </svg>
    </div>
  );
};

// ── Accuracy page ──────────────────────────────────────────────────────────

interface AccuracyStop {
  stop_id: number;
  stop_name: string;
  route_id: number;
  route_name: string;
  route_color: string;
  n: number;
  mae_sec: number;
  bias_sec: number;
  in_range_pct: number;
  buckets?: AccuracyBucket[];
}

interface AccuracyBucket {
  bucket: string;
  n: number;
  in_range_pct: number | null;
  mae_sec: number | null;
  bias_sec: number | null;
  early_tol_sec: number;
  late_tol_sec: number;
}

interface AccuracyData {
  buckets: AccuracyBucket[];
  stops: AccuracyStop[];
  overall: {
    n: number; mae_sec: number; bias_sec: number; in_range_pct: number;
    weighted?: string;
  } | null;
}

function fmtSec(s: number): string {
  const abs = Math.abs(s);
  if (abs < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  return `${m >= 0 ? "" : ""}${m.toFixed(1)}m`;
}

const AccuracyPage: FC<{ data: AccuracyData | null; savedStops: Set<number> }> = ({ data, savedStops }) => {
  if (!data) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 24px", color: "#78909c", fontSize: 13 }}>
        Loading…
      </div>
    );
  }
  if (!data.overall || data.stops.length === 0) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 24px", color: "#78909c", fontSize: 13 }}>
        Not enough data yet. Check back after the buses have run a few loops.
      </div>
    );
  }

  const rows = [...data.stops].sort((a, b) => {
    const aFav = savedStops.has(a.stop_id) ? 1 : 0;
    const bFav = savedStops.has(b.stop_id) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;
    return b.n - a.n;
  });

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "8px 16px" }}>
      <div style={{ textAlign: "center", padding: "16px 8px 20px" }}>
        <div style={{ fontSize: 11, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          ETAs on time
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, color: "#2E7D32", lineHeight: 1 }}>
          {data.overall.in_range_pct}%
        </div>
        <div style={{ fontSize: 11, color: "#9e9e9e", marginTop: 6 }}>
          avg {fmtSec(data.overall.mae_sec)} off · {data.overall.n.toLocaleString()} samples
        </div>
      </div>

      <div style={{ fontSize: 10, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, padding: "0 4px 6px" }}>
        By stop
      </div>
      <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #e0ddd8", overflow: "hidden" }}>
        {rows.map((r, i) => {
          const isFav = savedStops.has(r.stop_id);
          return (
            <div key={`${r.stop_id}-${r.route_id}`} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px",
              borderBottom: i === rows.length - 1 ? "none" : "1px solid #f0ede8",
              background: isFav ? "#2E7D3208" : "transparent",
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: r.route_color ? `#${r.route_color}` : "#9e9e9e",
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 12, color: "#263238", flex: 1, fontWeight: isFav ? 600 : 400 }}>
                {isFav && "★ "}{r.stop_name}
              </span>
              <span style={{ fontSize: 11, color: "#9e9e9e" }}>±{fmtSec(r.mae_sec)}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#263238", minWidth: 40, textAlign: "right" }}>
                {r.in_range_pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

const TransitMap: FC = () => {
  const [buses, setBuses] = useState<BusData[]>([]);
  const [routeStops, setRouteStops] = useState<Record<string, number[]>>({});
  const [stopNames, setStopNames] = useState<Record<number, string>>({});
  const [segmentTimes, setSegmentTimes] = useState<Record<string, Record<string, { avg: number; sd?: number; n: number }>>>({});
  const [dwellTimes, setDwellTimes] = useState<Record<string, Record<string, { med: number; sd: number; n: number }>>>({});
  const [stopCoords, setStopCoords] = useState<Record<number, { lat: number; lon: number }>>({});
  const [tick, setTick] = useState(0);
  const [hiddenRoutes, setHiddenRoutes] = useState<Set<string>>(new Set());
  const [showMap, setShowMap] = useState(false);
  const [listView, setListView] = useState<"all" | "favorites" | "accuracy" | "trip">(() => {
    const saved = localStorage.getItem("listView");
    return saved === "all" || saved === "favorites" || saved === "accuracy" || saved === "trip" ? saved : "trip";
  });
  useEffect(() => { localStorage.setItem("listView", listView); }, [listView]);
  const [activeOnly, setActiveOnly] = useState(false);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [userLatLon, setUserLatLon] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const watchIdRef = React.useRef<number | null>(null);

  const startLocating = () => {
    console.log("[locate] startLocating called; secure context:", window.isSecureContext, "geo available:", !!navigator.geolocation);
    if (!navigator.geolocation) {
      setLocateError("Geolocation not supported by this browser");
      return;
    }
    if (!window.isSecureContext) {
      setLocateError("Geolocation needs HTTPS");
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        console.log("[locate] got position", pos.coords);
        setUserLatLon({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocating(false);
        if (watchIdRef.current == null) {
          watchIdRef.current = navigator.geolocation.watchPosition(
            (p) => setUserLatLon({ lat: p.coords.latitude, lon: p.coords.longitude }),
            () => {},
            { enableHighAccuracy: true, maximumAge: 30_000 },
          );
        }
      },
      (err) => {
        console.warn("[locate] error", err.code, err.message);
        setLocating(false);
        const msg = err.code === err.PERMISSION_DENIED
          ? "Location permission denied — enable it in your browser settings"
          : err.code === err.POSITION_UNAVAILABLE
          ? "Location unavailable (no GPS / offline?)"
          : err.code === err.TIMEOUT
          ? "Location request timed out"
          : err.message || "Location failed";
        setLocateError(msg);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  useEffect(() => () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);
  const [stopGroups, setStopGroups] = useState<StopGroup[]>(() => {
    try {
      const saved = localStorage.getItem("shuttle-stop-groups");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const saveStopGroups = (g: StopGroup[]) => {
    setStopGroups(g);
    localStorage.setItem("shuttle-stop-groups", JSON.stringify(g));
  };
  const [savedTrips, setSavedTrips] = useState<SavedTrip[]>(() => {
    try {
      const saved = localStorage.getItem("shuttle-saved-trips");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const saveSavedTrips = (t: SavedTrip[]) => {
    setSavedTrips(t);
    localStorage.setItem("shuttle-saved-trips", JSON.stringify(t));
  };
  const [recentTrips, setRecentTrips] = useState<SavedTrip[]>(() => {
    try {
      const saved = localStorage.getItem("shuttle-recent-trips");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const saveRecentTrips = (t: SavedTrip[]) => {
    setRecentTrips(t);
    localStorage.setItem("shuttle-recent-trips", JSON.stringify(t));
  };
  // Channel for "plan this saved trip": Favorites sets it, Trip picks it up
  // on mount / prop change and applies the from+to fields.
  const [pendingTrip, setPendingTrip] = useState<SavedTrip | null>(null);
  const favoriteStopIds = useMemo(
    () => new Set<number>(stopGroups.flatMap((g) => g.stopIds)),
    [stopGroups],
  );

  // Station centroid lat/lons derived from stopCoords — used to map the
  // user's real lat/lon onto the schematic map via inverse-distance weighting.
  const stationLatLon = useMemo(() => {
    const out: { x: number; y: number; lat: number; lon: number }[] = [];
    for (const s of stations) {
      const cs = s.stopIds.map((id) => stopCoords[id]).filter(Boolean);
      if (cs.length === 0) continue;
      const lat = cs.reduce((a, c) => a + c.lat, 0) / cs.length;
      const lon = cs.reduce((a, c) => a + c.lon, 0) / cs.length;
      out.push({ x: s.x, y: s.y, lat, lon });
    }
    return out;
  }, [stopCoords]);

  const userSvgPos = useMemo(() => {
    if (!userLatLon || stationLatLon.length < 3) return null;
    const ds = stationLatLon
      .map((s) => ({ ...s, d: Math.hypot(s.lat - userLatLon.lat, s.lon - userLatLon.lon) }))
      .sort((a, b) => a.d - b.d);
    if (ds[0].d > 0.05) return null; // roughly >3mi away — don't bother
    if (ds[0].d < 1e-6) return { x: ds[0].x, y: ds[0].y };
    const n = Math.min(4, ds.length);
    let sumW = 0, sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) {
      const w = 1 / (ds[i].d * ds[i].d);
      sumW += w; sumX += ds[i].x * w; sumY += ds[i].y * w;
    }
    return { x: sumX / sumW, y: sumY / sumW };
  }, [userLatLon, stationLatLon]);
  const [accuracy, setAccuracy] = useState<AccuracyData | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("shuttle-favorites");
      return saved ? new Set(JSON.parse(saved)) : new Set(["3", "1", "13", "16"]);
    } catch { return new Set(["3", "1", "13", "16"]); }
  });

  const toggleFavorite = (routeId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      localStorage.setItem("shuttle-favorites", JSON.stringify([...next]));
      return next;
    });
  };

  const [savedStops, setSavedStops] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem("shuttle-saved-stops");
      return saved ? new Set(JSON.parse(saved)) : new Set([100]); // Prospect/Canner default
    } catch { return new Set([100]); }
  });

  const toggleSavedStop = (stopId: number) => {
    setSavedStops((prev) => {
      const next = new Set(prev);
      if (next.has(stopId)) next.delete(stopId);
      else next.add(stopId);
      localStorage.setItem("shuttle-saved-stops", JSON.stringify([...next]));
      return next;
    });
  };

  // Keep hiddenRoutes in sync with the current view. On favorites, hide
  // anything that isn't an active favorite. On every other view, reset to
  // empty — otherwise the favorites-hidden state leaks in and the All page
  // ends up with every route filtered out.
  useEffect(() => {
    if (listView !== "favorites") {
      setHiddenRoutes((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const next = new Set<string>();
    for (const cfg of ROUTE_LISTS) {
      const hasBuses = buses.some((b) => cfg.busRouteIds.includes(b.route_id));
      const isFav = favorites.has(cfg.routeIds[0]);
      if (hasBuses && isFav) continue; // keep visible
      const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
      if (toggle) next.add(toggle);
    }
    setHiddenRoutes(next);
  }, [listView, buses, favorites]);

  const toggleRoute = (label: string) => {
    setHiddenRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // (ROUTE_ID_TO_TOGGLE and ROUTE_LABEL_TO_TOGGLE are module-level constants below)

  const isRouteVisible = (routeId: string) => {
    for (const r of routes) {
      if (r.id === routeId) {
        const toggle = ROUTE_LABEL_TO_TOGGLE[r.label] ?? r.label;
        if (hiddenRoutes.has(toggle)) return false;
      }
    }
    return true;
  };

  const isBusVisible = (bus: BusData) => {
    const toggle = ROUTE_ID_TO_TOGGLE[bus.route_id];
    return !toggle || !hiddenRoutes.has(toggle);
  };

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/buses");
        const data = await res.json();
        setBuses(data.buses ?? []);
        if (data.routes) setRouteStops(data.routes);
        if (data.stop_names) setStopNames(data.stop_names);
        if (data.segments) setSegmentTimes(data.segments);
        if (data.dwells) setDwellTimes(data.dwells);
        if (data.stop_coords) setStopCoords(data.stop_coords);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Align to wall-clock seconds so count-up timers never skip a value.
    // setInterval(1000) drifts, which combined with flooring can miss seconds.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = 1000 - (Date.now() % 1000);
      timer = setTimeout(() => {
        setTick((t) => t + 1);
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (listView !== "accuracy") return;
    let cancelled = false;
    const fetchAccuracy = async () => {
      try {
        const res = await fetch("/api/accuracy");
        const data = await res.json();
        if (!cancelled) setAccuracy(data);
      } catch { /* ignore */ }
    };
    fetchAccuracy();
    const id = setInterval(fetchAccuracy, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [listView]);

  const stationMap = new Map(stations.map((s) => [s.id, s]));

  const getNextStation = (bus: BusData): Station | null => {
    const stops = routeStops[String(bus.route_id)];
    if (!stops) return null;
    const idx = stops.indexOf(bus.last_stop_id);
    if (idx === -1) return null;
    const nextId = stops[(idx + 1) % stops.length];
    const key = stopToStation[nextId];
    return key ? stationMap.get(key) ?? null : null;
  };

  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Legend uses base labels for toggling
  const legendRoutes: { label: string; toggleLabel: string; color: string; dashed?: boolean }[] = [
    { label: "Red",          toggleLabel: "Red",          color: "#C62828" },
    { label: "Blue Day",     toggleLabel: "Blue",         color: "#1565C0" },
    { label: "Blue Wknd",    toggleLabel: "Blue Weekend", color: "#42A5F5" },
    { label: "Blue Night",  toggleLabel: "Blue Night",   color: "#1E88E5" },
    { label: "Blue West",   toggleLabel: "Blue West",    color: "#00838F" },
    { label: "Orange",       toggleLabel: "Orange",       color: "#E65100" },
    { label: "Org Night",    toggleLabel: "Orange Night", color: "#E65100", dashed: true },
    { label: "Org East",     toggleLabel: "Orange East",  color: "#E65100" },
    { label: "Brown",        toggleLabel: "Brown",        color: "#795548" },
    { label: "Pink",         toggleLabel: "Pink",         color: "#AD1457" },
    { label: "Green",        toggleLabel: "Green",        color: "#43A047" },
    { label: "Purple",       toggleLabel: "Purple",       color: "#7B1FA2" },
    { label: "Gold",         toggleLabel: "Gold",         color: "#F9A825" },
    { label: "Grocery TJ",   toggleLabel: "Grocery TJ",   color: "#5D4037" },
    { label: "Grocery Ham",  toggleLabel: "Grocery Ham",  color: "#8D6E63" },
  ];

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#F5F3EF", minHeight: "100vh",
                  display: "flex", flexDirection: "column", alignItems: "center" }}>
      {/* Global responsive tweaks */}
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        @media (max-width: 600px) {
          .app-header { padding: 16px 12px 4px !important; }
          .app-tabs { padding: 0 8px !important; }
          .app-tabs button { padding: 4px 10px !important; font-size: 10.5px !important; }
          .pick-label { font-size: 11px !important; }
        }
      `}</style>
      {/* Header */}
      <div className="app-header" style={{
        width: "100%", maxWidth: 1200, padding: "20px 24px 6px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
      }}>
        <h1 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase", margin: 0, textAlign: "center" }}>
          Yale Shuttle
        </h1>
        <span style={{ fontSize: 12, color: "#8a8a9a" }}>{time}</span>
      </div>

      {/* View tabs — horizontally scrollable on narrow screens */}
      <div className="app-tabs" style={{ width: "100%", padding: "0 16px", maxWidth: 1200 }}>
        <div style={{
          display: "flex", gap: 4, padding: "4px 4px 6px", fontSize: 11,
          overflowX: "auto", WebkitOverflowScrolling: "touch",
          justifyContent: "center", flexWrap: "wrap",
        }}>
          {(["trip", "favorites", "all", "accuracy"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setListView(v)}
              style={{
                padding: "4px 14px", borderRadius: 12, border: "none",
                background: listView === v ? "#1a1a2e" : "#e0ddd8",
                color: listView === v ? "#fff" : "#546e7a",
                fontWeight: listView === v ? 600 : 400,
                cursor: "pointer", fontSize: 11,
                fontFamily: "inherit", textTransform: "capitalize",
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Accuracy page */}
      {listView === "accuracy" ? (
        <AccuracyPage data={accuracy} savedStops={savedStops} />
      ) : listView === "trip" ? (
        <TripPlanner
          buses={buses} stopNames={stopNames} stopCoords={stopCoords}
          routeStops={routeStops} segmentTimes={segmentTimes}
          userLatLon={userLatLon} onRequestLocate={startLocating}
          locating={locating} locateError={locateError}
          savedTrips={savedTrips}
          onSaveTrip={(t) => saveSavedTrips([...savedTrips, t])}
          onDeleteSaved={(id) => saveSavedTrips(savedTrips.filter((x) => x.id !== id))}
          recentTrips={recentTrips}
          onRecordRecent={saveRecentTrips}
          onDeleteRecent={(id) => saveRecentTrips(recentTrips.filter((x) => x.id !== id))}
          pendingTrip={pendingTrip} onConsumePending={() => setPendingTrip(null)}
        />
      ) : listView === "favorites" && showGroupSettings ? (
        <div style={{ width: "100%" }}>
          <div style={{ padding: "8px 16px", textAlign: "center" }}>
            <button onClick={() => setShowGroupSettings(false)} style={{
              padding: "4px 16px", borderRadius: 12, border: "1px solid #bbb",
              background: "#fff", color: "#546e7a", fontSize: 11, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit",
            }}>
              ← Done
            </button>
          </div>
          <FavoriteStopsPage
            groups={stopGroups}
            setGroups={saveStopGroups}
            buses={buses}
            stopNames={stopNames}
            stopCoords={stopCoords}
            routeStops={routeStops}
            segmentTimes={segmentTimes}
            tick={tick}
            userLatLon={userLatLon}
            onRequestLocate={startLocating}
            savedTrips={savedTrips}
            setSavedTrips={saveSavedTrips}
            onPlanTrip={(t) => { setPendingTrip(t); setListView("trip"); }}
          />
        </div>
      ) :
      /* Stop lists + map side by side */
      buses.length === 0 && listView === "favorites" ? (
        <div style={{
          width: "100%", maxWidth: 1200, padding: "60px 32px",
          textAlign: "center", color: "#9e9e9e",
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🚌</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#546e7a", marginBottom: 6 }}>
            No shuttles running
          </div>
          <div style={{ fontSize: 13 }}>
            Buses typically run 6 AM – midnight. Check back during service hours.
          </div>
          <button
            onClick={() => setListView("all")}
            style={{
              marginTop: 16, padding: "6px 20px", borderRadius: 12, border: "none",
              background: "#1a1a2e", color: "#fff", fontSize: 12, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            View all routes
          </button>
        </div>
      ) : (
      <>
      {/* Settings button (favorites only) */}
      {listView === "favorites" && (
        <div style={{ padding: "4px 16px 0", display: "flex", justifyContent: "flex-end",
                      maxWidth: 560, margin: "0 auto", width: "100%" }}>
          <button onClick={() => setShowGroupSettings(true)} style={{
            padding: "3px 10px", borderRadius: 10, border: "1px solid #ddd",
            background: "transparent", color: "#546e7a",
            fontSize: 11, cursor: "pointer", fontFamily: "inherit",
          }} title="Edit favorite stop groups">
            ⚙ Edit groups
          </button>
        </div>
      )}

      {/* Stop-group arrivals summary (favorites only) */}
      {listView === "favorites" && stopGroups.length > 0 && (
        <StopGroupsSummary
          groups={stopGroups}
          buses={buses}
          stopNames={stopNames} stopCoords={stopCoords}
          routeStops={routeStops} segmentTimes={segmentTimes} tick={tick}
        />
      )}

      {/* Empty state — no groups yet */}
      {listView === "favorites" && stopGroups.length === 0 && (
        <div style={{
          width: "100%", maxWidth: 480, margin: "16px auto",
          padding: "28px 20px", background: "#fff",
          border: "1px solid #e0ddd8", borderRadius: 10,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⭐</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#263238", marginBottom: 4 }}>
            Add a group to get started
          </div>
          <div style={{ fontSize: 12, color: "#78909c", marginBottom: 16 }}>
            Groups bundle stops you care about so you can see upcoming shuttles at a glance.
          </div>
          <button
            onClick={() => {
              const id = `g${Date.now().toString(36)}`;
              saveStopGroups([{ id, name: "New Group", stopIds: [] }]);
              setShowGroupSettings(true);
            }}
            style={{
              padding: "8px 18px", borderRadius: 10, border: "none",
              background: "#2E7D32", color: "#fff",
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            + Create a group
          </button>
        </div>
      )}

      {/* Stop list above loops on favorites */}
      {listView === "favorites" && (
        <div style={{ width: "100%", padding: "0 16px", display: "flex", justifyContent: "center" }}>
          <StopList
            buses={buses} stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops}
            segmentTimes={segmentTimes} dwellTimes={dwellTimes} tick={tick}
            listView={listView}
            favoriteStopIds={favoriteStopIds}
            favorites={favorites} onToggleFavorite={toggleFavorite}
            savedStops={savedStops} onToggleSavedStop={toggleSavedStop}
          />
        </div>
      )}

      {/* Track loops (favorites only) */}
      {listView === "favorites" && (
        <div style={{
          width: "100%", padding: "8px 16px", display: "flex",
          gap: 8, flexWrap: "wrap", justifyContent: "center",
        }}>
          {ROUTE_LISTS.map((cfg, idx) => {
            const routeBuses = buses.filter((b) => cfg.busRouteIds.includes(b.route_id));
            if (routeBuses.length === 0) return null;
            const allStops: number[] = [];
            const seen = new Set<number>();
            for (const rid of cfg.routeIds) {
              for (const sid of (routeStops[rid] ?? [])) {
                if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
              }
            }
            if (listView === "favorites") {
              if (favoriteStopIds.size > 0) {
                if (!allStops.some((sid) => favoriteStopIds.has(sid))) return null;
              } else if (!favorites.has(cfg.routeIds[0])) {
                return null;
              }
            }
            return (
              <TrackLoop
                key={idx}
                label={cfg.label}
                color={cfg.color}
                stops={allStops}
                stopNames={stopNames}
                stopCoords={stopCoords}
                buses={routeBuses}
                savedStops={savedStops}
                tick={tick}
                segmentTimes={segmentTimes}
                dwellTimes={dwellTimes}
                routeId={cfg.routeIds[0]}
              />
            );
          })}
        </div>
      )}

      {/* Map — hidden until the schematic is polished. Show a placeholder
          on the two views that previously rendered it. */}
      {(listView === "all" || listView === "favorites") && (
        <div style={{
          width: "100%", maxWidth: 560, margin: "16px auto",
          padding: "40px 20px", background: "#fff",
          border: "1px dashed #cfd8dc", borderRadius: 10,
          textAlign: "center",
          color: "#78909c", fontSize: 13, letterSpacing: 0.5,
        }}>
          🗺️ Map coming soon
        </div>
      )}
      {false && (() => {
        const visibleRouteIds = new Set<string>();
        const visibleStopIds = new Set<number>();

        for (const r of routes) {
          const toggle = ROUTE_LABEL_TO_TOGGLE[r.label] ?? r.label;
          if (hiddenRoutes.has(toggle)) continue;
          const matchingList = ROUTE_LISTS.find((cfg) =>
            cfg.busRouteIds.some((bid) => ROUTE_ID_TO_TOGGLE[bid] === toggle)
          );
          if (!matchingList) { visibleRouteIds.add(r.id); continue; }
          const hasBuses = buses.some((b) => matchingList.busRouteIds.includes(b.route_id));
          const isFav = favorites.has(matchingList.routeIds[0]);
          if (listView === "all" && activeOnly && !hasBuses) continue;
          if (listView === "favorites" && !(hasBuses && isFav)) continue;
          visibleRouteIds.add(r.id);
        }

        for (const cfg of ROUTE_LISTS) {
          const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
          if (toggle && hiddenRoutes.has(toggle)) continue;
          const hasBuses = buses.some((b) => cfg.busRouteIds.includes(b.route_id));
          const isFav = favorites.has(cfg.routeIds[0]);
          let show = listView === "all";
          if (listView === "all" && activeOnly) show = hasBuses;
          if (listView === "favorites") show = hasBuses && isFav;
          if (!show) continue;
          for (const rid of cfg.routeIds) {
            for (const sid of (routeStops[rid] ?? [])) visibleStopIds.add(sid);
          }
        }

        return (
          <div style={{ width: "100%", maxWidth: 800, margin: "0 auto", padding: "0 16px" }}>
            {/* Route toggle chips */}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 0 8px", alignItems: "center" }}>
              <button onClick={() => {
                const allLabels = legendRoutes.map((r) => r.toggleLabel);
                const allHidden = allLabels.every((l) => hiddenRoutes.has(l));
                setHiddenRoutes(allHidden ? new Set() : new Set(allLabels));
              }} style={{
                padding: "3px 10px", borderRadius: 10, border: "1px solid #bbb",
                background: "#fff", color: "#546e7a",
                fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}>
                {legendRoutes.every((r) => hiddenRoutes.has(r.toggleLabel)) ? "Show all" : "Hide all"}
              </button>
              {listView === "all" && (
                <button onClick={() => {
                  const enabling = !activeOnly;
                  setActiveOnly(enabling);
                  // When enabling Active, also un-hide every route that
                  // currently has a running bus so they're all shown.
                  if (enabling) {
                    setHiddenRoutes((prev) => {
                      const next = new Set(prev);
                      for (const cfg of ROUTE_LISTS) {
                        const hasBuses = buses.some((b) => cfg.busRouteIds.includes(b.route_id));
                        if (!hasBuses) continue;
                        const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
                        if (toggle) next.delete(toggle);
                      }
                      return next;
                    });
                  }
                }} style={{
                  padding: "3px 10px", borderRadius: 10, border: "1px solid #bbb",
                  background: activeOnly ? "#1a1a2e" : "#fff",
                  color: activeOnly ? "#fff" : "#546e7a",
                  fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}>
                  {activeOnly ? "✓ Active" : "Active"}
                </button>
              )}
              {legendRoutes.map((r) => {
                const hidden = hiddenRoutes.has(r.toggleLabel);
                return (
                  <button key={r.label} onClick={() => { toggleRoute(r.toggleLabel); setActiveOnly(false); }} style={{
                    padding: "3px 10px", borderRadius: 10, border: "none",
                    background: hidden ? "#e8e5e0" : r.color,
                    color: hidden ? "#9e9e9e" : "#fff",
                    fontSize: 10, fontWeight: 600, cursor: "pointer",
                    fontFamily: "inherit", opacity: hidden ? 0.5 : 1,
                    transition: "all 0.2s",
                  }}>
                    {r.label}
                  </button>
                );
              })}
            </div>
            <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ width: "100%", height: "auto" }}>
              {routes.map((r) => visibleRouteIds.has(r.id) ? <RouteLine key={r.id} route={r} /> : null)}
              {stations.map((s) => {
                if (!s.stopIds.some((id) => visibleStopIds.has(id))) return null;
                const isSaved = s.stopIds.some((id) => savedStops.has(id));
                const colors: string[] = [];
                const seenColors = new Set<string>();
                for (const cfg of ROUTE_LISTS) {
                  const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
                  if (toggle && hiddenRoutes.has(toggle)) continue;
                  const hasBus = buses.some((b) => cfg.busRouteIds.includes(b.route_id));
                  const isFav = favorites.has(cfg.routeIds[0]);
                  let show = listView === "all";
                  if (listView === "all" && activeOnly) show = hasBus;
                  if (listView === "favorites") show = hasBus && isFav;
                  if (!show) continue;
                  const routeStopSet = new Set(cfg.routeIds.flatMap((rid) => routeStops[rid] ?? []));
                  if (s.stopIds.some((id) => routeStopSet.has(id)) && !seenColors.has(cfg.color)) {
                    seenColors.add(cfg.color);
                    colors.push(cfg.color);
                  }
                }
                return <StationDot key={s.id} station={s} saved={isSaved} routeColors={colors} />;
              })}
              {buses.filter(isBusVisible).map((bus) => {
                const stnKey = stopToStation[bus.last_stop_id];
                const stn = stnKey ? stationMap.get(stnKey) : undefined;
                if (!stn) return null;
                return (
                  <BusMarker
                    key={bus.bus_id}
                    bus={bus}
                    station={stn}
                    nextStation={getNextStation(bus)}
                    pulse={tick % 2 === 0}
                  />
                );
              })}
              {listView === "all" && userSvgPos && (
                <g>
                  <circle cx={userSvgPos.x} cy={userSvgPos.y} r={18}
                          fill="#1E88E5" opacity={0.15}>
                    <animate attributeName="r" values="14;22;14" dur="2s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.35;0;0.35" dur="2s" repeatCount="indefinite" />
                  </circle>
                  <circle cx={userSvgPos.x} cy={userSvgPos.y} r={8}
                          fill="#1E88E5" stroke="#fff" strokeWidth={2.5} />
                  <title>You are here (approximate)</title>
                </g>
              )}
            </svg>
          </div>
        );
      })()}

      {/* All / Active filter (all view, above the stop list) */}
      {listView === "all" && (
        <div style={{ padding: "8px 16px", textAlign: "center", display: "flex",
                      justifyContent: "center", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setActiveOnly(false)} style={{
            padding: "4px 16px", borderRadius: 12,
            border: !activeOnly ? "1px solid #1a1a2e" : "1px solid #bbb",
            background: !activeOnly ? "#1a1a2e" : "#fff",
            color: !activeOnly ? "#fff" : "#546e7a",
            fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>
            All
          </button>
          <button onClick={() => setActiveOnly(true)} style={{
            padding: "4px 16px", borderRadius: 12,
            border: activeOnly ? "1px solid #1a1a2e" : "1px solid #bbb",
            background: activeOnly ? "#1a1a2e" : "#fff",
            color: activeOnly ? "#fff" : "#546e7a",
            fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>
            Active
          </button>
        </div>
      )}

      {/* Stop list (all view — below the map) */}
      {listView === "all" && (
        <div style={{ width: "100%", padding: "0 16px", display: "flex", justifyContent: "center" }}>
          <StopList
            buses={buses} stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops}
            segmentTimes={segmentTimes} dwellTimes={dwellTimes} tick={tick}
            listView={listView} activeOnly={activeOnly}
            hiddenRoutes={hiddenRoutes}
            favorites={favorites} onToggleFavorite={toggleFavorite}
            savedStops={savedStops} onToggleSavedStop={toggleSavedStop}
          />
        </div>
      )}

      {/* Track loops (bottom of all view) — honor the same visibility filters
          the stop list and map use: hidden routes hide, active-only collapses
          to routes with buses. */}
      {listView === "all" && (
        <div style={{
          width: "100%", padding: "8px 16px", display: "flex",
          gap: 8, flexWrap: "wrap", justifyContent: "center",
        }}>
          {ROUTE_LISTS.map((cfg, idx) => {
            const routeBuses = buses.filter((b) => cfg.busRouteIds.includes(b.route_id));
            const hasBuses = routeBuses.length > 0;
            if (activeOnly && !hasBuses) return null;
            const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
            if (toggle && hiddenRoutes.has(toggle)) return null;
            const allStops: number[] = [];
            const seen = new Set<number>();
            for (const rid of cfg.routeIds) {
              for (const sid of (routeStops[rid] ?? [])) {
                if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
              }
            }
            if (allStops.length < 2) return null;
            return (
              <TrackLoop
                key={idx}
                label={cfg.label}
                color={cfg.color}
                stops={allStops}
                stopNames={stopNames}
                stopCoords={stopCoords}
                buses={routeBuses}
                savedStops={savedStops}
                tick={tick}
                segmentTimes={segmentTimes}
                dwellTimes={dwellTimes}
                routeId={cfg.routeIds[0]}
              />
            );
          })}
        </div>
      )}
      </>
      )}
    </div>
  );
};

export default TransitMap;
