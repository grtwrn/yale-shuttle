import React, { useState, useEffect, useMemo, useRef, Fragment, type FC } from "react";
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

// Published Yale shuttle operating windows, keyed by ROUTE_LISTS label.
// days uses JS getDay() (0=Sun..6=Sat). endMin > 1440 means the window
// extends into the next day's early hours — e.g. 25*60 = 1:00 AM.
// Sources: your.yale.edu daytime/nighttime/weekend routes pages.
type ScheduleWindow = { days: number[]; startMin: number; endMin: number };
const ROUTE_HOURS: Record<string, ScheduleWindow[]> = {
  "Red":          [{ days: [1,2,3,4,5],         startMin: 5*60+40, endMin: 19*60 }],
  "Blue Day":     [{ days: [1,2,3,4,5],         startMin: 7*60,    endMin: 18*60 }],
  "Blue Weekend": [{ days: [0,6],               startMin: 8*60,    endMin: 18*60 }],
  "Blue Night":   [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Blue West":    [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Orange Day":   [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Orange Night": [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Orange East":  [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Brown":        [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Pink":         [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Green":        [{ days: [0,1,2,3,4,5,6],     startMin: 6*60,    endMin: 18*60 }],
  "Purple":       [{ days: [0,1,2,3,4,5,6],     startMin: 6*60,    endMin: 25*60 }],
  "Gold":         [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Grocery TJ":   [{ days: [0,6],               startMin: 10*60,   endMin: 18*60 }],
  "Grocery Ham":  [{ days: [0,6],               startMin: 10*60,   endMin: 18*60 }],
};

// Approximate headway in minutes — used to estimate wait = headway/2 for
// future-date planning when no live bus is running yet. Educated guesses
// from observed Yale service levels; the main routes are faster than the
// evening / weekend ones.
const HEADWAY_MIN: Record<string, number> = {
  "Red": 8, "Blue Day": 10, "Blue Weekend": 20, "Blue Night": 20, "Blue West": 20,
  "Orange Day": 10, "Orange Night": 20, "Orange East": 20,
  "Brown": 15, "Pink": 20, "Green": 15, "Purple": 20, "Gold": 20,
  "Grocery TJ": 30, "Grocery Ham": 30,
};

function fmtScheduleTime(min: number): string {
  // Handles values > 1440 (overnight windows, e.g. 25*60 = 1:00 AM).
  const m = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h >= 12 ? "p" : "a";
  h = h % 12; if (h === 0) h = 12;
  return mm ? `${h}:${String(mm).padStart(2, "0")}${ampm}` : `${h}${ampm}`;
}

function fmtScheduleDays(days: number[]): string {
  const key = [...days].sort().join(",");
  if (key === "0,1,2,3,4,5,6") return "Daily";
  if (key === "1,2,3,4,5") return "M–F";
  if (key === "0,6") return "Sa/Su";
  const names = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];
  return [...days].sort().map((d) => names[d]).join("/");
}

function fmtSchedule(label: string): string {
  const wins = ROUTE_HOURS[label];
  if (!wins || wins.length === 0) return "";
  return wins.map((w) =>
    `${fmtScheduleDays(w.days)} ${fmtScheduleTime(w.startMin)}–${fmtScheduleTime(w.endMin)}`
  ).join(" · ");
}

function isRouteActiveAt(label: string, d: Date): boolean {
  const wins = ROUTE_HOURS[label];
  if (!wins) return true;                    // unknown → don't filter
  const day = d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const w of wins) {
    if (w.endMin <= 1440) {
      if (w.days.includes(day) && mins >= w.startMin && mins < w.endMin) return true;
    } else {
      // Overnight: same-day portion, then previous-day portion < (end-1440)
      if (w.days.includes(day) && mins >= w.startMin) return true;
      const prev = (day + 6) % 7;
      if (w.days.includes(prev) && mins < (w.endMin - 1440)) return true;
    }
  }
  return false;
}

// A bus reported on a route far outside that route's published operating
// window is a ghost — typically a parked shuttle with its transponder left
// on (report #30: a "Red" bus on screen at 5:40 PM on a Sunday; Red runs
// M–F). Filtered at /api/buses ingest so the map, the trip planner, and the
// arrivals boards all agree it doesn't exist. The ±45 min grace keeps real
// buses visible while they finish a last loop after close or pre-position
// before open; a route with no known schedule is never filtered.
const SERVICE_GRACE_MS = 45 * 60 * 1000;
const ROUTE_ID_LABEL: Record<number, string> = {};
for (const cfg of ROUTE_LISTS) for (const rid of cfg.busRouteIds) ROUTE_ID_LABEL[rid] = cfg.label;
function isBusInService(b: BusData): boolean {
  const label = ROUTE_ID_LABEL[b.route_id];
  if (!label) return true;
  const now = Date.now();
  return (
    isRouteActiveAt(label, new Date(now)) ||
    isRouteActiveAt(label, new Date(now - SERVICE_GRACE_MS)) ||
    isRouteActiveAt(label, new Date(now + SERVICE_GRACE_MS))
  );
}

// Next Date at which this route becomes active, starting from `after`.
// Returns null when the route has no schedule at all (treated as
// always-running). Walks forward up to 7 days since every window
// repeats weekly; anything beyond that doesn't exist in our schedule.
function nextActiveWindow(label: string, after: Date): Date | null {
  const wins = ROUTE_HOURS[label];
  if (!wins) return null;
  for (let offset = 0; offset < 7; offset++) {
    const candDay = new Date(after);
    candDay.setDate(candDay.getDate() + offset);
    const dow = candDay.getDay();
    for (const w of wins) {
      if (!w.days.includes(dow)) continue;
      // Offset 0 = same day: window must still be in the future.
      const dayStart = new Date(candDay);
      dayStart.setHours(0, 0, 0, 0);
      const startAt = new Date(dayStart);
      startAt.setMinutes(w.startMin);
      if (offset === 0 && startAt.getTime() <= after.getTime()) continue;
      return startAt;
    }
  }
  return null;
}

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

// Trim geocoder verbosity for the suggestion dropdown: Nominatim returns
// "Indian River, Forest Heights, Fort Trumbull, Milford, South Central
// Connecticut Planning Region, Connecticut, United States" — two segments
// carry all the signal on a phone-width row.
function suggLabel(g: GeocodeResult): string {
  const parts = g.display_name.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join(", ");
}
// Row icon by result kind so stops and landmarks are scannable at a glance.
function suggIcon(g: GeocodeResult): string {
  if (g.type === "bus_stop") return "🚏";
  if (g.class === "yale") return "🏛️";
  return "📍";
}
// Anything this far from campus isn't reachable by a Yale shuttle — the
// geocoder result is noise for this app's purpose.
const SERVICE_CENTER: LatLon = { lat: 41.31, lon: -72.93 };
const SERVICE_RADIUS_M = 8_000;

type TripOption = {
  mode: "shuttle" | "walk";
  routeLabel: string; color: string;
  boardStopId: number; alightStopId: number;
  walkToSec: number; waitSec: number; rideSec: number; walkFromSec: number;
  totalSec: number; busName: string;
  directWalkSec: number;
  // True when the pinned bus has already gone past the board stop and
  // isn't catchable anymore. Set only while the rider is watching the
  // option (expanded) so we stop advancing to the next catchable bus
  // and show "departed" instead of an arrival time.
  departed?: boolean;
  // Set when the originally-planned bus is no longer catchable and we advanced
  // to a later bus. Drives the "#X just passed — next is …" note. Cleared
  // automatically once the missed bus drops out of the live feed.
  missedBus?: string;
};

// An active ride the rider has boarded — drives the on-bus tracking banner.
// Persisted to localStorage so refreshing mid-trip keeps the banner alive.
type BoardedRide = {
  routeLabel: string;
  color: string;
  busName: string;
  boardStopId: number;
  alightStopId: number;
  startedAt: number;
  // Destination from the planner — where the rider is actually going,
  // distinct from the alight stop. Optional for rides started without a plan.
  toLat?: number;
  toLon?: number;
  toText?: string;
};
const BOARDED_LS_KEY = "shuttle-boarded-ride";
function loadBoardedRide(): BoardedRide | null {
  try {
    const raw = localStorage.getItem(BOARDED_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<BoardedRide>;
    if (
      p &&
      typeof p.routeLabel === "string" &&
      typeof p.boardStopId === "number" &&
      typeof p.alightStopId === "number" &&
      // Stale rides don't restore — mirrors the goTrip age cap and the
      // 2 h auto-end, so a forgotten ride can't resurrect days later.
      typeof p.startedAt === "number" &&
      Date.now() - p.startedAt < 2 * 3600_000
    ) {
      return p as BoardedRide;
    }
  } catch {
    /* ignore corrupt value */
  }
  return null;
}
function saveBoardedRide(r: BoardedRide | null): void {
  try {
    if (r) localStorage.setItem(BOARDED_LS_KEY, JSON.stringify(r));
    else localStorage.removeItem(BOARDED_LS_KEY);
  } catch {
    /* quota / private mode — best effort */
  }
}

type AlertedRide = { busName: string; boardStopId: number; routeLabel: string; color: string; dwellStopId?: number };
const ALERTED_LS_KEY = "shuttle-alerted-ride";
function loadAlertedRide(): AlertedRide | null {
  try {
    const raw = localStorage.getItem(ALERTED_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<AlertedRide>;
    if (p && typeof p.busName === "string" && typeof p.boardStopId === "number") return p as AlertedRide;
  } catch { /* ignore */ }
  return null;
}
function saveAlertedRide(r: AlertedRide | null): void {
  try {
    if (r) localStorage.setItem(ALERTED_LS_KEY, JSON.stringify(r));
    else localStorage.removeItem(ALERTED_LS_KEY);
  } catch { /* quota / private mode */ }
}

// A committed "Go" trip — the rider picked one shuttle option and asked to be
// guided through it (walk to stop → wait → ride). Lives at the app level
// because the planner unmounts on tab switches; persisted so a refresh
// mid-walk resumes the guidance instead of dumping the rider back at search.
type GoTrip = {
  routeLabel: string;
  color: string;
  busName: string;
  boardStopId: number;
  alightStopId: number;
  toText: string;
  toLat: number;
  toLon: number;
  startedAt: number;
};
// First-visit shortcuts: well-known campus destinations a new rider can tap
// instead of typing into an empty search box. Coords are geocode-grade.
const POPULAR_DESTS: { name: string; lat: number; lon: number }[] = [
  { name: "Union Station", lat: 41.29752, lon: -72.92651 },
  { name: "Med School (Cedar St)", lat: 41.3029, lon: -72.93395 },
  { name: "Science Hill", lat: 41.31936, lon: -72.92369 },
  { name: "Peabody Museum", lat: 41.31625, lon: -72.92122 },
  { name: "Payne Whitney Gym", lat: 41.3125, lon: -72.93105 },
  { name: "Old Campus", lat: 41.30815, lon: -72.92915 },
];

const GO_LS_KEY = "shuttle-go-trip";
// A go-trip older than 2 h is yesterday's news — don't resurrect it.
const GO_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function loadGoTrip(): GoTrip | null {
  try {
    const raw = localStorage.getItem(GO_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<GoTrip>;
    if (
      p &&
      typeof p.routeLabel === "string" &&
      typeof p.boardStopId === "number" &&
      typeof p.alightStopId === "number" &&
      typeof p.toLat === "number" &&
      typeof p.toLon === "number" &&
      typeof p.startedAt === "number" &&
      Date.now() - p.startedAt < GO_MAX_AGE_MS
    ) {
      return p as GoTrip;
    }
  } catch { /* corrupt value */ }
  return null;
}
function saveGoTrip(g: GoTrip | null): void {
  try {
    if (g) localStorage.setItem(GO_LS_KEY, JSON.stringify(g));
    else localStorage.removeItem(GO_LS_KEY);
  } catch { /* quota / private mode */ }
}

const WALK_SPEED_M_S = 1.3;
// Streets aren't straight lines: crow-flies distance understates real
// walking. Measured against OSRM foot routes across six representative
// campus pairs (ratios 1.05–1.38, mean ~1.22), hence 1.2. Times stay on
// this instant/offline model everywhere so totals are consistent; the
// DRAWN walk path separately upgrades to routed geometry when available.
const WALK_DETOUR = 1.2;
const walkSecFromMeters = (m: number) => (m * WALK_DETOUR) / WALK_SPEED_M_S;

// Initial bearing from a to b, degrees clockwise from north. Drives the
// Go screen's compass arrow (rotated by GPS course when we have one).
function bearingDeg(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

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

// Road-following polylines per (from_stop, to_stop) pair. Fetched from
// OSRM (free public router) on demand; cached in localStorage so each
// segment costs one fetch per device forever. Straight-line is used as
// a fallback when the fetch fails or hasn't landed yet.
// "You are here" divIcon — pulsing blue dot, centered on the coord.
// Blue is the conventional GPS-position color (Google/Apple Maps use
// the same) and keeps the green reserved for route/status confirmations.
const makeYouIcon = () => L.divIcon({
  className: "trip-you",
  html: `
    <div style="position:relative;width:22px;height:22px;">
      <div style="position:absolute;inset:0;border-radius:50%;background:#1976D2;opacity:0.3;animation:youPulse 2s ease-out infinite;"></div>
      <div style="position:absolute;inset:4px;border-radius:50%;background:#1976D2;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>
      <style>
        @keyframes youPulse {
          0%   { transform: scale(0.9); opacity: 0.5; }
          80%  { transform: scale(1.6); opacity: 0; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      </style>
    </div>
  `,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

// Destination pin — classic teardrop pointing down. Anchor is the tip
// so the point sits on the exact coord.
const makeDestPin = () => L.divIcon({
  className: "trip-dest",
  html: `
    <svg width="28" height="36" viewBox="0 0 28 36" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,0.4));">
      <path d="M14 1 C7 1 2 6 2 13 c0 8 12 22 12 22 s12 -14 12 -22 c0 -7 -5 -12 -12 -12 z"
            fill="#C62828" stroke="#fff" stroke-width="2"/>
      <circle cx="14" cy="13" r="5" fill="#fff"/>
    </svg>
  `,
  iconSize: [28, 36],
  iconAnchor: [14, 35],
});

// Given the full route-loop polyline from downtownerapp and a sequence
// of stops, slice the polyline between each consecutive (from, to) stop
// pair and concatenate into one polyline. Handles loop wraparound.
// When routePath is unavailable, caller should fall back to straight
// lines between stops.
// Globally-nearest path index — only used to anchor the FIRST stop in a
// sequence. Subsequent stops are matched forward from there (see below).
function nearestPathIdx(path: [number, number][], t: LatLon): number {
  let bestIdx = 0, best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i][0] - t.lat) ** 2 + (path[i][1] - t.lon) ** 2;
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}
// The first close approach to `t` scanning FORWARD from `startIdx` (wrapping
// once around the loop). Self-overlapping loops (e.g. Green revisits the
// campus on its way back from the southern Buildings detour) pass within
// metres of the same stop twice; the globally-nearest point can land on the
// LATER pass, which is what made slices balloon south and double back. By
// taking the first pass we reach travelling forward, the slice stays on the
// arc the bus actually drives between the two stops.
function forwardNearestIdx(path: [number, number][], t: LatLon, startIdx: number): number {
  const n = path.length;
  let bestIdx = -1, bestM = Infinity;
  let arrived = false;
  for (let step = 1; step <= n; step++) {
    const i = (startIdx + step) % n;
    const m = haversineMeters({ lat: path[i][0], lon: path[i][1] }, t);
    if (m < bestM) { bestM = m; bestIdx = i; }
    if (m <= 60) arrived = true;
    // Once we've made our closest approach on this pass and started pulling
    // away again, stop — don't roll into a later pass through the same area.
    if (arrived && m > bestM + 80 && bestIdx !== -1) break;
  }
  return bestIdx === -1 ? startIdx : bestIdx;
}
function buildStopSequencePolyline(
  path: [number, number][] | undefined, stops: LatLon[] | undefined,
): [number, number][] | undefined {
  if (!path || path.length < 2 || !stops || stops.length < 2) return undefined;
  // Trace the route polyline in travel order: anchor the first stop globally,
  // then walk forward stop-by-stop. Forward matching keeps the indices
  // monotonic, so the "ride" line follows the actual streets between board and
  // alight without grabbing the wrong loop occurrence (which produced straight
  // cross-cuts and ~7 km southern detours on Green).
  let cursor = nearestPathIdx(path, stops[0]);
  const out: [number, number][] = [];
  for (let s = 1; s < stops.length; s++) {
    const nextIdx = forwardNearestIdx(path, stops[s], cursor);
    let slice = nextIdx >= cursor
      ? path.slice(cursor, nextIdx + 1)
      : [...path.slice(cursor), ...path.slice(0, nextIdx + 1)];
    // Degenerate match (same index) — bridge with a straight segment so the
    // line never silently vanishes.
    if (slice.length < 2) slice = [path[cursor], path[nextIdx]];
    if (s === 1) out.push(...slice);
    else out.push(...slice.slice(1)); // dedupe junction point
    cursor = nextIdx;
  }
  return out.length >= 2 ? out : undefined;
}

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
// Foot profile lives on a different public OSRM install — the project-osrm
// demo router only serves the driving profile, which follows one-ways and
// avoids footpaths, i.e. wrong for walking legs.
const OSRM_FOOT_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const LS_KEY = "shuttle-segment-geoms-v1";
type SegGeom = [number, number][]; // [lat, lon][]
function loadSegCache(): Record<string, SegGeom> {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}
function saveSegCache(cache: Record<string, SegGeom>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}
const segCache: Record<string, SegGeom> = loadSegCache();
const segInFlight = new Set<string>();
const segKey = (a: LatLon, b: LatLon, foot = false) =>
  `${foot ? "F|" : ""}${a.lat.toFixed(5)},${a.lon.toFixed(5)}|${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;

async function fetchSegGeom(a: LatLon, b: LatLon, foot = false): Promise<SegGeom | null> {
  const key = segKey(a, b, foot);
  if (segCache[key]) return segCache[key];
  if (segInFlight.has(key)) return null;
  segInFlight.add(key);
  try {
    const url = `${foot ? OSRM_FOOT_BASE : OSRM_BASE}/${a.lon},${a.lat};${b.lon},${b.lat}?geometries=geojson&overview=full`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "Ok" || !d.routes?.[0]?.geometry?.coordinates) return null;
    const pts: SegGeom = d.routes[0].geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number],
    );
    segCache[key] = pts;
    saveSegCache(segCache);
    return pts;
  } catch { return null; }
  finally { segInFlight.delete(key); }
}

// Walk a list of stops, call OSRM for each consecutive pair, and
// concatenate the road-following polyline. Returns straight-line
// [stop0, stop1, ..., stopN] while requests are in flight so the map
// has something to draw immediately; caller is expected to re-render
// when the async pieces land (we notify via a `tick` counter).
function useRoadPolyline(stops: LatLon[] | undefined, tick: () => void): [number, number][] | undefined {
  const ref = useRef<number>(0);
  useEffect(() => {
    if (!stops || stops.length < 2) return;
    let cancelled = false;
    (async () => {
      let changed = false;
      for (let i = 0; i < stops.length - 1; i++) {
        const key = segKey(stops[i], stops[i + 1]);
        if (!segCache[key]) {
          const pts = await fetchSegGeom(stops[i], stops[i + 1]);
          if (cancelled) return;
          if (pts) changed = true;
        }
      }
      if (changed) { ref.current += 1; tick(); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops && stops.map((s) => `${s.lat},${s.lon}`).join(";")]);

  if (!stops || stops.length < 2) return undefined;
  const out: [number, number][] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const geom = segCache[segKey(stops[i], stops[i + 1])];
    if (geom && geom.length > 0) {
      if (i === 0) out.push(geom[0]);
      for (let j = 1; j < geom.length; j++) out.push(geom[j]);
    } else {
      if (i === 0) out.push([stops[i].lat, stops[i].lon]);
      out.push([stops[i + 1].lat, stops[i + 1].lon]);
    }
  }
  return out;
}

// Scalar projection of `p` onto the segment from `a` to `b`, normalized so
// t=0 means "at A", t=1 means "at B", t>1 means "past B", t<0 means
// "before A". Uses an equirectangular approximation (stretches lon by
// cos(lat)) — good enough for sub-mile bus segments and stable vs.
// perpendicular GPS jitter. Straight-line distance comparisons aren't
// robust: a bus at the midpoint flips "closer to A" vs "closer to B" on
// noise, wrecking both anchor-advance and mid-segment proration.
function progressAlongSegment(p: LatLon, a: LatLon, b: LatLon): number {
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const scale = Math.cos(meanLat);
  const ax = a.lon * scale, ay = a.lat;
  const bx = b.lon * scale, by = b.lat;
  const px = p.lon * scale, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-12) return 0;
  return ((px - ax) * dx + (py - ay) * dy) / denom;
}
const MAX_RIDE_SEC = 25 * 60; // don't keep looping past a boarding point

// How long a rider still has to board a bus that's dwelling at a stop RIGHT
// NOW. Floor of 120 s (GPS slack + "the driver waits for someone running"),
// stretched by the calibrated remaining dwell when we have data — layover
// stops where the bus rests for minutes are catchable from much farther
// away. Shared by planTrip (option generation) and the live recompute so the
// two never disagree about whether a parked bus is boardable. The backend
// planner's expectedWait applies the same elapsed-vs-median dwell logic.
function dwellBoardWindowSec(
  bus: BusData,
  routeListId: string,
  stopId: number,
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>,
): number {
  let remaining = 0;
  const d = dwellTimes[routeListId]?.[String(stopId)];
  if (d && d.n >= 2 && bus.at_stop_since) {
    const elapsed = Math.max(0, (Date.now() - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
    remaining = Math.max(0, d.med - elapsed);
  }
  return Math.max(120, remaining + 60);
}

function planTrip(
  from: LatLon, to: LatLon,
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>,
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>,
  dwellsByBus: Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>,
  targetDate?: Date | null,
): TripOption[] {
  // 1500 m ≈ 18 min walk. Earlier 1200 m cut off plausible trips
  // where the one pickup stop on a destination-niche route (e.g.
  // Grocery TJ from 517 Prospect → Peabody Museum, 1257 m) was just
  // out of range. The `walkTo + walkFrom < directWalk` check below
  // prevents the raised ceiling from suggesting dumb detours.
  const MAX_WALK_M = 1500;
  // Future-plan mode: the user picked a date/time >60s away. We can't
  // rely on live buses, so we filter by published operating hours and
  // estimate wait from headway.
  const futureMode = !!targetDate && targetDate.getTime() - Date.now() > 60_000;
  const directWalkM = haversineMeters(from, to);
  const directWalkSec = walkSecFromMeters(directWalkM);

  const fromDist: Record<number, number> = {};
  const toDist: Record<number, number> = {};
  for (const [k, c] of Object.entries(stopCoords)) {
    const sid = Number(k);
    fromDist[sid] = haversineMeters(from, c);
    toDist[sid] = haversineMeters(to, c);
  }
  const options: TripOption[] = [];

  for (const cfg of ROUTE_LISTS) {
    // Skip routes that won't be running at the target time. In live mode
    // we still let computeUpcomingArrivals gate (bus presence filters
    // naturally).
    if (futureMode && !isRouteActiveAt(cfg.label, targetDate!)) continue;
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
      // Compute ride-time cumulatively walking forward along the route,
      // WRAPPING around the loop — these are circular routes, so a board
      // stop late in the stop array still reaches an alight earlier in
      // it. The old forward-only scan couldn't pair those, which made
      // the planner skip the stop nearest the rider whenever it sat
      // "after" the destination in array order and suggest a farther
      // one instead (user report 2026-07-17, Blue). MAX_RIDE_SEC still
      // caps how far around the loop an option can ride.
      let cumRide = 0;
      for (let step = 1; step < stops.length; step++) {
        const prev = stops[(i + step - 1) % stops.length];
        const cur = stops[(i + step) % stops.length];
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
        const walkToSec = walkSecFromMeters(fromDist[b]);
        const walkFromSec = walkSecFromMeters(toDist[cur]);
        // (The "more walking than walking direct" test used to live here,
        // before waitSec/rideSec were known. See the dominance check below.)
        // Wait time: for a live plan we need a real bus on the route; for
        // a future plan we use half the published headway since no bus
        // exists yet to time against.
        let waitSec: number; let busName: string;
        if (futureMode) {
          waitSec = (HEADWAY_MIN[cfg.label] ?? 15) * 30;
          busName = "";
        } else {
          // A bus physically dwelling AT this board stop is boardable NOW if
          // the rider can reach it before it pulls away — generate the option
          // with wait 0 instead of relying on ETA math. Without this the
          // stop was silently DROPPED here (a dwelling bus used to emit no
          // ETA for its own stop), which is how the planner missed a 10-min
          // fastest route entirely (report #28: bus parked 13 m from the
          // board stop, every pair boarding there discarded).
          const hereBus = buses.find(
            (bb) => cfg.busRouteIds.includes(bb.route_id) && bb.at_stop_id === b,
          );
          const arrivals = computeUpcomingArrivals([b], buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus)
            .filter((a) => a.routeLabel === cfg.label);
          if (hereBus && walkToSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], b, dwellTimes)) {
            waitSec = 0;
            busName = hereBus.bus_name.replace(/^#/, "");
          } else if (arrivals.length === 0) {
            continue;
          } else {
            // Pin the soonest *catchable* bus (one the rider can reach before it
            // finishes dwelling), not merely the soonest — with second-lap
            // arrivals that's usually the same vehicle a loop later rather
            // than nothing. Pinning an uncatchable bus made the live recompute
            // flag it "🚌 #X just passed your stop" the instant a fresh plan
            // rendered. Falls back to the soonest when none is catchable —
            // the option then correctly shows "departed".
            // STOP_DWELL_SEC mirrors the live options memo's canCatch().
            const STOP_DWELL_SEC = 60;
            const next = arrivals.find((a) => walkToSec <= a.eta + STOP_DWELL_SEC) ?? arrivals[0];
            waitSec = Math.max(0, next.eta - walkToSec);
            busName = next.busName;
          }
        }
        const totalSec = walkToSec + waitSec + cumRide + walkFromSec;
        // Drop only options STRICTLY dominated by walking: more walking AND
        // no faster overall. The old test compared the walking legs alone,
        // before the ride was known, so it threw away trips that were plainly
        // better — for report #40 the server's recommended 15.9-min ride was
        // discarded because its two walk legs summed to ~7 s more than the
        // 18.5-min direct walk, and the rider was shown walk-only instead.
        // Options that are merely slower are kept on purpose and labelled
        // "slower than walking" by the picker (see the note below the loop).
        if (walkToSec + walkFromSec >= directWalkSec && totalSec >= directWalkSec) continue;
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
  // Options slower than just walking are KEPT (the user wants to see every
  // route), but the picker demotes and labels them "slower than walking" at
  // render time so one can't masquerade as the recommendation — that was
  // report #15: a 2-min ride wrapped in 29 min of walking totalled MORE
  // than the direct walk yet read like the top pick.
  const viable = options;
  // Per-route pick: lowest total time, with one carve-out — among options
  // whose totals are within ~3 min of the route's best, prefer the
  // shortest walk to the boarding stop ("catch the bus right outside").
  // The old pick minimized walk-to unconditionally, which ignored wait:
  // report #3 saw a 43-min wait at the nearest stop chosen over boarding
  // the same (resting) bus a 4-min walk away.
  const TOTAL_TIE_SEC = 180;
  const byRoute = new Map<string, TripOption[]>();
  for (const o of viable) {
    const bucket = byRoute.get(o.routeLabel);
    if (bucket) bucket.push(o);
    else byRoute.set(o.routeLabel, [o]);
  }
  const bestPerRoute = new Map<string, TripOption>();
  for (const [label, group] of byRoute) {
    const minTotal = Math.min(...group.map((o) => o.totalSec));
    const nearBest = group.filter((o) => o.totalSec <= minTotal + TOTAL_TIE_SEC);
    nearBest.sort((a, b) => a.walkToSec - b.walkToSec || a.totalSec - b.totalSec);
    bestPerRoute.set(label, nearBest[0]);
  }
  // Sort the chosen options by total time for display.
  const dedup = [...bestPerRoute.values()]
    .sort((a, b) => a.totalSec - b.totalSec)
    .slice(0, 6);
  // Include the direct-walk option and sort the whole list by totalSec
  // so the FASTEST badge actually lands on the fastest one — previously
  // walk was hard-prepended and always got the badge. Skip the walk
  // suggestion entirely when the direct walk exceeds an hour: nobody
  // plans a 60+ min walk across New Haven, and offering it as a trip
  // option clutters the picker when the only viable choice is a bus.
  // ...unless it's the only thing we have. Report #35: a 4.3 km trip where
  // the server planner returned a perfectly good 53-min walk, but the client
  // walk model (crow-flies x 1.2 detour / 1.3 m/s) put it at 66 min — over
  // this cutoff — so the walk was suppressed, no shuttle matched, and the
  // rider got a bare "No trip options found between these locations."
  // Suppressing the clutter is fine; suppressing the last option is not.
  const walkList: TripOption[] = directWalkSec <= 3600 || dedup.length === 0
    ? [{
        mode: "walk",
        routeLabel: "Walk",
        color: "#546e7a",
        boardStopId: 0, alightStopId: 0,
        walkToSec: 0, waitSec: 0, rideSec: 0, walkFromSec: 0,
        totalSec: directWalkSec, busName: "",
        directWalkSec,
      }]
    : [];
  return [...walkList, ...dedup].sort((a, b) => a.totalSec - b.totalSec);
}

// Routes that geographically connect from→to (a stop within walking
// distance of each) regardless of whether they're running right now.
// Used as a fallback when planTrip returns only Walk: lets the picker
// explain "the Grocery TJ route goes there, but it's Sa/Su 10a–6p,
// next active Sat 10:00 AM" rather than leaving the rider staring at
// just "walk 45 min".
interface PotentialRoute {
  label: string;
  color: string;
  boardStopId: number;
  alightStopId: number;
  schedule: string;
  nextActive: Date | null;
}

function findPotentialRoutes(
  from: LatLon, to: LatLon,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  after: Date,
): PotentialRoute[] {
  const MAX_WALK_M = 1500;
  const out: PotentialRoute[] = [];
  for (const cfg of ROUTE_LISTS) {
    const stops: number[] = [];
    const seen = new Set<number>();
    for (const rid of cfg.routeIds) {
      for (const sid of (routeStops[rid] ?? [])) {
        if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
      }
    }
    if (stops.length < 2) continue;
    // Any board stop near "from" and any alight stop near "to",
    // with alight further along the route than board (so we're not
    // suggesting a ride that goes the wrong way).
    let bestBoard = -1;
    let bestAlight = -1;
    let bestTotal = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const b = stops[i];
      const bc = stopCoords[b];
      if (!bc) continue;
      const dFrom = haversineMeters(from, bc);
      if (dFrom > MAX_WALK_M) continue;
      // Wrap around the loop — same circular-route fix as planTrip.
      for (let j = 1; j < stops.length; j++) {
        const a = stops[(i + j) % stops.length];
        const ac = stopCoords[a];
        if (!ac) continue;
        const dTo = haversineMeters(to, ac);
        if (dTo > MAX_WALK_M) continue;
        const total = dFrom + dTo;
        if (total < bestTotal) {
          bestTotal = total; bestBoard = b; bestAlight = a;
        }
      }
    }
    if (bestBoard === -1) continue;
    out.push({
      label: cfg.label,
      color: cfg.color,
      boardStopId: bestBoard,
      alightStopId: bestAlight,
      schedule: fmtSchedule(cfg.label),
      nextActive: nextActiveWindow(cfg.label, after),
    });
  }
  // Sort by next-active — soonest first, routes with no schedule last.
  out.sort((a, b) => {
    const ta = a.nextActive ? a.nextActive.getTime() : Infinity;
    const tb = b.nextActive ? b.nextActive.getTime() : Infinity;
    return ta - tb;
  });
  return out;
}


// Leaflet + OSM tile map for a single trip option. Shows start (green),
// end (red), the shuttle boarding/alighting stops and route polyline,
// and dashed lines for the walking segments. Mounts/unmounts with the
// expanded card, so we only hold one map instance at a time.
// Go screen's picture-in-picture locator: a small round map bubble with the
// rider's live dot, the pickup stop, and the street-routed path between
// them; tapping swaps between bubble and full-width. Location CONTEXT, not
// turn-by-turn — directions stay in the external maps app.
const GoMiniMap: FC<{ from: LatLon; to: LatLon; color: string; stopName: string; big: boolean; onToggle: () => void; bus?: { lat: number; lon: number; name?: string } | null }> =
  ({ from, to, color, stopName, big, onToggle, bus }) => {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const youRef = useRef<L.Marker | null>(null);
  const busRef = useRef<L.Marker | null>(null);
  const routedFromRef = useRef<LatLon | null>(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, {
      zoomControl: false, scrollWheelZoom: false, dragging: false,
      touchZoom: false, doubleClickZoom: false, keyboard: false,
      attributionControl: false, zoomAnimation: false,
    });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    L.circleMarker([to.lat, to.lon], { radius: 7, color, weight: 2.5, fillColor: "#fff", fillOpacity: 1 })
      .addTo(map).bindTooltip(`🚏 ${stopName}`, { direction: "top", offset: [0, -6] });
    youRef.current = L.marker([from.lat, from.lon], {
      icon: makeYouIcon(), interactive: false, keyboard: false, zIndexOffset: 900,
    }).addTo(map);
    lineRef.current = L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
      color, weight: 3.5, opacity: 0.85, dashArray: "5 7",
    }).addTo(map);
    map.fitBounds(L.latLngBounds([[from.lat, from.lon], [to.lat, to.lon]]), { padding: [22, 22], maxZoom: 17 });
    const sizeTimer = setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 60);
    return () => {
      clearTimeout(sizeTimer);
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      mapRef.current = null; lineRef.current = null; youRef.current = null; busRef.current = null; routedFromRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live bus marker (report #17: "mini map doesn't show bus") — moved in
  // place per poll. The bubble keeps its you↔stop framing; only the
  // full-width map widens its bounds to keep the bus in view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!bus) {
      busRef.current?.remove();
      busRef.current = null;
      return;
    }
    const ll: [number, number] = [bus.lat, bus.lon];
    if (busRef.current) {
      busRef.current.setLatLng(ll);
    } else {
      const icon = L.divIcon({
        className: "bus-pin-sm",
        html: `
          <div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
            <div style="position:absolute;inset:2px;border-radius:50%;background:#fff;border:2.5px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>
            <span style="position:relative;font-size:13px;line-height:1;">🚌</span>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      busRef.current = L.marker(ll, { icon, interactive: false, keyboard: false, zIndexOffset: 950 }).addTo(map);
    }
    if (big && !map.getBounds().pad(-0.05).contains(ll)) {
      map.fitBounds(map.getBounds().extend(ll), { padding: [30, 30], maxZoom: 17, animate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus?.lat, bus?.lon, big]);

  // Bubble ↔ full-width: the container resizes, tell Leaflet and refit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = setTimeout(() => {
      if (mapRef.current !== map) return;
      map.invalidateSize();
      map.fitBounds(L.latLngBounds([[from.lat, from.lon], [to.lat, to.lon]]), { padding: big ? [34, 34] : [22, 22], maxZoom: 17 });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [big]);

  // Live you-dot; re-route the foot path when the rider drifts >60 m from
  // the origin it was computed for. fetchSegGeom returns null while a
  // request is in flight — retry once so the first paint still upgrades.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    youRef.current?.setLatLng([from.lat, from.lon]);
    const last = routedFromRef.current;
    if (last && haversineMeters(last, from) < 60) return;
    routedFromRef.current = from;
    let cancelled = false;
    const apply = (g: SegGeom | null) => {
      if (!g || cancelled || mapRef.current !== map || !lineRef.current) return;
      lineRef.current.setLatLngs(g);
    };
    fetchSegGeom(from, to, true).then((g) => {
      if (g) { apply(g); return; }
      setTimeout(() => { if (!cancelled) fetchSegGeom(from, to, true).then(apply); }, 3000);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.lat, from.lon]);

  return (
    <div
      onClick={onToggle}
      title={big ? "Shrink map" : "Expand map"}
      style={big ? {
        width: "100%", height: 220, borderRadius: 10, overflow: "hidden",
        border: "1px solid #e0ddd8", cursor: "pointer", position: "relative",
      } : {
        width: 84, height: 84, alignSelf: "center", flexShrink: 0,
        borderRadius: "50%", overflow: "hidden", cursor: "pointer", position: "relative",
        border: "2.5px solid #fff", boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
      }}
    >
      <div ref={divRef} style={{ position: "absolute", inset: 0 }} />
      <span style={{
        position: "absolute", bottom: 4, right: 6, zIndex: 500,
        fontSize: 9, color: "#546e7a", background: "rgba(255,255,255,0.85)",
        borderRadius: 4, padding: "1px 5px", pointerEvents: "none",
      }}>{big ? "shrink" : "tap"}</span>
    </div>
  );
};

const TripMap: FC<{
  from: LatLon;
  to: LatLon;
  shuttleStops?: LatLon[];
  // Stops the bus will pass *before* it reaches the boarding stop (from
  // the bus's current anchor → board). Rendered as small faded dots +
  // a dashed muted polyline so the rider can see what's still ahead of
  // them before pickup.
  upcomingStops?: LatLon[];
  // Pre-sliced road-following polylines for each leg — built by the
  // caller from the downtownerapp `path` field. When undefined, we
  // fall back to straight lines between stops.
  shuttleRoad?: [number, number][];
  upcomingRoad?: [number, number][];
  bus?: { lat: number; lon: number; name?: string } | null;
  // A bus that just passed the board stop (the rider missed it and we
  // advanced to the next one). Drawn dimmed/grey so it reads as "that's
  // the one you missed" next to the live catchable bus.
  passedBus?: { lat: number; lon: number; name?: string } | null;
  color: string;
}> = ({ from, to, shuttleStops, upcomingStops, shuttleRoad, upcomingRoad, bus, passedBus, color }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const busMarkerRef = useRef<L.Marker | null>(null);
  // Start marker is kept in a ref so we can move it in place when the
  // user's GPS updates while walking toward the board stop, without
  // tearing down the whole map.
  const startMarkerRef = useRef<L.Marker | null>(null);

  // Mount-once: build map, tiles, endpoints, stops, polylines. Re-runs only
  // when the planned trip itself changes (endpoints, route, shuttle shape),
  // not when the bus moves.
  useEffect(() => {
    if (!ref.current) return;
    // zoomAnimation off: these embedded maps unmount freely (card
    // collapse/reorder), and an interrupted CSS zoom transition fires
    // _onZoomTransitionEnd on the dead map (_leaflet_pos crash).
    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: false, zoomAnimation: false });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const points: [number, number][] = [[from.lat, from.lon], [to.lat, to.lon]];

    // Walking leg: dashed straight line immediately, upgraded IN PLACE to
    // the street-following foot route once OSRM answers (cached per device,
    // so after the first view it's routed from the start). setLatLngs keeps
    // the fitted bounds — no refit jump when the geometry lands.
    const walkLeg = (a: LatLon, b: LatLon) => {
      const cached = segCache[segKey(a, b, true)];
      const line = L.polyline(cached ?? [[a.lat, a.lon], [b.lat, b.lon]], {
        color: "#546e7a", weight: 2, dashArray: "4 6", opacity: 0.85,
      }).addTo(map);
      if (!cached) {
        const apply = (g: SegGeom | null | undefined) => {
          if (g && mapRef.current === map) line.setLatLngs(g);
        };
        fetchSegGeom(a, b, true).then((pts) => {
          if (pts) apply(pts);
          // null can mean "another mount is already fetching this key" —
          // check the cache again once that request has had time to land.
          else setTimeout(() => apply(segCache[segKey(a, b, true)]), 3000);
        });
      }
    };

    startMarkerRef.current = L.marker([from.lat, from.lon], { icon: makeYouIcon(), zIndexOffset: 500 })
      .addTo(map).bindTooltip("You", { direction: "top" });
    L.marker([to.lat, to.lon], { icon: makeDestPin(), zIndexOffset: 500 })
      .addTo(map).bindTooltip("End", { direction: "top" });

    if (shuttleStops && shuttleStops.length >= 2) {
      const board = shuttleStops[0];
      const alight = shuttleStops[shuttleStops.length - 1];

      // Upstream (pre-pickup) stops get their own in-place effect below
      // so the list can shrink as the bus passes stops without tearing
      // down and rebuilding the whole map each poll.

      // Only the board/alight markers are rendered on the ride segment —
      // intermediate stop dots were noise. The colored polyline still
      // shows the ride's shape.
      for (const s of shuttleStops.slice(1, -1)) {
        points.push([s.lat, s.lon]);
      }
      L.polyline(shuttleRoad ?? shuttleStops.map((s) => [s.lat, s.lon] as [number, number]), {
        color, weight: 5, opacity: 0.75,
      }).addTo(map);
      L.circleMarker([board.lat, board.lon], {
        radius: 7, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2.5,
      }).addTo(map).bindTooltip("Board", { direction: "top" });
      L.circleMarker([alight.lat, alight.lon], {
        radius: 7, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2.5,
      }).addTo(map).bindTooltip("Get off", { direction: "top" });
      walkLeg(from, board);
      walkLeg(alight, to);
      points.push([board.lat, board.lon], [alight.lat, alight.lon]);
    } else {
      walkLeg(from, to);
    }

    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
    const sizeTimer = setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 60);

    return () => {
      clearTimeout(sizeTimer);
      // Cancel any in-flight pan/zoom animation before teardown —
      // Leaflet's queued animation frame otherwise fires on the removed
      // map and throws "_leaflet_pos of undefined".
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      mapRef.current = null;
      busMarkerRef.current = null;
      passedBusMarkerRef.current = null;
      startMarkerRef.current = null;
    };
    // `from` is intentionally NOT in deps — the start marker is moved in
    // place by the separate effect below so GPS updates don't tear down
    // the whole map and refit bounds every 5 seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    to.lat, to.lon, color,
    JSON.stringify(shuttleStops?.map((s) => [s.lat, s.lon])),
    // upcomingStops intentionally NOT in deps — it shrinks as the bus
    // passes stops, and re-including it would rebuild the whole map
    // (tiles, bus marker, everything) every 5 s. The upstream layer is
    // managed in its own effect below.
    JSON.stringify(shuttleRoad),
  ]);

  // Upstream polyline + translucent dots. Maintained in place across
  // bus-anchor advances so the main map doesn't flash.
  const upstreamLayersRef = useRef<L.Layer[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of upstreamLayersRef.current) map.removeLayer(layer);
    upstreamLayersRef.current = [];
    if (!upcomingStops || upcomingStops.length < 2) return;
    const line = L.polyline(
      upcomingRoad ?? upcomingStops.map((s) => [s.lat, s.lon] as [number, number]),
      { color, weight: 3, opacity: 0.35, dashArray: "6 4" },
    ).addTo(map);
    upstreamLayersRef.current.push(line);
    for (const s of upcomingStops.slice(0, -1)) {
      const dot = L.circleMarker([s.lat, s.lon], {
        radius: 2.5, color, fillColor: color, fillOpacity: 0.5, weight: 0,
      }).addTo(map);
      upstreamLayersRef.current.push(dot);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(upcomingStops?.map((s) => [s.lat, s.lon])),
    JSON.stringify(upcomingRoad),
    color,
  ]);

  // Live "you" marker — moves as the rider walks. Same pattern as the
  // bus marker: setLatLng on the existing CircleMarker instead of
  // rebuilding the layer.
  useEffect(() => {
    if (startMarkerRef.current) {
      startMarkerRef.current.setLatLng([from.lat, from.lon]);
    }
  }, [from.lat, from.lon]);

  // Live bus marker — updates in place on every bus prop change (~5s via
  // /api/buses polling). Animates smoothly to the new GPS point instead of
  // tearing down/rebuilding the map.
  //
  // Flex routes (Blue West etc.) occasionally drop off the TransLoc feed
  // for a poll cycle or two and the pinned-bus lookup returns null. Don't
  // tear the marker down immediately in that case — keep it at its last
  // known position, dimmed, for a ~30 s grace period so it reappears at
  // full opacity when the feed catches up. Only after the grace period
  // elapses do we actually remove the layer.
  const BUS_STALE_MS = 30_000;
  const lastBusSeenRef = useRef<number>(0);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const makeIcon = (dim: boolean) => L.divIcon({
      className: "bus-pin",
      html: `
        <div style="position:relative;width:40px;height:40px;display:flex;align-items:center;justify-content:center;opacity:${dim ? 0.5 : 1};">
          <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.25;${dim ? "" : "animation:busPulse 2s ease-out infinite;"}"></div>
          <div style="position:absolute;inset:4px;border-radius:50%;background:#fff;border:3px solid ${color};box-shadow:0 2px 6px rgba(0,0,0,0.35);"></div>
          <span style="position:relative;font-size:18px;line-height:1;">🚌</span>
        </div>
        <style>
          @keyframes busPulse {
            0%   { transform: scale(0.9); opacity: 0.45; }
            70%  { transform: scale(1.25); opacity: 0; }
            100% { transform: scale(1.25); opacity: 0; }
          }
        </style>
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });

    if (!bus) {
      // Lost the live fix — keep the marker around briefly, then remove.
      if (busMarkerRef.current) {
        busMarkerRef.current.setIcon(makeIcon(true));
        if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
        const elapsed = Date.now() - lastBusSeenRef.current;
        const remaining = Math.max(0, BUS_STALE_MS - elapsed);
        staleTimerRef.current = setTimeout(() => {
          if (busMarkerRef.current && mapRef.current) {
            mapRef.current.removeLayer(busMarkerRef.current);
            busMarkerRef.current = null;
          }
        }, remaining);
      }
      return;
    }

    lastBusSeenRef.current = Date.now();
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }

    const latlng: [number, number] = [bus.lat, bus.lon];
    if (busMarkerRef.current) {
      busMarkerRef.current.setLatLng(latlng);
      busMarkerRef.current.setIcon(makeIcon(false)); // restore full opacity if it was dimmed
      if (bus.name) {
        busMarkerRef.current.setTooltipContent(`Bus #${bus.name}`);
      }
    } else {
      busMarkerRef.current = L.marker(latlng, { icon: makeIcon(false), zIndexOffset: 1000 })
        .addTo(map)
        .bindTooltip(bus.name ? `Bus #${bus.name}` : "Bus", { direction: "top" });
    }
    // If the bus has drifted outside the current viewport, re-fit the
    // bounds so it's always visible. Skip when already inside so we
    // don't jitter the zoom level on small movements.
    if (!map.getBounds().pad(-0.05).contains(latlng)) {
      const current = map.getBounds();
      map.fitBounds(current.extend(latlng), { padding: [24, 24], maxZoom: 17, animate: true });
    }
  }, [bus?.lat, bus?.lon, bus?.name, color]);

  // "Just passed" bus marker — the one the rider missed. Rendered grey and
  // dimmed (no pulse) so it's clearly distinct from the live bus being
  // caught. Updated in place like the live marker; removed when the missed
  // bus drops out of the feed (passedBus becomes null).
  const passedBusMarkerRef = useRef<L.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const passedIcon = L.divIcon({
      className: "bus-pin",
      html: `
        <div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center;opacity:0.6;">
          <div style="position:absolute;inset:3px;border-radius:50%;background:#fff;border:3px solid #9e9e9e;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>
          <span style="position:relative;font-size:15px;line-height:1;filter:grayscale(1);">🚌</span>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    if (!passedBus) {
      if (passedBusMarkerRef.current) {
        map.removeLayer(passedBusMarkerRef.current);
        passedBusMarkerRef.current = null;
      }
      return;
    }
    const latlng: [number, number] = [passedBus.lat, passedBus.lon];
    const label = passedBus.name ? `Bus #${passedBus.name} — just passed` : "Just passed";
    if (passedBusMarkerRef.current) {
      passedBusMarkerRef.current.setLatLng(latlng).setTooltipContent(label);
    } else {
      passedBusMarkerRef.current = L.marker(latlng, { icon: passedIcon, zIndexOffset: 800 })
        .addTo(map)
        .bindTooltip(label, { direction: "top" });
    }
    if (!map.getBounds().pad(-0.05).contains(latlng)) {
      map.fitBounds(map.getBounds().extend(latlng), { padding: [24, 24], maxZoom: 17, animate: true });
    }
  }, [passedBus?.lat, passedBus?.lon, passedBus?.name]);

  // Fullscreen toggle: an inset button the user can tap to expand the
  // map to the viewport. Leaflet's invalidateSize is called after the
  // DOM layout changes so tiles re-fit to the new container size.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    // Give the browser one frame to apply the new style, then redraw.
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 80);
    return () => clearTimeout(t);
  }, [fullscreen]);
  const wrapperStyle: React.CSSProperties = fullscreen
    ? {
        position: "fixed", inset: 0, zIndex: 9999,
        borderRadius: 0, border: "none", overflow: "hidden", marginBottom: 0,
      }
    : {
        position: "relative",
        height: 240, borderRadius: 8,
        border: "1px solid #e0ddd8", overflow: "hidden", marginBottom: 10,
      };
  return (
    <div className="trip-map-wrap" style={wrapperStyle}>
      {/* Desaturate the OSM tile layer so the route color, bus pin,
          and user/endpoint markers pop against a quieter background.
          Only the tile pane is filtered; SVG overlays (polylines,
          circle markers) and DOM markers (bus emoji) stay full color. */}
      <style>{`
        .trip-map-wrap .leaflet-tile-pane {
          filter: grayscale(0.9) contrast(0.95) brightness(1.05);
        }
      `}</style>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      <button
        onClick={(e) => { e.stopPropagation(); setFullscreen((v) => !v); }}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        style={{
          position: "absolute", top: 8, right: 8, zIndex: 1000,
          width: 44, height: 44, border: "none", borderRadius: 8,
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          cursor: "pointer", fontSize: 18, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {fullscreen ? "✕" : "⛶"}
      </button>
    </div>
  );
};


// Combined overview map: draws ALL shuttle options at once below the
// route list so the rider can compare them geographically. Not using
// TripMap because the shapes differ — one polyline per option, one bus
// pin per matched bus, and no per-option upstream/walk ornamentation.
type OverviewOption = {
  label: string;
  color: string;
  segCoords: LatLon[];
  // Pre-sliced road polyline from the route's full path (when available).
  // Straight-line fallback happens per-caller if this is missing.
  road?: [number, number][];
  bus: { lat: number; lon: number; name?: string } | null;
  // The bus the rider just missed (option rebooked to the next one) —
  // drawn dimmed grey so "where did my bus go" has a visible answer
  // next to the live catchable bus (user request 2026-07-17).
  passedBus?: { lat: number; lon: number; name?: string } | null;
  // Detail view only: the bus's remaining path from where it is now to
  // the rider's pickup stop, drawn dashed (user request 2026-07-17).
  approach?: [number, number][];
  // Time labels pinned to the stops (user request 2026-07-17): when the
  // bus reaches the board stop ("🚌 4 min") and when the rider steps off
  // at the alight stop ("10:26 AM"). Null when unknown (departed/future).
  boardEta?: string | null;
  arriveAt?: string | null;
};
const CombinedTripMap: FC<{
  from: LatLon;
  to: LatLon;
  options: OverviewOption[];
}> = ({ from, to, options }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const busMarkersRef = useRef<Record<string, L.Marker>>({});
  const startMarkerRef = useRef<L.Marker | null>(null);
  // Time chips (board 🚌 countdowns / alight 🏁 clocks) live on their own
  // layer and are re-CLUSTERED on every zoom change: chips whose
  // would-be INDIVIDUAL labels overlap at the current zoom merge into
  // one chip (each time colored by its route), and split back apart once
  // zooming in gives them room (user feedback 2026-07-17). Markers are
  // keyed by cluster membership so a stable cluster updates in place
  // per poll instead of flickering.
  const chipLayerRef = useRef<L.LayerGroup | null>(null);
  const chipMarkersRef = useRef<Record<string, L.Marker>>({});
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const rebuildChips = () => {
    const map = mapRef.current;
    const grp = chipLayerRef.current;
    if (!map || !grp) return;
    type Chip = {
      lat: number; lon: number; kind: "board" | "alight"; label: string;
      part: string; w: number; x: number; y: number;
    };
    const chips: Chip[] = [];
    for (const o of optionsRef.current) {
      if (o.segCoords.length < 2) continue;
      const ends = [
        { c: o.segCoords[0], kind: "board" as const, text: o.boardEta },
        { c: o.segCoords[o.segCoords.length - 1], kind: "alight" as const, text: o.arriveAt },
      ];
      for (const e of ends) {
        if (!e.text) continue;
        const p = map.latLngToContainerPoint([e.c.lat, e.c.lon]);
        // "(B) 4 min" — route-initial tag so a time is attributable to
        // its route even without judging the text color (user request
        // 2026-07-17; also helps color-blind riders).
        const tagged = `(${o.label.charAt(0).toUpperCase()}) ${e.text}`;
        chips.push({
          lat: e.c.lat, lon: e.c.lon, kind: e.kind, label: o.label,
          part: `<span style="color:${o.color}">${tagged}</span>`,
          // Estimated label footprint: emoji + padding + ~6 px/char at
          // the chip's 10 px bold face. Merge decisions use these
          // per-chip estimates, per the spec: "overlap of would-be
          // individual labels".
          w: 26 + tagged.length * 6,
          x: p.x,
          // Board chips render above their stop, alight chips below —
          // baked into y so labels merge when the LABELS would collide,
          // not merely when the dots are near.
          y: p.y + (e.kind === "board" ? -14 : 14),
        });
      }
    }
    // Union-find over overlapping label rectangles.
    const parent = chips.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < chips.length; i++) {
      for (let j = i + 1; j < chips.length; j++) {
        if (
          Math.abs(chips[i].x - chips[j].x) < (chips[i].w + chips[j].w) / 2 + 4 &&
          Math.abs(chips[i].y - chips[j].y) < 18
        ) {
          parent[find(i)] = find(j);
        }
      }
    }
    const clusters: Record<number, Chip[]> = {};
    chips.forEach((c, i) => { (clusters[find(i)] ??= []).push(c); });
    const seen = new Set<string>();
    for (const members of Object.values(clusters)) {
      const boards = members.filter((m) => m.kind === "board");
      const alights = members.filter((m) => m.kind === "alight");
      // Merged times stack VERTICALLY (user request 2026-07-17), emoji on
      // the first line only — an invisible copy indents the rest so the
      // times line up in a column.
      const stack = (emoji: string, parts: string[]) =>
        parts
          .map((p, k) => (k === 0 ? `${emoji} ${p}` : `<span style="visibility:hidden">${emoji}</span> ${p}`))
          .join("<br/>");
      const lines: string[] = [];
      if (boards.length) lines.push(stack("🚌", boards.map((m) => m.part)));
      if (alights.length) lines.push(stack("🏁", alights.map((m) => m.part)));
      const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
      const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
      const dir: "top" | "bottom" = boards.length ? "top" : "bottom";
      const sig = members.map((m) => `${m.kind[0]}:${m.label}`).sort().join("|");
      seen.add(sig);
      const html = lines.join("<br/>");
      const existing = chipMarkersRef.current[sig];
      if (existing) {
        existing.setLatLng([lat, lon]);
        existing.setTooltipContent(html);
      } else {
        chipMarkersRef.current[sig] = L.marker([lat, lon], {
          icon: L.divIcon({ className: "", html: "", iconSize: [0, 0] }),
          keyboard: false, interactive: false,
        }).bindTooltip(html, {
          permanent: true, direction: dir,
          offset: [0, dir === "top" ? -10 : 10],
          className: "eta-tip", opacity: 0.95,
        }).addTo(grp);
      }
    }
    for (const [sig, m] of Object.entries(chipMarkersRef.current)) {
      if (!seen.has(sig)) { grp.removeLayer(m); delete chipMarkersRef.current[sig]; }
    }
  };
  // Build/teardown when the set of endpoints or options changes.
  useEffect(() => {
    if (!ref.current) return;
    // zoomAnimation off: these embedded maps unmount freely (card
    // collapse/reorder), and an interrupted CSS zoom transition fires
    // _onZoomTransitionEnd on the dead map (_leaflet_pos crash).
    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: false, zoomAnimation: false });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const points: [number, number][] = [[from.lat, from.lon], [to.lat, to.lon]];

    startMarkerRef.current = L.marker([from.lat, from.lon], { icon: makeYouIcon(), zIndexOffset: 500 })
      .addTo(map).bindTooltip("You", { direction: "top" });
    L.marker([to.lat, to.lon], { icon: makeDestPin(), zIndexOffset: 500 })
      .addTo(map).bindTooltip("End", { direction: "top" });

    // Each option: colored polyline, board/alight rings. Use the
    // pre-sliced route path when available, straight line otherwise.
    for (const o of options) {
      if (o.segCoords.length < 2) continue;
      const road: [number, number][] = o.road && o.road.length >= 2
        ? o.road
        : o.segCoords.map((s) => [s.lat, s.lon] as [number, number]);
      L.polyline(road, { color: o.color, weight: 5, opacity: 0.9 }).addTo(map);
      const board = o.segCoords[0];
      const alight = o.segCoords[o.segCoords.length - 1];
      // Plain rings with hover labels — the permanent time chips are a
      // separate zoom-clustered layer (see rebuildChips above).
      L.circleMarker([board.lat, board.lon], {
        radius: 5, color: "#fff", fillColor: o.color, fillOpacity: 1, weight: 2,
      }).addTo(map).bindTooltip(`Board ${o.label}`, { direction: "top" });
      L.circleMarker([alight.lat, alight.lon], {
        radius: 5, color: "#fff", fillColor: o.color, fillOpacity: 1, weight: 2,
      }).addTo(map).bindTooltip(`Get off ${o.label}`, { direction: "top" });
      for (const s of o.segCoords) points.push([s.lat, s.lon]);
    }

    // Single-route (details) view: overlay the walking legs too, dashed
    // Google-style, so the whole journey — walk, ride, walk — reads on
    // one map. Skipped on the multi-route overview to avoid a web of
    // connectors.
    if (options.length === 1 && options[0].segCoords.length >= 2) {
      const o = options[0];
      const board = o.segCoords[0];
      const alight = o.segCoords[o.segCoords.length - 1];
      const walkStyle = { color: "#5f6368", weight: 3, opacity: 0.85, dashArray: "2 7" };
      L.polyline([[from.lat, from.lon], [board.lat, board.lon]], walkStyle).addTo(map);
      L.polyline([[alight.lat, alight.lon], [to.lat, to.lon]], walkStyle).addTo(map);
    }

    // Time-chip layer + zoom-driven re-clustering. rebuildChips reads
    // everything through refs, so this mount-time closure stays valid
    // across renders. First build happens AFTER fitBounds — projecting
    // before the map has a view throws.
    chipLayerRef.current = L.layerGroup().addTo(map);
    map.on("zoomend", rebuildChips);

    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 15 });
    rebuildChips();
    const sizeTimer = setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 60);

    return () => {
      clearTimeout(sizeTimer);
      // Cancel any in-flight pan/zoom animation before teardown —
      // Leaflet's queued animation frame otherwise fires on the removed
      // map and throws "_leaflet_pos of undefined".
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      mapRef.current = null;
      busMarkersRef.current = {};
      chipLayerRef.current = null;
      chipMarkersRef.current = {};
      approachLayersRef.current = {};
      startMarkerRef.current = null;
    };
    // NOTE: boardEta/arriveAt are deliberately NOT in this key — they tick
    // every poll and re-cluster in place via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    to.lat, to.lon,
    JSON.stringify(options.map((o) => ({
      label: o.label,
      color: o.color,
      segCoords: o.segCoords.map((c) => [c.lat, c.lon]),
      road: o.road,
    }))),
  ]);

  // Re-cluster the time-chips as ETAs tick (stable clusters update their
  // tooltip content in place — no map rebuild, no flicker).
  useEffect(() => {
    rebuildChips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  // Dashed approach polylines (bus → pickup, details view) — updated in
  // place as the bus advances so the map never rebuilds for them.
  const approachLayersRef = useRef<Record<string, L.Polyline>>({});
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const o of options) {
      if (!o.approach || o.approach.length < 2) continue;
      seen.add(o.label);
      const existing = approachLayersRef.current[o.label];
      if (existing) existing.setLatLngs(o.approach);
      else {
        approachLayersRef.current[o.label] = L.polyline(o.approach, {
          color: o.color, weight: 3, opacity: 0.35, dashArray: "6 4",
        }).addTo(map);
      }
    }
    for (const [label, layer] of Object.entries(approachLayersRef.current)) {
      if (!seen.has(label)) {
        map.removeLayer(layer);
        delete approachLayersRef.current[label];
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(options.map((o) => [o.label, o.approach?.length ?? 0, o.approach?.[0]]))]);

  // Live you-marker follows GPS.
  useEffect(() => {
    startMarkerRef.current?.setLatLng([from.lat, from.lon]);
  }, [from.lat, from.lon]);

  // Live bus markers — one per option.busName that exists, plus a dimmed
  // grey pin for a just-missed bus (o.passedBus) so the rider can see
  // both the bus they lost and the one they're catching. Updated in
  // place so the 5s /api/buses tick doesn't rebuild the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seenKeys = new Set<string>();
    const upsert = (
      key: string,
      pos: { lat: number; lon: number; name?: string },
      color: string,
      label: string,
      dim: boolean,
    ) => {
      seenKeys.add(key);
      const latlng: [number, number] = [pos.lat, pos.lon];
      const existing = busMarkersRef.current[key];
      if (existing) {
        existing.setLatLng(latlng);
        return;
      }
      const icon = L.divIcon({
        className: "bus-pin-sm",
        html: `
          <div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;${dim ? "opacity:0.55;" : ""}">
            <div style="position:absolute;inset:2px;border-radius:50%;background:#fff;border:2.5px solid ${dim ? "#9e9e9e" : color};box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>
            <span style="position:relative;font-size:13px;line-height:1;${dim ? "filter:grayscale(1);" : ""}">🚌</span>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      busMarkersRef.current[key] = L.marker(latlng, { icon, zIndexOffset: dim ? 900 : 1000 })
        .addTo(map)
        .bindTooltip(label, { direction: "top" });
    };
    for (const o of options) {
      if (o.bus) {
        upsert(`${o.label}-${o.bus.name}`, o.bus, o.color, o.bus.name ? `${o.label} #${o.bus.name}` : o.label, false);
      }
      if (o.passedBus) {
        upsert(
          `${o.label}-passed-${o.passedBus.name}`,
          o.passedBus,
          o.color,
          o.passedBus.name ? `#${o.passedBus.name} — just passed` : "Just passed",
          true,
        );
      }
    }
    // Remove markers whose options dropped (bus went dormant).
    for (const [key, marker] of Object.entries(busMarkersRef.current)) {
      if (!seenKeys.has(key)) {
        map.removeLayer(marker);
        delete busMarkersRef.current[key];
      }
    }
  }, [options]);

  // Fullscreen toggle — matches the per-option TripMap behavior.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 80);
    return () => clearTimeout(t);
  }, [fullscreen]);
  const wrapperStyle: React.CSSProperties = fullscreen
    ? {
        position: "fixed", inset: 0, zIndex: 9999,
        borderRadius: 0, border: "none", overflow: "hidden", marginTop: 0,
      }
    : {
        // Tall enough to actually read the geography (user feedback:
        // 200px was too small a glance) while the option rows stay
        // reachable in the first screenful.
        position: "relative", height: 320, borderRadius: 6,
        border: "1px solid #e0ddd8", overflow: "hidden", marginTop: 6,
      };

  return (
    <div className="trip-map-wrap" style={wrapperStyle}>
      <style>{`
        .trip-map-wrap .leaflet-tile-pane {
          filter: grayscale(0.9) contrast(0.95) brightness(1.05);
        }
        .trip-map-wrap .eta-tip {
          padding: 1px 6px;
          font-size: 10px;
          font-weight: 700;
          border-radius: 6px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.25);
        }
      `}</style>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      <button
        onClick={(e) => { e.stopPropagation(); setFullscreen((v) => !v); }}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        style={{
          position: "absolute", top: 8, right: 8, zIndex: 1000,
          width: 44, height: 44, border: "none", borderRadius: 8,
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          cursor: "pointer", fontSize: 18, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {fullscreen ? "✕" : "⛶"}
      </button>
      {/* Legend: route color chips so the user can tell which
          polyline is which option without hovering. */}
      <div style={{
        position: "absolute", bottom: 8, left: 8, zIndex: 1000,
        background: "rgba(255,255,255,0.92)", borderRadius: 6,
        padding: "4px 8px", fontSize: 10, color: "#263238",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        {options.map((o, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 3, background: o.color, borderRadius: 1 }} />
            <span style={{ fontWeight: 600, color: o.color }}>{o.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Route color keyed by TransLoc route id (string), derived from ROUTE_LISTS.
const ROUTE_COLOR_BY_ID: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const cfg of ROUTE_LISTS) for (const rid of cfg.routeIds) m[rid] = cfg.color;
  return m;
})();
const routeColorFor = (routeId: number): string =>
  ROUTE_COLOR_BY_ID[String(routeId)] ?? "#546e7a";

// Full system map for the "Map" tab — every route polyline, every stop, and
// live bus positions on one Leaflet view. Routes/stops are drawn once on
// mount; bus markers update in place each poll so the map doesn't rebuild.
const AllRoutesMap: FC<{
  buses: BusData[];
  routePaths: Record<string, [number, number][]>;
  stopCoords: Record<number, LatLon>;
  stopNames: Record<number, string>;
  routeStops: Record<string, number[]>;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
}> = ({ buses, routePaths, stopCoords, stopNames, routeStops, userLatLon, onRequestLocate }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const busLayerRef = useRef<L.LayerGroup | null>(null);
  const youMarkerRef = useRef<L.Marker | null>(null);
  // True once the view has been fitted to live bus positions — either at
  // mount or by the one-shot refit when the first poll lands.
  const busFitDoneRef = useRef(false);
  // Set when "locate me" is tapped before a GPS fix exists — the
  // userLatLon effect below consumes it to pan once the fix lands.
  const [awaitingPan, setAwaitingPan] = useState(false);

  // Faithful port of the original v2 LiveMap bus marker: a route-colored disc
  // with the bus number inside, a direction arrow orbiting the disc by
  // heading (the disc itself stays upright), and a pulse ring when the bus is
  // dwelling at a stop so standing buses read differently from moving ones.
  const busIcon = (color: string, headingDeg: number, label: string, dwelling: boolean) => {
    const fontSize = label.length >= 3 ? 9 : 11;
    return L.divIcon({
      className: "bus-marker",
      html: `
        <div style="width:44px;height:44px;position:relative;">
          ${dwelling ? `<div style="position:absolute;inset:4px;border:2px solid ${color};border-radius:50%;opacity:0.35;animation:shuttlePulse 1.8s ease-out infinite;"></div>` : ""}
          <div style="position:absolute;inset:0;transform:rotate(${Math.round(headingDeg)}deg);">
            <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${color};filter:drop-shadow(0 -1px 1px rgba(0,0,0,0.4));"></div>
          </div>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;background:${color};color:#fff;border:2.5px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font:700 ${fontSize}px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-0.02em;">${label}</div>
        </div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
  };

  // Mount-once: tiles, route polylines (weight 4), recessive white-ring stops,
  // initial fit. Rebuilds only if the set of routes changes (≈ every 6 h
  // upstream refresh), not per poll. Routes/stops are static for a session.
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);

    const pts: [number, number][] = [];
    for (const [rid, path] of Object.entries(routePaths)) {
      if (!path || path.length < 2) continue;
      L.polyline(path, { color: routeColorFor(Number(rid)), weight: 4, opacity: 0.85 }).addTo(map);
      for (const p of path) pts.push(p);
    }
    const stopIds = new Set<number>();
    for (const ids of Object.values(routeStops)) for (const s of ids) stopIds.add(s);
    for (const sid of stopIds) {
      const c = stopCoords[sid];
      if (!c) continue;
      L.circleMarker([c.lat, c.lon], {
        radius: 4, color: "#0f172a", weight: 1.5, fillColor: "#ffffff", fillOpacity: 1,
      }).addTo(map).bindTooltip(
        (stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/"),
        { direction: "top", offset: [0, -4] },
      );
      pts.push([c.lat, c.lon]);
    }
    busLayerRef.current = L.layerGroup().addTo(map);
    // Initial view: fit the LIVE BUSES, not the full route extents — the
    // Blue West / grocery loops stretch to West Haven and Hamden, which
    // zoomed the default view out to the whole metro area with the actual
    // shuttles reduced to a downtown speck. Fall back to route bounds
    // until the first bus poll lands (the buses effect below refits once).
    if (buses.length > 0) {
      map.fitBounds(L.latLngBounds(buses.map((b) => [b.lat, b.lon] as [number, number])), {
        padding: [48, 48], maxZoom: 15,
      });
      busFitDoneRef.current = true;
    } else if (pts.length) {
      map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
    }
    // The tab mounts hidden-then-shown, so the container can have 0 height at
    // init — recompute size a couple of times after layout settles or the
    // tiles render into a thin strip.
    const t1 = setTimeout(() => map.invalidateSize(), 60);
    const t2 = setTimeout(() => map.invalidateSize(), 300);

    return () => {
      clearTimeout(t1); clearTimeout(t2);
      // Cancel any in-flight pan/zoom animation before teardown —
      // Leaflet's queued animation frame otherwise fires on the removed
      // map and throws "_leaflet_pos of undefined".
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      mapRef.current = null;
      busLayerRef.current = null;
      youMarkerRef.current = null; // died with the map
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(Object.keys(routePaths).sort())]);

  // Live buses — redrawn each poll (the hot path; cheap for ~17 markers).
  useEffect(() => {
    const grp = busLayerRef.current;
    if (!grp) return;
    grp.clearLayers();
    for (const b of buses) {
      const color = routeColorFor(b.route_id);
      const label = b.bus_name.replace(/^#/, "");
      const dwelling = b.at_stop_id != null;
      const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(b.route_id));
      L.marker([b.lat, b.lon], {
        icon: busIcon(color, b.heading ?? 0, label, dwelling),
        keyboard: false, zIndexOffset: 1000,
      })
        .bindTooltip(() => {
          let tip = `${b.bus_name} · ${cfg?.label ?? `Route ${b.route_id}`}`;
          if (b.at_stop_id != null && b.at_stop_since) {
            const minAt = Math.round(Math.max(0, (Date.now() - new Date(b.at_stop_since + "Z").getTime()) / 60000));
            if (minAt > 0) tip += ` · at stop ${minAt} min`;
          }
          return tip;
        }, { direction: "top", offset: [0, -16] })
        .addTo(grp);
    }
    // One-shot: if the map mounted before the first bus poll, tighten the
    // view onto the fleet as soon as it exists.
    if (!busFitDoneRef.current && buses.length > 0 && mapRef.current) {
      busFitDoneRef.current = true;
      mapRef.current.fitBounds(L.latLngBounds(buses.map((b) => [b.lat, b.lon] as [number, number])), {
        padding: [48, 48], maxZoom: 15,
      });
    }
  }, [buses]);

  // "You are here" — same pulsing blue dot as the trip mini-map. Created
  // lazily on the first fix, then moved in place per watchPosition update
  // (cheaper than clear-and-redraw, and the pulse animation isn't reset).
  // Removed if location goes away (permission revoked mid-session).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLatLon) {
      youMarkerRef.current?.remove();
      youMarkerRef.current = null;
      return;
    }
    if (youMarkerRef.current) {
      youMarkerRef.current.setLatLng([userLatLon.lat, userLatLon.lon]);
    } else {
      youMarkerRef.current = L.marker([userLatLon.lat, userLatLon.lon], {
        icon: makeYouIcon(), keyboard: false, interactive: false, zIndexOffset: 900,
      }).addTo(map);
    }
    if (awaitingPan) {
      setAwaitingPan(false);
      map.setView([userLatLon.lat, userLatLon.lon], Math.max(map.getZoom(), 16), { animate: true });
    }
  }, [userLatLon?.lat, userLatLon?.lon, awaitingPan]);

  const locateMe = () => {
    const map = mapRef.current;
    if (map && userLatLon) {
      map.setView([userLatLon.lat, userLatLon.lon], Math.max(map.getZoom(), 16), { animate: true });
      return;
    }
    // No fix yet — kick off the parent's geolocation flow and pan when
    // the first position arrives.
    setAwaitingPan(true);
    onRequestLocate();
  };

  return (
    // width:100% is load-bearing — the app root is a flex column with
    // align-items:center, which would otherwise shrink this wrapper (and the
    // Leaflet container inside it) to ~0 width, collapsing the map to a
    // vertical line.
    <div style={{ width: "100%", maxWidth: 1000, margin: "0 auto", padding: "0 8px 12px", boxSizing: "border-box" }}>
      <style>{`@keyframes shuttlePulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }`}</style>
      <div style={{ position: "relative", width: "100%" }}>
        <div ref={ref} style={{
          position: "relative", width: "100%", height: "72vh", borderRadius: 8,
          border: "1px solid #e0ddd8", overflow: "hidden",
        }} />
        {/* "Locate me" — sits above the Leaflet panes (z-index 1000 matches
            Leaflet's own controls). Top-right, away from the zoom control. */}
        <button
          onClick={locateMe}
          aria-label="Show my location"
          title="Show my location"
          style={{
            position: "absolute", top: 10, right: 10, zIndex: 1000,
            width: 44, height: 44, borderRadius: 10,
            border: "1px solid #cfd8dc", background: "#fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, lineHeight: 1, padding: 0,
          }}
        >
          📍
        </button>
      </div>
    </div>
  );
};


const TripPlanner: FC<{
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, LatLon>;
  routeStops: Record<string, number[]>;
  routePaths: Record<string, [number, number][]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>;
  dwellsByBus: Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>;
  busPace: Record<string, { fast?: boolean; slow?: boolean; ratio?: number; n?: number; skip?: { count: number; ago_sec: number } | null }>;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
  locating?: boolean;
  locateError?: string | null;
  savedTrips: SavedTrip[];
  onSaveTrip: (trip: SavedTrip) => void;
  onDeleteSaved: (id: string) => void;
  onRenameSaved: (id: string, toText: string) => void;
  recentTrips: SavedTrip[];
  onRecordRecent: (trips: SavedTrip[]) => void;
  onDeleteRecent: (id: string) => void;
  pendingTrip: SavedTrip | null;
  onConsumePending: () => void;
  // Parent passes a callback so the Accuracy tab can scope its stats to
  // the pickup stops on the current plan. Pushed as a deduped, sorted
  // array so referential equality reflects a real change, not just a
  // re-render.
  // Live accuracy rollup (p95/p90 per stop, and per stops-ahead bucket).
  // Nullable because the fetch runs in parallel with the trip page —
  // UI must tolerate missing data gracefully.
  accuracy?: AccuracyData | null;
  // Called when the rider taps "I'm on this bus" on an expanded shuttle option.
  onBoard: (ride: BoardedRide) => void;
  // Go mode: the committed trip (state lives in the parent so it survives
  // tab switches), plus start/update/end callbacks.
  goTrip: GoTrip | null;
  onGoStart: (g: GoTrip) => void;
  onGoUpdate: (g: GoTrip) => void;
  onGoEnd: () => void;
  // GPS course (degrees from north, null when stationary) for the Go
  // screen's compass arrow.
  userHeading: number | null;
}> = ({ buses, stopNames, stopCoords, routeStops, routePaths, segmentTimes, dwellTimes, dwellsByBus, busPace, userLatLon, onRequestLocate, locating, locateError, savedTrips, onSaveTrip, onDeleteSaved, onRenameSaved, recentTrips, onRecordRecent, onDeleteRecent, pendingTrip, onConsumePending, accuracy, onBoard, goTrip, onGoStart, onGoUpdate, onGoEnd, userHeading }) => {
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [fromLL, setFromLL] = useState<LatLon | null>(null);
  const [toLL, setToLL] = useState<LatLon | null>(null);
  const [fromSugg, setFromSugg] = useState<GeocodeResult[]>([]);
  const [toSugg, setToSugg] = useState<GeocodeResult[]>([]);
  // Keyboard-navigation index into each suggestion list. -1 = nothing
  // highlighted yet (Enter falls back to the first result like before).
  const [fromActive, setFromActive] = useState(-1);
  const [toActive, setToActive] = useState(-1);
  // Google-Maps-style: the From input is hidden by default (current
  // location is assumed) and the user reveals it with a "change" tap
  // only when they want to start from somewhere else. Auto-collapses
  // again once a pick lands.
  const [fromExpanded, setFromExpanded] = useState(false);
  // Same collapse/expand pattern for To, but the default changes with
  // whether a destination is locked: until then the raw input is the
  // UX; after, it becomes a summary pill matching the From styling.
  const [toExpanded, setToExpanded] = useState(false);
  const fromInputRef = useRef<HTMLInputElement | null>(null);
  const toInputRef = useRef<HTMLInputElement | null>(null);
  const [searching, setSearching] = useState<"from" | "to" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Expansion state is keyed by OPTION IDENTITY (route label; "Walk" for
  // the walk option), not list position — the list re-sorts live (departed
  // options sink), and a positional index made the open card silently jump
  // to whichever option landed on that index mid-watch.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Which option has its stop list open. AUTO-OPENS with the route's
  // details (user request 2026-07-17) — the Stops toggle can still
  // collapse it.
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  useEffect(() => { setDetailsKey(expandedKey); }, [expandedKey]);
  // Google-Maps-app style: show the route-overview map open by default
  // (rider sees the map first, cards below) — collapsible via the same
  // toggle for anyone who'd rather not see it.
  const [overviewExpanded, setOverviewExpanded] = useState(true);
  const [showAllOptions, setShowAllOptions] = useState(false);
  // Empty string = "plan for now". A datetime-local value flips future mode
  // on inside planTrip and lets us predict against the published schedule
  // instead of the live bus fleet.
  const [tripTime, setTripTime] = useState<string>("");
  const targetDate = tripTime ? new Date(tripTime) : null;
  const isFuture = !!targetDate && targetDate.getTime() - Date.now() > 60_000;

  // Approach-progress snapshots for the expanded card's stop list: where
  // the pinned bus was (stops-away from the board stop) when the rider
  // first looked, keyed by route|bus|boardStop. Lets the list keep passed
  // stops visible and FILL the vertical line like a progress bar as the
  // bus advances, instead of silently dropping rows. Entries expire after
  // 30 min so yesterday's snapshot can't stretch today's track.
  const approachStartRef = useRef<Record<string, { away: number; at: number }>>({});
  // AbortControllers per field so pickFrom/pickTo can cancel a debounced
  // fetch that was already in flight — otherwise the late response would
  // reopen the dropdown right after the user picked a location.
  const fromAbortRef = useRef<AbortController | null>(null);
  const toAbortRef = useRef<AbortController | null>(null);
  // Cache of the previous toText so "clear-to-re-type" (the ✕ while
  // a destination is locked) can restore the pill display if the user
  // collapses without committing a new pick.
  const prevToTextRef = useRef<string>("");
  // Same idea for From: remember what the pill said so blur-without-
  // pick restores the original rather than leaving the pill blank.
  const prevFromTextRef = useRef<string>("");
  // Short-lived status string shown beside "Report issue" after a
  // submit lands (e.g. "Thanks, logged (#42)") or fails.
  const [reportStatus, setReportStatus] = useState<string | null>(null);

  // "Alert me" — fires a browser Notification when the selected bus is ≤5 min away.
  const [alertedRide, setAlertedRide] = useState<AlertedRide | null>(() => loadAlertedRide());
  useEffect(() => { saveAlertedRide(alertedRide); }, [alertedRide]);

  // Reset the keyboard-active index whenever the suggestion list changes,
  // so an outdated highlight never survives a new set of results.
  useEffect(() => { setFromActive(-1); }, [fromSugg]);
  useEffect(() => { setToActive(-1); }, [toSugg]);

  // Safety net: no matter what race condition leaves `searching` set
  // past its time, force-clear after 8 seconds. A real geocode
  // shouldn't take close to that long; if it does the rider is
  // better off seeing a blank-state than a stuck spinner.
  useEffect(() => {
    if (searching === null) return;
    const id = setTimeout(() => setSearching(null), 8_000);
    return () => clearTimeout(id);
  }, [searching]);

  const pickFrom = (g: GeocodeResult) => {
    fromAbortRef.current?.abort();
    fromAbortRef.current = null;
    setFromLL({ lat: g.lat, lon: g.lon });
    const display = g.display_name.split(",").slice(0, 2).join(", ");
    setFromText(display);
    prevFromTextRef.current = display;
    setFromSugg([]);
    // Drop the iOS on-screen keyboard and collapse the field back to
    // the summary pill — mirrors how Google Maps hides the editor once
    // you commit a pick.
    fromInputRef.current?.blur();
    setFromExpanded(false);
    // Aborting the fetch above means the in-flight request's finally
    // block won't clear `searching` (abortRef no longer matches its
    // controller). Do it ourselves — otherwise the loading banner is
    // stuck even though results are now on screen.
    setSearching((cur) => cur === "from" ? null : cur);
  };
  const pickTo = (g: GeocodeResult) => {
    toAbortRef.current?.abort();
    toAbortRef.current = null;
    setToLL({ lat: g.lat, lon: g.lon });
    const display = g.display_name.split(",").slice(0, 2).join(", ");
    setToText(display);
    // Remember what we landed on so the pill can be restored if the
    // rider later opens edit mode and bails without re-picking.
    prevToTextRef.current = display;
    setToSugg([]);
    // Collapse the To field to its summary pill (matches the From
    // pattern) and dismiss the iOS keyboard.
    setToExpanded(false);
    toInputRef.current?.blur();
    setSearching((cur) => cur === "to" ? null : cur);
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
      const raw: GeocodeResult[] = d.results ?? [];
      // Drop results outside the shuttle service area (a Milford hit is
      // noise here) and cap the list so the dropdown stays scannable.
      // If the filter kills everything, fall back to the raw list — the
      // rider may genuinely be searching somewhere farther out.
      let results = raw.filter((g) => haversineMeters(SERVICE_CENTER, g) <= SERVICE_RADIUS_M).slice(0, 8);
      if (results.length === 0) results = raw.slice(0, 8);
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
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [editingSavedMode, setEditingSavedMode] = useState(false);
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
    setFromText("Current location");
    setFromLL(null);
    setFromSugg([]);
    setAwaitingLocation(true);
    onRequestLocate();
  };
  // Auto-apply the user's location once it lands if they had clicked
  // the locate button. Avoids a second click. The wait also ENDS without
  // a fix when the locate errors out (timeout/denied) or the rider gives
  // up and picks a start manually — otherwise the "Getting your
  // location…" spinner spun forever next to the "location request timed
  // out" notice (user report 2026-07-17). "Current location" is the
  // placeholder both locate flows set, not a manual entry.
  useEffect(() => {
    if (!awaitingLocation) return;
    if (fromLL || (fromText && fromText !== "Current location") || locateError) {
      setAwaitingLocation(false);
      return;
    }
    if (userLatLon) {
      setFromLL(userLatLon);
      setFromText("Current location");
      setFromSugg([]);
      setAwaitingLocation(false);
    }
  }, [awaitingLocation, userLatLon, fromLL, fromText, locateError]);

  // Effective From coord: explicit pick wins; otherwise fall back to live
  // GPS when the user hasn't typed anything (placeholder "Current location"
  // state). This way leaving From empty + tapping a Saved destination just
  // works without a separate "use current location" click.
  const effectiveFromLL = fromLL ?? (!fromText ? userLatLon : null);
  // Memoize the candidate set (which routes, which board/alight pair per
  // route) on the endpoint coords + target time. This stops the list
  // from reshuffling every /api/buses poll. Then recompute live wait /
  // totalSec for each option per render so the "arriving in Xm" text
  // stays fresh as the bus moves. Without this split, freezing the
  // list also froze ETAs — leaving a stale "3 min" on screen while the
  // bus was actually pulling up.
  // Bumping this forces planTrip to re-run from scratch against the
  // latest buses/segments. Used by the Enter-in-search-bar refresh —
  // press Enter with a locked destination and we recompute.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshed, setRefreshed] = useState(false);

  const stableOptions = useMemo(
    () => (effectiveFromLL && toLL)
      ? planTrip(effectiveFromLL, toLL, buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus, targetDate)
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveFromLL?.lat, effectiveFromLL?.lon, toLL?.lat, toLL?.lon, targetDate?.getTime(), refreshKey],
  );

  // Collapse the "show more" list whenever a new trip is planned.
  useEffect(() => { setShowAllOptions(false); }, [stableOptions]);

  // "Routes that could get you there, but aren't running right now"
  // — displayed when planTrip yields only Walk. Recomputed alongside
  // stableOptions because it depends on the same endpoint + targetDate.
  const potentialRoutes = useMemo(() => {
    if (!effectiveFromLL || !toLL) return [];
    const after = targetDate && targetDate.getTime() > Date.now()
      ? targetDate
      : new Date();
    return findPotentialRoutes(effectiveFromLL, toLL, routeStops, stopCoords, after);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFromLL?.lat, effectiveFromLL?.lon, toLL?.lat, toLL?.lon, targetDate?.getTime(), routeStops, stopCoords, refreshKey]);
  const options: TripOption[] | null = useMemo(() => {
    if (!stableOptions) return null;
    // For future-mode (user picked a date >60s out) we can't refresh
    // against live buses — keep the memoized numbers.
    const isFutureMode = !!targetDate && targetDate.getTime() - Date.now() > 60_000;
    if (isFutureMode) return stableOptions;
    return stableOptions.map((o) => {
      if (o.mode !== "shuttle") return o;
      // Re-derive wait from current arrivals. Simpler than it used to
      // be — a large pinned.eta *by itself* doesn't mean "just
      // passed" (it could just mean the bus is on the far side of
      // the loop coming toward you). We only flag departed when NO
      // bus on the route is catchable.
      const live = computeUpcomingArrivals(
        [o.boardStopId], buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus,
      ).filter((a) => a.routeLabel === o.routeLabel);
      // No live arrival = planTrip saw a bus on this route but the
      // anchor math can't produce a future ETA for the board stop.
      // This has two distinct causes:
      //   (a) The bus is dwelling AT the board stop — computeUpcomingArrivals's
      //       step loop runs 1..N-1 and never wraps back to the bus's own
      //       anchor, so no ETA is emitted. The bus is RIGHT THERE; do NOT
      //       flag departed. Instead treat it as waitSec=0 so the card shows
      //       "arriving now" / "0 min". Fixes reports #36, #37, #38.
      //   (b) Genuinely no catchable bus — flag departed as before.
      // If the user's GPS puts them within 80 m of the board stop, treat them
      // as already there (walkToSec = 0). Stale GPS commonly reports a position
      // 30-100 m off, which makes an arriving bus look uncatchable when the rider
      // is standing right at the stop.
      // Judge proximity from the rider's LIVE position, not the origin
      // pinned at search time. When the trip starts from "current
      // location", fromLL (hence effectiveFromLL) is frozen at the coord
      // captured when they tapped search — but userLatLon keeps updating
      // via watchPosition as they walk toward the stop. Using the frozen
      // origin made the catchable/"just passed" math think the rider was
      // still back where they started even while standing at the stop.
      const liveFromLL = (!fromText && userLatLon) ? userLatLon : effectiveFromLL;
      const usingLive = liveFromLL !== effectiveFromLL;
      const boardCoords = stopCoords[o.boardStopId];
      const distToBoard = (boardCoords && liveFromLL)
        ? haversineMeters(liveFromLL, boardCoords)
        : Infinity;
      // Within 80 m → treat as standing at the stop (walk = 0). Otherwise,
      // when tracking live GPS, derive the *remaining* walk from current
      // distance rather than the original full walk leg, so partial
      // progress toward the stop shrinks the wait/catchable window.
      const effectiveWalkToSec = distToBoard < 80
        ? 0
        : (usingLive ? walkSecFromMeters(distToBoard) : o.walkToSec);

      // Before any "catchable / just passed" arithmetic: if a bus on this
      // route is physically sitting at the board stop right now and the
      // rider can still reach it, it's boardable this instant. Keep it
      // (wait = 0) — a dwelling bus hasn't left yet, so never flag "#X just
      // passed" or skip to a later bus while one is parked at your stop.
      // Prefer the planned bus if it's the one parked there. NOTE: a bus
      // parked at its stop emits no ETA from computeUpcomingArrivals (the
      // step loop never wraps to its own anchor), so without this guard the
      // planned bus silently drops out of `live` and the card jumps to the
      // next bus even though you could board the one right in front of you.
      const cfg = ROUTE_LISTS.find((c) => c.label === o.routeLabel);
      const norm = (s: string) => s.replace(/^#/, "");
      const busesAtBoard = cfg
        ? buses.filter((b) => cfg.busRouteIds.includes(b.route_id) && b.at_stop_id === o.boardStopId)
        : [];
      const hereBus = busesAtBoard.find((b) => norm(b.bus_name) === norm(o.busName)) ?? busesAtBoard[0];
      if (hereBus && cfg && effectiveWalkToSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], o.boardStopId, dwellTimes)) {
        // Reachable before the dwelling bus pulls away (dwell-aware window,
        // shared with planTrip). Beyond that the bus will be gone before
        // they arrive, so fall through to the normal math.
        const waitSec = 0;
        const totalSec = effectiveWalkToSec + waitSec + o.rideSec + o.walkFromSec;
        return { ...o, waitSec, totalSec, busName: norm(hereBus.bus_name), departed: false };
      }

      if (live.length === 0) {
        // No future arrival and no bus parked at the stop — truly unreachable.
        return { ...o, departed: true };
      }
      // A bus is catchable if the user arrives at the stop before the bus
      // finishes dwelling. Bus reaches stop at bus.eta, dwells for
      // STOP_DWELL_SEC, then departs. User reaches stop at effectiveWalkToSec.
      // Catchable when: effectiveWalkToSec <= bus.eta + STOP_DWELL_SEC
      const STOP_DWELL_SEC = 60;
      // Extra buffer before switching away from the planned bus. Live GPS can
      // read 50–100 m long while the rider is walking, inflating effectiveWalkToSec
      // past the catchable threshold and causing a spurious flip to the next shuttle.
      // Require the overshoot to exceed 90 s (~110 m at walking speed) before giving up.
      const SWITCH_BUFFER_SEC = 90;
      const canCatch = (bus: typeof live[number]) =>
        effectiveWalkToSec <= bus.eta + STOP_DWELL_SEC;
      const canCatchWithBuffer = (bus: typeof live[number]) =>
        effectiveWalkToSec <= bus.eta + STOP_DWELL_SEC + SWITCH_BUFFER_SEC;
      const catchable = live.filter(canCatch);
      const pinned = live.find((a) => a.busName.replace(/^#/, "") === o.busName.replace(/^#/, ""));
      let match: typeof live[number];
      let departed = false;
      let missedBus: string | undefined;
      if (pinned && canCatch(pinned)) {
        match = pinned;
      } else if (pinned && canCatchWithBuffer(pinned)) {
        // Borderline — GPS may be reading long. Stay on the planned bus; waitSec clamps to 0.
        match = pinned;
      } else if (catchable.length > 0) {
        match = catchable[0];
        // The planned bus is still in the feed but we can no longer make it —
        // record it as missed so the card can surface "#X just passed".
        if (pinned && !canCatch(pinned)) missedBus = pinned.busName.replace(/^#/, "");
      } else {
        match = pinned ?? live[0];
        departed = true;
      }
      const waitSec = Math.max(0, match.eta - effectiveWalkToSec);
      const totalSec = effectiveWalkToSec + waitSec + o.rideSec + o.walkFromSec;
      return { ...o, waitSec, totalSec, busName: match.busName, departed, missedBus };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableOptions, buses, dwellTimes, dwellsByBus, segmentTimes, routeStops, stopCoords, targetDate, effectiveFromLL?.lat, effectiveFromLL?.lon, fromText, userLatLon?.lat, userLatLon?.lon]);

  // A shuttle is "slower than walking" only when the time spent actually
  // COMMUTING (walk to stop + ride + walk from stop) exceeds the direct
  // walk — not when the arrival time does. Waiting isn't commuting: the
  // rider can spend the wait at their desk and leave at the leave-by
  // time. Only judged when walking is a real alternative (direct walk
  // ≤ 60 min — the walk card itself is suppressed beyond that).
  const slowerThanWalk = (o: TripOption) =>
    o.mode === "shuttle" && !o.departed &&
    o.directWalkSec <= 3600 &&
    o.walkToSec + o.rideSec + o.walkFromSec > o.directWalkSec;
  // Shared row/map order: competitive / slower-than-walk / departed,
  // fastest first within each tier by live total.
  const optionTier = (o: TripOption) => (o.departed ? 2 : slowerThanWalk(o) ? 1 : 0);
  const sortOptions = (list: TripOption[]) =>
    [...list].sort((a, b) => optionTier(a) - optionTier(b) || a.totalSec - b.totalSec);
  // Display order with HYSTERESIS (user feedback 2026-07-17: fastest
  // first, but "make sure there's some stability — avoid flicker").
  // Each render starts from the previously displayed order; a lower card
  // climbs only for a better tier or a ≥90 s faster live total, so small
  // wait-noise oscillations never reorder the list mid-glance.
  const displayOrderRef = useRef<string[]>([]);
  const orderDestRef = useRef<string>("");
  const orderedOptions = useMemo(() => {
    if (!options) { displayOrderRef.current = []; return null; }
    // New destination → forget the old trip's ranking entirely.
    const destKey = `${toLL?.lat},${toLL?.lon}`;
    if (orderDestRef.current !== destKey) {
      orderDestRef.current = destKey;
      displayOrderRef.current = [];
    }
    const byKey = new Map(options.map((o) => [o.routeLabel, o]));
    const kept = displayOrderRef.current.filter((k) => byKey.has(k));
    const fresh = sortOptions(options.filter((o) => !kept.includes(o.routeLabel))).map((o) => o.routeLabel);
    const arr = [...kept, ...fresh];
    const HYST_SEC = 90;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = byKey.get(arr[i])!;
        const b = byKey.get(arr[i + 1])!;
        if (
          optionTier(b) < optionTier(a) ||
          (optionTier(b) === optionTier(a) && b.totalSec < a.totalSec - HYST_SEC)
        ) {
          [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          changed = true;
        }
      }
    }
    displayOrderRef.current = arr;
    return arr.map((k) => byKey.get(k)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, toLL?.lat, toLL?.lon]);

  // Auto-boarding detection: offer to board when user is within 60 m of the
  // planned board stop and a matching bus is dwelling at that stop.
  // NOTE: must live BELOW the `options` useMemo — the deps array is
  // evaluated at render time, and referencing `options` before its
  // declaration is a TDZ ReferenceError that blank-screens the app.
  const [autoDetectOffer, setAutoDetectOffer] = useState<{
    option: TripOption; bus: BusData; key: string; aboard?: boolean;
  } | null>(null);
  const dismissedAutoRef = useRef(new Set<string>());
  // Aboard-offer evidence: consecutive near-a-bus sightings PLUS how far
  // the rider has moved since the first one. Proximity alone false-fires
  // for someone standing still while a bus dwells next to them (user
  // report 2026-07-17) — actually riding means YOU are covering ground.
  const aboardStreakRef = useRef<{ key: string; count: number; startLat: number; startLon: number } | null>(null);
  useEffect(() => {
    if (!userLatLon || !options || !stopCoords) { setAutoDetectOffer(null); return; }
    const norm = (s: string) => s.replace(/^#/, "");
    for (const o of options) {
      if (o.mode !== "shuttle" || o.departed) continue;
      const board = stopCoords[o.boardStopId];
      if (!board || haversineMeters(userLatLon, board) > 60) continue;
      const cfg = ROUTE_LISTS.find(c => c.label === o.routeLabel);
      if (!cfg) continue;
      const busAtStop = buses.find(b =>
        cfg.busRouteIds.includes(b.route_id) && b.at_stop_id === o.boardStopId
      );
      if (!busAtStop) continue;
      const key = `${o.routeLabel}-${o.boardStopId}-${norm(busAtStop.bus_name)}`;
      if (dismissedAutoRef.current.has(key)) continue;
      setAutoDetectOffer(prev => prev?.key === key ? prev : { option: o, bus: busAtStop, key });
      return;
    }
    // Rider-aboard detection (report #22): once their bus leaves the board
    // stop, the planner can only show the NEXT catchable shuttle — which
    // reads as "the app lost my bus" to someone already riding. If the
    // rider's GPS is moving along with a bus on one of the planned routes
    // (within ~100 m) across CONSECUTIVE updates — one hit is just a bus
    // driving past you — offer the dedicated ride page pinned to THAT
    // bus. Departed options are deliberately included: "your" bus leaving
    // the board stop with you on it is exactly what flags them departed.
    let aboard: { option: TripOption; bus: BusData; key: string } | null = null;
    for (const o of options) {
      if (o.mode !== "shuttle") continue;
      const cfg = ROUTE_LISTS.find(c => c.label === o.routeLabel);
      if (!cfg) continue;
      const busNear = buses.find(b =>
        cfg.busRouteIds.includes(b.route_id) &&
        b.lat && b.lon &&
        haversineMeters(userLatLon, { lat: b.lat, lon: b.lon }) < 100
      );
      if (!busNear) continue;
      const key = `aboard-${o.routeLabel}-${norm(busNear.bus_name)}`;
      if (dismissedAutoRef.current.has(key)) continue;
      aboard = { option: o, bus: busNear, key };
      break;
    }
    if (aboard) {
      const { key } = aboard;
      const streak = aboardStreakRef.current;
      aboardStreakRef.current = streak?.key === key
        ? { ...streak, count: streak.count + 1 }
        : { key, count: 1, startLat: userLatLon.lat, startLon: userLatLon.lon };
      const s = aboardStreakRef.current;
      // Offer only once the rider has MOVED ~150 m (beyond any GPS
      // jitter) while staying pinned to the same bus — standing at a
      // stop next to a dwelling bus accrues sightings but zero travel.
      const movedM = haversineMeters({ lat: s.startLat, lon: s.startLon }, userLatLon);
      if (s.count >= 2 && movedM > 150) {
        setAutoDetectOffer(prev => prev?.key === key ? prev : { option: aboard!.option, bus: aboard!.bus, key, aboard: true });
        return;
      }
    } else {
      aboardStreakRef.current = null;
    }
    setAutoDetectOffer(null);
  }, [userLatLon, buses, options, stopCoords]);

  // ---- Go mode (committed-trip guidance) ----
  // NOTE: everything here must stay BELOW the `options` useMemo (TDZ).
  const goActive = !!goTrip;
  // The committed trip's live option — carries the auto-updating wait,
  // catchability rebooking (missedBus), and departed state for free.
  const goOpt = goTrip && options
    ? options.find((o) => o.mode === "shuttle" && o.routeLabel === goTrip.routeLabel) ?? null
    : null;
  const goBoardCoord = goTrip ? stopCoords[goTrip.boardStopId] : undefined;
  const goDistM = goTrip && userLatLon && goBoardCoord ? haversineMeters(userLatLon, goBoardCoord) : null;
  // WAIT once the rider is essentially at the stop; WALK otherwise
  // (including when we have no GPS fix to judge by).
  const goStage: "walk" | "wait" = goDistM !== null && goDistM <= 80 ? "wait" : "walk";

  // Restore-race repair: if the plan ran before the first bus poll landed
  // (reload mid-trip), it's walk-only and the committed route looks dead.
  // Re-plan ONCE when buses arrive; if the route is genuinely bus-less the
  // banner's "no live bus" message stands after that single retry.
  const goReplanRef = useRef(false);
  useEffect(() => {
    if (!goTrip) { goReplanRef.current = false; return; }
    if (goReplanRef.current || goOpt || !options || buses.length === 0) return;
    goReplanRef.current = true;
    setRefreshKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTrip, goOpt, options, buses.length]);

  // Keep the committed busName in sync when the live option rebooks to a
  // later bus (planned one missed) — the parent's persistent bar and the
  // approach alert both key off goTrip.busName.
  useEffect(() => {
    if (!goTrip || !goOpt) return;
    const norm = (s: string) => s.replace(/^#/, "");
    if (norm(goOpt.busName) !== norm(goTrip.busName)) {
      onGoUpdate({ ...goTrip, busName: goOpt.busName });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goOpt?.busName]);

  // Go dashboard state: whether the PiP locator bubble is expanded to a
  // full-width map. Reset per trip.
  const [goMapBig, setGoMapBig] = useState(false);
  useEffect(() => { setGoMapBig(false); }, [goTrip?.startedAt]);

  // One-shot Go-mode nudges (vibrate + Notification when permitted).
  const goNotifiedRef = useRef<Set<string>>(new Set());
  const goNotify = (key: string, title: string, body: string) => {
    if (goNotifiedRef.current.has(key)) return;
    goNotifiedRef.current.add(key);
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported */ }
    try {
      if (Notification.permission === "granted") new Notification(title, { body });
    } catch { /* unsupported */ }
  };
  // WALK stage: "time to leave" — the slack (waitSec = time you'd stand at
  // the stop if you left right now) has burned down to the safety buffer.
  useEffect(() => {
    if (!goTrip || !goOpt || goOpt.departed || goStage !== "walk") return;
    if (goOpt.waitSec <= 90) {
      const norm = goOpt.busName.replace(/^#/, "");
      goNotify(
        `leave|${goTrip.startedAt}|${norm}`,
        "Time to leave",
        `Bus #${norm} — leave now to make it to ${(stopNames[goTrip.boardStopId] ?? "your stop").replace(/\s*\/\s*/g, "/")}.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goOpt?.waitSec, goStage, goTrip?.startedAt]);
  // WAIT stage: bus one stop away — get ready.
  useEffect(() => {
    if (!goTrip || goStage !== "wait" || !goOpt || goOpt.departed) return;
    const cfg = ROUTE_LISTS.find((c) => c.label === goTrip.routeLabel);
    if (!cfg) return;
    const allStops: number[] = [];
    const seen = new Set<number>();
    for (const rid of cfg.routeIds) {
      for (const sid of (routeStops[rid] ?? [])) {
        if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
      }
    }
    const bi = allStops.indexOf(goTrip.boardStopId);
    if (bi === -1) return;
    const norm = (s: string) => s.replace(/^#/, "");
    const bus = buses.find((b) =>
      norm(b.bus_name) === norm(goOpt.busName) &&
      cfg.busRouteIds.includes(b.route_id) &&
      isBusOnRoute(b, allStops, stopCoords),
    );
    if (!bus) return;
    const busIdx = findRouteAnchor(bus, allStops, stopCoords);
    if (busIdx < 0) return;
    const away = (bi - busIdx + allStops.length) % allStops.length;
    if (away === 1) {
      goNotify(
        `approach|${goTrip.startedAt}|${norm(goOpt.busName)}`,
        "Your bus is almost here",
        `#${norm(goOpt.busName)} is at the stop before yours — get ready.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buses, goStage, goOpt?.busName, goTrip?.startedAt]);

  // Apply a "plan this saved destination" request from Favorites: sets
  // the To field, and defaults From to current location (falling back to
  // empty if we don't have GPS yet).
  useEffect(() => {
    if (!pendingTrip) return;
    setToText(pendingTrip.toText);
    setToLL({ lat: pendingTrip.toLat, lon: pendingTrip.toLon });
    setToSugg([]);
    if (userLatLon) {
      setFromLL(userLatLon);
      setFromText("Current location");
      setFromSugg([]);
    }
    onConsumePending();
  }, [pendingTrip]);

  // Restore/enter Go mode: seed the destination from the committed trip so
  // the planner recomputes the same options after a refresh or a tab switch.
  // From stays empty on purpose — effectiveFromLL then tracks the live GPS
  // fix, so the walk estimate counts down as the rider actually walks.
  useEffect(() => {
    if (!goTrip) return;
    // Wait for the structural data (routes/stops) before seeding — on a
    // reload-restore this effect fires before the /api/buses payload
    // lands, and planTrip against empty data yields a walk-only plan
    // that the stableOptions memo (deliberately) never recomputes.
    if (Object.keys(routeStops).length === 0 || Object.keys(stopCoords).length === 0) return;
    // Collapse everything so the guided view starts compact. The
    // WAIT-stage effect expands the committed card (with its stop list)
    // once the rider is at the stop.
    setExpandedKey(null);
    if (toLL && Math.abs(toLL.lat - goTrip.toLat) < 1e-6 && Math.abs(toLL.lon - goTrip.toLon) < 1e-6) return;
    setToText(goTrip.toText);
    prevToTextRef.current = goTrip.toText;
    setToLL({ lat: goTrip.toLat, lon: goTrip.toLon });
    setToSugg([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTrip?.startedAt, Object.keys(routeStops).length === 0, Object.keys(stopCoords).length === 0]);

  // We store destinations only now (the From point is almost always the
  // user's current location, so saving a fixed From coord went stale).
  // SavedTrip shape is kept for storage compatibility; only toText/toLat/
  // toLon are used.
  const sameDest = (a: { toLat: number; toLon: number }, b: { toLat: number; toLon: number }) =>
    Math.abs(a.toLat - b.toLat) < 1e-4 && Math.abs(a.toLon - b.toLon) < 1e-4;

  const alreadySaved = toLL && savedTrips.some((t) => sameDest(t, { toLat: toLL.lat, toLon: toLL.lon }));

  // Record each new destination as "recent". De-dup by to-coord, most
  // recent first, cap at 10. Skip if already in saved.
  useEffect(() => {
    if (!toLL || !toText) return;
    const key = { toLat: toLL.lat, toLon: toLL.lon };
    if (savedTrips.some((t) => sameDest(t, key))) return;
    const filtered = recentTrips.filter((t) => !sameDest(t, key));
    const entry: SavedTrip = {
      id: `r${Date.now().toString(36)}`,
      name: toText,
      fromText: "", fromLat: 0, fromLon: 0,
      toText, toLat: toLL.lat, toLon: toLL.lon,
    };
    const next = [entry, ...filtered].slice(0, 10);
    if (next.length !== recentTrips.length || next[0].id !== recentTrips[0]?.id) {
      onRecordRecent(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toLL?.lat, toLL?.lon]);

  // Fire a browser Notification when:
  //   (a) dwellStopId set → bus has departed that stop (departure detection), or
  //   (b) no dwellStopId → bus ETA to pickup is ≤5 min.
  useEffect(() => {
    if (!alertedRide || !options) return;
    const normBus = (s: string) => s.replace(/^#/, "");
    const match = options.find(
      (o) =>
        o.mode === "shuttle" &&
        !o.departed &&
        normBus(o.busName) === normBus(alertedRide.busName) &&
        o.boardStopId === alertedRide.boardStopId &&
        o.routeLabel === alertedRide.routeLabel,
    );
    if (!match) return;

    if (alertedRide.dwellStopId != null) {
      // Departure mode: fire the moment the bus leaves the recorded dwell stop.
      const currentBus = buses.find((b) => normBus(b.bus_name) === normBus(alertedRide.busName));
      if (!currentBus || currentBus.at_stop_id === alertedRide.dwellStopId) return;
      const dwellName = (stopNames[alertedRide.dwellStopId] ?? "its stop").replace(/\s*\/\s*/g, "/");
      const etaMins = match.waitSec > 0 ? Math.round(match.waitSec / 60) : 0;
      const body = etaMins > 0
        ? `Bus #${normBus(alertedRide.busName)} left ${dwellName} — ~${etaMins} min to your stop`
        : `Bus #${normBus(alertedRide.busName)} left ${dwellName} — arriving now`;
      try { new Notification(`${alertedRide.routeLabel} is moving!`, { body }); } catch { /* blocked */ }
      setAlertedRide(null);
      return;
    }

    // ETA mode: fire when bus is ≤5 min from the pickup stop.
    if (match.waitSec > 300) return;
    const mins = Math.max(0, Math.round(match.waitSec / 60));
    const body = mins === 0 ? "Bus is arriving now!" : `Bus #${normBus(match.busName)} arrives in ${mins} min`;
    try { new Notification(`${alertedRide.routeLabel} arriving soon`, { body }); } catch { /* blocked */ }
    setAlertedRide(null);
  }, [options, alertedRide, buses, stopNames]);

  // "Current location" isn't a typed value — it's the implicit meaning
  // of an empty From field. Treat empty fromText + userLatLon as valid
  // "use my current GPS" so the user never has to delete a placeholder
  // label to type a new start.
  const fromIsCurrent = !fromText && (!!fromLL || !!userLatLon);

  // Once GPS resolves, silently snap From to it when the user hasn't
  // typed anything else. Covers the pending-locate case.
  useEffect(() => {
    if (userLatLon && !fromText && !fromLL) {
      setFromLL(userLatLon);
    }
  }, [userLatLon, fromText, fromLL]);

  // If the user sets a destination while From is still "use current
  // location" but we don't have GPS yet, kick off a locate request.
  useEffect(() => {
    if (toLL && !fromText && !fromLL && !locating && !userLatLon) {
      onRequestLocate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toLL]);

  const applyDestination = (t: SavedTrip) => {
    setToText(t.toText);
    setToLL({ lat: t.toLat, lon: t.toLon });
    setToSugg([]);
    // Always force From = current location when applying a saved dest.
    // If GPS hasn't been resolved yet, trigger a locate request and rely
    // on the awaitingLocation effect below to fill From when it lands.
    if (userLatLon) {
      setFromLL(userLatLon);
      setFromText("Current location");
      setFromSugg([]);
    } else {
      setFromText("Current location");
      setFromLL(null);
      setFromSugg([]);
      setAwaitingLocation(true);
      onRequestLocate();
    }
  };
  // Ship a snapshot of the current option + surrounding context to
  // /api/report so the developer can replay what the rider saw. The
  // note is optional; a terse prompt is enough to capture "bus had
  // passed" / "wrong route" / etc. The backend stores it verbatim in
  // the debug_reports table.
  const reportOption = async (o: TripOption) => {
    const note = window.prompt(
      "What's wrong with this route? (optional — leave blank to just snapshot the current state)",
      "",
    );
    // Null = user cancelled the prompt; empty string = pressed OK
    // with no note. Only the cancel case should abort the report.
    if (note === null) return;
    const busForOption = o.mode === "shuttle"
      ? buses.find((b) => {
          const n = (s: string) => s.replace(/^#/, "");
          return n(b.bus_name) === n(o.busName);
        })
      : null;
    setReportStatus("Sending…");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          client: {
            userAgent: navigator.userAgent,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            timestamp: new Date().toISOString(),
            targetDate: targetDate?.toISOString() ?? null,
            isFuture,
            userLatLon,
            effectiveFromLL,
            toLL,
            fromText, toText,
          },
          option: o,
          // Bus that this option was pinned to, at report time. Useful
          // for correlating the rider's "the red had passed" report
          // against the actual feed the server saw.
          pinnedBus: busForOption,
          // All buses currently on the same route as the option, so we
          // can see if a different bus was a better pick.
          routeBuses: o.mode === "shuttle"
            ? buses.filter((b) => {
                const cfg = ROUTE_LISTS.find((c) => c.label === o.routeLabel);
                return cfg ? cfg.busRouteIds.includes(b.route_id) : false;
              })
            : [],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setReportStatus(d?.id ? `Thanks — logged (#${d.id})` : "Thanks — logged");
    } catch (e) {
      setReportStatus("Couldn't send — try again");
    }
    setTimeout(() => setReportStatus(null), 6_000);
  };
  const handleSaveTrip = () => {
    if (!toLL) return;
    // Toggle: if this destination is already saved, tapping the star
    // removes it from Saved. Otherwise add a new entry.
    const match = savedTrips.find((t) => sameDest(t, { toLat: toLL.lat, toLon: toLL.lon }));
    if (match) {
      onDeleteSaved(match.id);
      return;
    }
    onSaveTrip({
      id: `t${Date.now().toString(36)}`,
      name: toText || "Saved destination",
      fromText: "", fromLat: 0, fromLon: 0,
      toText, toLat: toLL.lat, toLon: toLL.lon,
    });
  };

  // Collapse all option expansions when a fresh trip is planned. This
  // has to be synchronous so the options memo below sees expandedKey =
  // null on the first render of the new plan — otherwise the sticky-
  // watched-bus flag fires using the prior expansion index and paints
  // "departed" on an option the user never asked to watch. Derived-
  // state pattern: setState-during-render is legal when gated on a
  // prop/state change, and React reschedules the render with the new
  // state before paint.
  const tripKeyRef = useRef<string>("");
  const tripKey = `${fromLL?.lat}|${fromLL?.lon}|${toLL?.lat}|${toLL?.lon}|${targetDate?.getTime() ?? ""}`;
  if (tripKeyRef.current !== tripKey) {
    tripKeyRef.current = tripKey;
    if (expandedKey !== null) setExpandedKey(null);
  }

  const fmtMin = (s: number) => {
    // Floor for minutes ≥ 2 so "7 min" honestly means "at least 7 min
    // left" (Math.round would call 6:31 "7 min" and then jump to "6 min"
    // at 6:30 — felt stuck). Under 2 min, show MM:SS so the final
    // countdown ticks visibly each poll. Under 10 s, just "now".
    // "min" (not "m") everywhere so readers don't confuse it with miles.
    if (s < 10) return "now";
    if (s < 120) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, "0")}`;
    }
    return `${Math.floor(s / 60)} min`;
  };
  // Walking estimate — round to nearest minute. A 1:30 walk is "2 min"
  // not "1:30", since sub-minute precision on foot is meaningless and
  // the rider just wants "about N minutes of walking."
  const fmtWalk = (s: number) => {
    const m = Math.max(1, Math.round(s / 60));
    return `${m} min`;
  };
  // Wait time — floor to minutes. "1:32" of wait becomes "1 min" since
  // the bus won't arrive before that. "0 min" when under a minute so the
  // display reads honestly small.
  const fmtWait = (s: number) => {
    const m = Math.max(0, Math.floor(s / 60));
    return `${m} min`;
  };
  const fmtClock = (s: number, from?: Date) => {
    const base = from?.getTime() ?? Date.now();
    const d = new Date(base + s * 1000);
    let h = d.getHours();
    const mm = d.getMinutes();
    const ampm = h >= 12 ? "p" : "a";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(mm).padStart(2, "0")}${ampm}`;
  };

  const inputStyle: React.CSSProperties = {
    // 16px is the iOS threshold below which mobile Safari zooms the
    // viewport on focus — keep it at or above 16 or older readers
    // get surprise pinch-zoom every time they tap the field.
    flex: 1, minWidth: 0, fontSize: 16, padding: "12px 14px",
    minHeight: 48, border: "1px solid #ccc", borderRadius: 8, fontFamily: "inherit",
  };
  // Minimum 44×44 hit target (iOS/Material guideline). The clear-×
  // buttons were ~20px before and hard to hit on phones.
  const btnStyle: React.CSSProperties = {
    minWidth: 44, minHeight: 44, padding: "6px 14px", borderRadius: 8,
    border: "1px solid #bbb", background: "#fff", color: "#546e7a",
    fontSize: 15, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };

  const renderTripRow = (t: SavedTrip, onDelete: () => void, starred: boolean) => {
    const editing = editingSavedId === t.id;
    return (
    <div key={t.id} style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "5px 8px", borderRadius: 4, background: "#fff",
      border: "1px solid #e0ddd8", cursor: editing ? "default" : "pointer",
    }} onClick={() => { if (!editing) applyDestination(t); }}>
      {starred && <span style={{ color: "#2E7D32", fontSize: 10 }}>★</span>}
      {editing ? (
        <input
          defaultValue={t.toText}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== t.toText) onRenameSaved(t.id, v);
            setEditingSavedId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditingSavedId(null);
          }}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, padding: "2px 6px",
            border: "1px solid #c5e1a5", background: "#f1f8e9",
            borderRadius: 4, fontFamily: "inherit", color: "#263238",
          }}
        />
      ) : (
        <span style={{
          flex: 1, minWidth: 0, fontSize: 11, color: "#263238",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          <span style={{ color: "#9e9e9e", marginRight: 4 }}>→</span>
          <span style={{ color: "#C62828", fontWeight: 600 }}>{t.toText}</span>
        </span>
      )}
      {starred && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); setEditingSavedId(t.id); }}
          style={{
            border: "none", background: "transparent", color: "#9e9e9e",
            fontSize: 12, cursor: "pointer", padding: "0 2px", lineHeight: 1,
          }}
          title="Rename"
        >✎</button>
      )}
      {!starred && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            // Promote this recent destination into Saved. Use a fresh id so
            // the entries stay unique even if the user later re-visits and
            // a new recent record is generated.
            onSaveTrip({ ...t, id: `t${Date.now().toString(36)}` });
            onDelete();
          }}
          style={{
            border: "none", background: "transparent", color: "#2E7D32",
            fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
          }}
          title="Save destination"
        >☆</button>
      )}
      <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{
        border: "none", background: "transparent", color: "#9e9e9e",
        fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
      }} title="Remove">✕</button>
    </div>
    );
  };

  // Summary label for the collapsed From pill. Mirrors what the trip
  // planner would actually use as the start coord: explicit pick wins,
  // otherwise fall back to live GPS.
  const fromSummary = fromLL && fromText
    ? fromText
    : userLatLon
      ? "Current location"
      : locating
        ? "Locating…"
        : "Tap to set start";
  // Only reveal the From row once there's a destination on the page.
  // Before that the To field alone is the entire UX — matches the
  // user's mental model of "where am I going?" When a trip is planned,
  // the From summary pill appears above the locked To so they can
  // change the starting point. Also show From whenever the user
  // explicitly expanded it (rare — for "plan a walk from X to Y" cases).
  const showFromRow = !!toLL || fromExpanded;
  // Route-details page open: the search chrome (From/To/When) hides and a
  // top back bar leads the page instead (user request 2026-07-17).
  const detailOpen = !!expandedKey && !!options?.some((o) => o.routeLabel === expandedKey);
  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", padding: "8px 16px" }}>
      {/* Details view: search/plan chrome is hidden (not unmounted — its
          state must survive so ← back restores the same plan). */}
      <div style={{ display: detailOpen ? "none" : undefined }}>
      {/* From — hidden until the user picks a destination. Then it
          appears as a compact "From 📍 Current location [change]" pill
          so they can tweak the origin. Tapping "change" reveals the
          full input; after a pick, auto-collapses back. */}
      {!showFromRow ? null : !fromExpanded ? (
        <div
          onClick={() => {
            prevFromTextRef.current = fromText;
            setFromText("");
            setFromSugg([]);
            setFromExpanded(true);
            setTimeout(() => fromInputRef.current?.focus(), 0);
          }}
          role="button"
          tabIndex={0}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            marginBottom: 8, padding: "8px 12px",
            border: "1px solid #e0ddd8", borderRadius: 8, background: "#fafaf8",
            minHeight: 44, fontSize: 14, color: "#546e7a",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 11, color: "#78909c", letterSpacing: 1, textTransform: "uppercase" }}>From</span>
          <span style={{
            flex: 1, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: fromLL || userLatLon ? "#263238" : "#9e9e9e",
          }}>
            📍 {fromSummary}
          </span>
          {/* Inline swap: only offered when both ends are concrete so
              the reverse has a well-defined result. Sits on the From
              pill's trailing edge rather than a row of its own. */}
          {(fromLL || userLatLon) && toLL && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const oldFromLL = fromLL ?? userLatLon;
                const oldFromText = fromText || "Current location";
                const oldToLL = toLL;
                const oldToText = toText;
                setFromLL(oldToLL);
                setFromText(oldToText);
                prevFromTextRef.current = oldToText;
                setToLL(oldFromLL);
                setToText(oldFromText);
                prevToTextRef.current = oldFromText;
                setRefreshKey((k) => k + 1);
                setExpandedKey(null);
              }}
              title="Swap start and destination"
              aria-label="Swap start and destination"
              style={{
                width: 36, height: 36, borderRadius: 6,
                border: "1px solid #bbb", background: "#fff", color: "#546e7a",
                cursor: "pointer", fontSize: 16, lineHeight: 1,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontFamily: "inherit", flexShrink: 0,
              }}
            >
              ⇅
            </button>
          )}
        </div>
      ) : (
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#78909c", letterSpacing: 1, textTransform: "uppercase", width: 34, flexShrink: 0 }}>From</span>
          <input ref={fromInputRef}
                 inputMode="search"
                 enterKeyHint="search"
                 value={fromText}
                 onChange={(e) => {
                   setFromText(e.target.value);
                   // Typing invalidates any prior coord (locked pick or
                   // "current location" snap) until a new suggestion lands.
                   if (e.target.value) setFromLL(null);
                 }}
                 onKeyDown={(e) => {
                   if (e.key === "ArrowDown" && fromSugg.length > 0) {
                     e.preventDefault();
                     setFromActive((i) => (i + 1) % fromSugg.length);
                     return;
                   }
                   if (e.key === "ArrowUp" && fromSugg.length > 0) {
                     e.preventDefault();
                     setFromActive((i) => (i <= 0 ? fromSugg.length - 1 : i - 1));
                     return;
                   }
                   if (e.key === "Escape" && fromSugg.length > 0) {
                     e.preventDefault();
                     setFromSugg([]);
                     return;
                   }
                   if (e.key !== "Enter") return;
                   if (fromTimerRef.current) { clearTimeout(fromTimerRef.current); fromTimerRef.current = null; }
                   if (fromSugg.length > 0) {
                     pickFrom(fromSugg[fromActive >= 0 ? fromActive : 0]);
                   } else {
                     geocode(fromText, "from");
                   }
                   // Drop the iOS keyboard on Enter so the results are
                   // visible immediately — pickFrom handles its own
                   // blur when suggestions are ready, but if we only
                   // kicked off a geocode the input still has focus.
                   (e.target as HTMLInputElement).blur();
                 }}
                 role="combobox"
                 aria-expanded={fromSugg.length > 0}
                 aria-autocomplete="list"
                 aria-controls="from-suggestions"
                 aria-activedescendant={
                   fromActive >= 0 ? `from-sugg-${fromActive}` : undefined
                 }
                 onBlur={() => {
                   // Bail-out path: if they opened edit mode and
                   // blurred without picking, restore the previous
                   // pill text (and coord state) rather than leaving
                   // a half-edited field. The 180 ms delay lets a
                   // suggestion click land first.
                   setTimeout(() => {
                     if (!fromText && prevFromTextRef.current) {
                       setFromText(prevFromTextRef.current);
                       setFromExpanded(false);
                       setFromSugg([]);
                     } else if (!fromText) {
                       // No prior pick to restore — snap to "Current
                       // location" so the trip keeps working off GPS.
                       setFromLL(userLatLon);
                       setFromExpanded(false);
                       setFromSugg([]);
                     }
                   }, 180);
                 }}
                 placeholder="📍 Current location"
                 style={inputStyle} />
        </div>
        {fromSugg.length > 0 && (
          <div
            id="from-suggestions"
            role="listbox"
            style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginTop: 4, background: "#fff", marginLeft: 32 }}
          >
            {fromSugg.map((g, i) => (
              <div
                key={`${g.lat},${g.lon},${g.display_name}`}
                id={`from-sugg-${i}`}
                role="option"
                aria-selected={i === fromActive}
                onMouseEnter={() => setFromActive(i)}
                onClick={() => pickFrom(g)}
                style={{
                  padding: "12px 14px",
                  fontSize: 15,
                  cursor: "pointer",
                  minHeight: 48,
                  display: "flex",
                  alignItems: "center",
                  background: i === fromActive ? "#eef4ff" : "transparent",
                  borderBottom: i === fromSugg.length - 1 ? "none" : "1px solid #f0ede8",
                  gap: 8,
                }}
              >
                <span style={{ flexShrink: 0 }}>{suggIcon(g)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{suggLabel(g)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* To — the raw input while the rider is searching (no "To"
          label, just the placeholder as the whole prompt). Once a
          destination is locked AND the rider isn't actively editing,
          collapse to a pill that mirrors the From styling so both
          endpoints read as a consistent pair. */}
      {toLL && !toExpanded ? (
        // Entire pill is a tap target for "start editing this
        // destination". Clearing the text happens on tap so the rider
        // can type fresh — same interaction pattern as Google Maps'
        // destination field.
        <div
          onClick={() => {
            // Cache the current text so we can restore it if the
            // rider bails out without picking a new destination.
            prevToTextRef.current = toText;
            setToText("");
            setToSugg([]);
            setToExpanded(true);
            setTimeout(() => toInputRef.current?.focus(), 0);
          }}
          role="button"
          tabIndex={0}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            marginBottom: 8, padding: "8px 12px",
            border: "1px solid #e0ddd8", borderRadius: 8, background: "#fafaf8",
            minHeight: 44, fontSize: 14, color: "#546e7a",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 11, color: "#78909c", letterSpacing: 1, textTransform: "uppercase" }}>To</span>
          <span style={{
            flex: 1, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: "#C62828", fontWeight: 600,
          }}>
            🏁 {toText}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); handleSaveTrip(); }}
            title={alreadySaved ? "Remove from saved" : "Save this destination"}
            aria-label={alreadySaved ? "Remove from saved" : "Save this destination"}
            style={{
              minHeight: 44, padding: "6px 14px", fontSize: 15,
              borderRadius: 6,
              border: "1px solid " + (alreadySaved ? "#c5e1a5" : "#bbb"),
              background: alreadySaved ? "#f1f8e9" : "#fff",
              color: alreadySaved ? "#2E7D32" : "#546e7a",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {alreadySaved ? "★" : "☆"}
          </button>
        </div>
      ) : (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* "To" label only once a destination has been locked — until
              then the placeholder alone is the prompt. */}
          {toLL && (
            <span style={{ fontSize: 11, color: "#78909c", letterSpacing: 1, textTransform: "uppercase", width: 34, flexShrink: 0 }}>To</span>
          )}
          <input ref={toInputRef}
                 inputMode="search"
                 enterKeyHint="search"
                 value={toText} onChange={(e) => { setToText(e.target.value); setToLL(null); }}
                 onKeyDown={(e) => {
                   if (e.key === "ArrowDown" && toSugg.length > 0) {
                     e.preventDefault();
                     setToActive((i) => (i + 1) % toSugg.length);
                     return;
                   }
                   if (e.key === "ArrowUp" && toSugg.length > 0) {
                     e.preventDefault();
                     setToActive((i) => (i <= 0 ? toSugg.length - 1 : i - 1));
                     return;
                   }
                   if (e.key === "Escape" && toSugg.length > 0) {
                     e.preventDefault();
                     setToSugg([]);
                     return;
                   }
                   if (e.key !== "Enter") return;
                   if (toTimerRef.current) { clearTimeout(toTimerRef.current); toTimerRef.current = null; }
                   if (toSugg.length > 0) {
                     pickTo(toSugg[toActive >= 0 ? toActive : 0]);
                   } else if (toLL) {
                     setRefreshKey((k) => k + 1); // already locked — re-plan
                   } else {
                     geocode(toText, "to");
                   }
                   // Dismiss iOS keyboard on Enter — pickTo handles
                   // this itself when a pick lands, but the geocode-
                   // kickoff branch and the re-plan branch also leave
                   // the input focused otherwise.
                   (e.target as HTMLInputElement).blur();
                 }}
                 role="combobox"
                 aria-expanded={toSugg.length > 0}
                 aria-autocomplete="list"
                 aria-controls="to-suggestions"
                 aria-activedescendant={
                   toActive >= 0 ? `to-sugg-${toActive}` : undefined
                 }
                 onBlur={() => {
                   // If the rider opened edit mode on a locked
                   // destination, then blurred out without picking a
                   // new one, treat it as "never mind" and restore
                   // the previous pill rather than leaving them in a
                   // half-edited state. The 180 ms delay lets an
                   // in-progress suggestion click register first.
                   setTimeout(() => {
                     if (toLL && !toText && prevToTextRef.current) {
                       setToText(prevToTextRef.current);
                       setToExpanded(false);
                       setToSugg([]);
                     }
                   }, 180);
                 }}
                 placeholder="Where do you want to go?" style={inputStyle} />
          {toLL && !toExpanded && (
            <button
              onClick={handleSaveTrip}
              title={alreadySaved ? "Remove from saved" : "Save this destination"}
              aria-label={alreadySaved ? "Remove from saved" : "Save this destination"}
              style={{
                ...btnStyle,
                padding: "6px 8px",
                cursor: "pointer",
                border: "1px solid " + (alreadySaved ? "#c5e1a5" : "#bbb"),
                background: alreadySaved ? "#f1f8e9" : "#fff",
                color: alreadySaved ? "#2E7D32" : "#546e7a",
              }}
            >
              {alreadySaved ? "★" : "☆"}
            </button>
          )}
        </div>
        {toSugg.length > 0 && (
          <div
            id="to-suggestions"
            role="listbox"
            style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginTop: 4, background: "#fff", marginLeft: 32 }}
          >
            {toSugg.map((g, i) => (
              <div
                key={`${g.lat},${g.lon},${g.display_name}`}
                id={`to-sugg-${i}`}
                role="option"
                aria-selected={i === toActive}
                onMouseEnter={() => setToActive(i)}
                onClick={() => pickTo(g)}
                style={{
                  padding: "12px 14px",
                  fontSize: 15,
                  cursor: "pointer",
                  minHeight: 48,
                  display: "flex",
                  alignItems: "center",
                  background: i === toActive ? "#eef4ff" : "transparent",
                  borderBottom: i === toSugg.length - 1 ? "none" : "1px solid #f0ede8",
                  gap: 8,
                }}
              >
                <span style={{ flexShrink: 0 }}>{suggIcon(g)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{suggLabel(g)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
      {locateError && (
        <div style={{ fontSize: 10, color: "#C62828", marginBottom: 6, marginLeft: 32 }}>
          📍 {locateError}
        </div>
      )}

      {/* "When" is hidden until a destination is locked — same
          treatment as Google Maps, where the depart/arrive picker only
          appears after you've set where you're going. Default is
          "Now" (tripTime = ""), so leaving this hidden changes
          nothing functionally. */}
      {toLL && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "#78909c", textTransform: "uppercase", letterSpacing: 1 }}>When</span>
          {tripTime ? (
            <>
              <input
                type="datetime-local"
                value={tripTime}
                onChange={(e) => setTripTime(e.target.value)}
                style={{
                  fontSize: 14, padding: "8px 10px", borderRadius: 6,
                  border: "1px solid #cfd8dc", background: "#fff",
                  fontFamily: "inherit", color: "#263238", flex: 1, minWidth: 0,
                  minHeight: 40,
                }}
              />
              <button onClick={() => setTripTime("")} style={{
                fontSize: 14, padding: "8px 14px", border: "1px solid #bbb",
                background: "#fff", color: "#546e7a", borderRadius: 6,
                fontFamily: "inherit", cursor: "pointer", minHeight: 40,
              }}>Now</button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 15, color: "#263238", fontWeight: 600, flex: 1 }}>Now</span>
              <button onClick={() => {
                // Pre-fill with current local time so the picker opens on a
                // sensible starting point; user can bump it forward.
                const d = new Date();
                const pad = (n: number) => String(n).padStart(2, "0");
                setTripTime(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
              }} style={{
                fontSize: 14, padding: "8px 14px", border: "1px solid #bbb",
                background: "#fff", color: "#546e7a", borderRadius: 6,
                fontFamily: "inherit", cursor: "pointer", minHeight: 40,
              }}>Plan for later…</button>
            </>
          )}
        </div>
      )}
      {isFuture && targetDate && (
        <div style={{ fontSize: 13, color: "#1976D2", marginBottom: 10, padding: "0 2px" }}>
          Planning for {targetDate.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {" · routes filtered by published hours, wait = ½ typical headway"}
        </div>
      )}

      {error && <div style={{ fontSize: 13, color: "#C62828", marginBottom: 8 }}>{error}</div>}

      {/* Loading indicator: shown whenever a geocode is in flight (user
          typed + is resolving to a coordinate) or a "From" lookup is
          pending. planTrip itself is synchronous, so the only async
          waits that actually block results come from the geocoder. */}
      {(searching !== null || awaitingLocation) && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex", alignItems: "center", gap: 10,
            fontSize: 14, color: "#546e7a",
            padding: "12px 14px", marginBottom: 8,
            background: "#f5f7fa", border: "1px solid #e0ddd8",
            borderRadius: 8,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 16, height: 16, borderRadius: "50%",
              border: "2px solid #cfd8dc", borderTopColor: "#1976D2",
              animation: "shuttle-spin 0.8s linear infinite",
              flexShrink: 0,
            }}
          />
          <style>{`@keyframes shuttle-spin { to { transform: rotate(360deg); } }`}</style>
          <span>
            {awaitingLocation
              ? "Getting your location…"
              : searching === "from"
                ? "Looking up starting point…"
                : "Finding places…"}
          </span>
        </div>
      )}

      {/* Results */}
      {options && options.length === 0 && (
        <div style={{ fontSize: 14, color: "#9e9e9e", padding: "24px 8px", textAlign: "center" }}>
          No trip options found between these locations.
          <div style={{ fontSize: 13, color: "#bdbdbd", marginTop: 8 }}>
            Shuttles may not be running right now, or this route may not connect these stops. Try refreshing, adjusting your stops, or check back during service hours.
          </div>
        </div>
      )}
      {/* Fallback when planTrip only surfaced Walk (or nothing at all):
          list routes that GEOGRAPHICALLY serve this trip with their next
          active window. Helps the rider see that the shuttle does go
          there, just not right now. Triggers on options=[] too because
          directWalkSec>1hr suppresses the walk entry, leaving riders
          with no context when a route is simply off-schedule. */}
      {options && (options.length === 0 || (options.length === 1 && options[0].mode === "walk")) && potentialRoutes.length > 0 && (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 11, color: "#78909c", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, padding: "0 2px" }}>
            Shuttles that go there — not running now
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {potentialRoutes.map((p) => {
              const nextStr = p.nextActive
                ? p.nextActive.toLocaleString([], {
                    weekday: "short", month: "short", day: "numeric",
                    hour: "numeric", minute: "2-digit",
                  })
                : null;
              return (
                <div key={p.label} style={{
                  padding: "10px 12px", background: "#fff", borderRadius: 10,
                  border: "1px solid #e0ddd8",
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: p.color }}>
                    {p.label}
                  </span>
                  <span style={{ fontSize: 12, color: "#546e7a", marginLeft: "auto", textAlign: "right" }}>
                    {p.schedule && (
                      <div>Runs {p.schedule}</div>
                    )}
                    {nextStr && (
                      <div style={{ fontWeight: 600, color: "#263238", marginTop: 2 }}>
                        Next: {nextStr}
                      </div>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      </div>
      {/* Go mode (the guided "walk → wait → ride" dashboard) was retired
          2026-07-17 on user feedback ("way too complicated — just show the
          route list"). Its plumbing (goTrip state, GoMiniMap, stage nudges)
          is dormant: entry points were removed, goTrip is never set. */}
      {options && options.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {/* Details page leads with the way back — the search rows are
              hidden while a route is open, so this is the page header. */}
          {detailOpen && (
            <button
              onClick={() => setExpandedKey(null)}
              title="Back to all routes"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 15, fontWeight: 600, color: "#1a73e8",
                background: "transparent", border: "none", padding: "0 2px 8px",
                minHeight: 44, cursor: "pointer", fontFamily: "inherit",
              }}
            >← All routes</button>
          )}
          {/* Combined overview: all shuttle options on one map so the
              rider can compare routes geographically, Google-Maps-app
              style — map first, cards below. Open by default (see
              overviewExpanded init). Built from the same segCoords +
              busMatch we compute per option below. Skipped in Go mode —
              comparing routes is over. */}
          {!goActive && effectiveFromLL && toLL && (() => {
            const normBus = (s: string) => s.replace(/^#/, "");
            const overviewOpts: OverviewOption[] = [];
            // Mirror the visible option list (same sort + slice, same
            // "Show N more routes" toggle) so the map overlays only the routes
            // currently shown to the rider, and grows when they reveal more.
            const _sortedForMap = orderedOptions ?? [];
            const _visibleForMap = showAllOptions ? _sortedForMap : _sortedForMap.slice(0, 3);
            // Route-details view open: the map narrows to just that route,
            // like Google Maps' directions-detail screen.
            const _mapOpts = expandedKey
              ? _visibleForMap.filter((o) => o.routeLabel === expandedKey)
              : _visibleForMap;
            for (const o of _mapOpts) {
              if (o.mode !== "shuttle") continue;
              const cfg = ROUTE_LISTS.find((c) => c.label === o.routeLabel);
              if (!cfg) continue;
              const allStops: number[] = [];
              const seen = new Set<number>();
              for (const rid of cfg.routeIds) {
                for (const sid of (routeStops[rid] ?? [])) {
                  if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
                }
              }
              const bi = allStops.indexOf(o.boardStopId);
              const ai = allStops.indexOf(o.alightStopId);
              if (bi === -1 || ai === -1) continue;
              const segStops = bi <= ai
                ? allStops.slice(bi, ai + 1)
                : [...allStops.slice(bi), ...allStops.slice(0, ai + 1)];
              const segCoords = segStops
                .map((sid) => stopCoords[sid])
                .filter((c): c is LatLon => !!c);
              if (segCoords.length < 2) continue;
              const busMatch = buses.find((b) =>
                isBusOnRoute(b, allStops, stopCoords) &&
                normBus(b.bus_name) === normBus(o.busName) &&
                cfg.busRouteIds.includes(b.route_id)
              );
              const passedMatch = o.missedBus
                ? buses.find((b) =>
                    isBusOnRoute(b, allStops, stopCoords) &&
                    normBus(b.bus_name) === normBus(o.missedBus!) &&
                    cfg.busRouteIds.includes(b.route_id)
                  )
                : undefined;
              // Single-route detail view: dashed approach from the bus's
              // current anchor to the pickup stop.
              let approach: [number, number][] | undefined;
              if (expandedKey === o.routeLabel && busMatch) {
                const busIdx = findRouteAnchor(busMatch, allStops, stopCoords);
                if (busIdx >= 0 && busIdx !== bi) {
                  const upstream = busIdx <= bi
                    ? allStops.slice(busIdx, bi + 1)
                    : [...allStops.slice(busIdx), ...allStops.slice(0, bi + 1)];
                  const upCoords = upstream
                    .map((sid) => stopCoords[sid])
                    .filter((c): c is LatLon => !!c);
                  if (upCoords.length >= 2) {
                    approach = buildStopSequencePolyline(routePaths?.[cfg.routeIds[0]], upCoords)
                      ?? upCoords.map((c) => [c.lat, c.lon] as [number, number]);
                  }
                }
              }
              const road = buildStopSequencePolyline(routePaths?.[cfg.routeIds[0]], segCoords);
              overviewOpts.push({
                label: o.routeLabel,
                color: o.color,
                segCoords,
                road,
                approach,
                bus: busMatch ? { lat: busMatch.lat, lon: busMatch.lon, name: normBus(busMatch.bus_name) } : null,
                passedBus: passedMatch ? { lat: passedMatch.lat, lon: passedMatch.lon, name: normBus(passedMatch.bus_name) } : null,
                // Bus reaches the board stop after (walk + wait) — waitSec is
                // derived as bus-ETA minus walk, so the sum is the bus's own
                // arrival. Rider steps off at total minus the trailing walk.
                boardEta: o.departed ? null : fmtMin(o.walkToSec + o.waitSec),
                arriveAt: o.departed ? null : fmtClock(o.totalSec - o.walkFromSec, isFuture ? targetDate! : undefined),
              });
            }
            if (overviewOpts.length < 1) return null;
            // "All N routes" was a lie whenever options sat behind "Show N
            // more routes" (map-bot report #28: header said ALL 2 ROUTES over
            // a 5-option list). Only claim "all" when the list really is.
            const _totalShuttle = _sortedForMap.filter((o) => o.mode === "shuttle").length;
            const _overviewLabel = expandedKey
              ? `${expandedKey} route`
              : overviewOpts.length < _totalShuttle
                ? `Overview — top ${overviewOpts.length} of ${_totalShuttle} routes`
                : `Overview — all ${overviewOpts.length} route${overviewOpts.length === 1 ? "" : "s"}`;
            return (
              <div style={{
                marginBottom: 12,
                padding: 8,
                background: "#fff",
                borderRadius: 10,
                border: "1px solid #e0ddd8",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}>
                <button
                  onClick={() => setOverviewExpanded((v) => !v)}
                  style={{
                    width: "100%",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: "transparent", border: "none",
                    padding: "4px 4px", cursor: "pointer", fontFamily: "inherit",
                  }}
                  title={overviewExpanded ? "Collapse overview" : "Expand overview"}
                >
                  <span style={{
                    fontSize: 10, color: "#78909c",
                    textTransform: "uppercase", letterSpacing: 1,
                  }}>
                    {_overviewLabel}
                  </span>
                  <span style={{ fontSize: 12, color: "#90a4ae" }}>
                    {overviewExpanded ? "▴" : "▾"}
                  </span>
                </button>
                {overviewExpanded && (
                  <CombinedTripMap
                    // Live GPS when From is "current location" — the origin
                    // frozen at search time left the you-pin stranded while
                    // the rider walked (report #19).
                    from={fromIsCurrent && userLatLon ? userLatLon : effectiveFromLL}
                    to={toLL}
                    options={overviewOpts}
                  />
                )}
              </div>
            );
          })()}
          {options.length === 1 && options[0].mode === "walk" && (
            <div style={{ fontSize: 13, color: "#78909c", padding: "0 4px 8px" }}>
              Walking beats every shuttle here — no bus nearby saves time.
            </div>
          )}
          {(() => {
            // A shuttle is "slower than walking" only when the time spent
            // actually COMMUTING (walk to stop + ride + walk from stop)
            // exceeds the direct walk — not when the arrival time does.
            // Waiting isn't commuting: the rider can spend the wait at
            // their desk and leave at the leave-by time, so a late arrival
            // caused purely by wait shouldn't demote/tag the route.
            // Still shown either way (riders want to see every route);
            // only judged when walking is a real alternative — the walk
            // card itself is suppressed >60 min.
            // Fastest-first with hysteresis — see orderedOptions above.
            const _tier = optionTier;
            const _sorted = orderedOptions ?? [];
            // Go mode: the committed option's card is pinned to the top;
            // the other routes stay listed (collapsed) below it so the
            // rider can still compare or switch without ending the trip.
            const _isGoCard = (o: TripOption) =>
              goActive && o.mode === "shuttle" && o.routeLabel === goTrip!.routeLabel;
            const _visible = goActive
              ? [..._sorted.filter(_isGoCard), ..._sorted.filter((o) => !_isGoCard(o))]
              : showAllOptions ? _sorted : _sorted.slice(0, 3);
            const _hidden = goActive ? 0 : _sorted.length - _visible.length;
            // Google-Maps pattern: options are divider-separated ROWS of one
            // sheet; tapping a row swaps the list for that route's details
            // view (← All routes restores the list).
            const _detailOpen = _visible.some((v) => v.routeLabel === expandedKey);
            // Reassure rather than confuse: when every shuttle option got
            // demoted below walking, say so up front — otherwise the grey
            // tags read like the app is broken.
            const _allShuttlesSlower = !goActive &&
              _sorted.some((o) => o.mode === "shuttle") &&
              _sorted.every((o) => o.mode === "walk" || _tier(o) > 0);
            return <>
          {_allShuttlesSlower && !_detailOpen && (
            <div style={{ fontSize: 13, color: "#78909c", padding: "0 4px 8px" }}>
              Walking wins right now — every shuttle is slower, but the routes are listed in case you'd rather ride.
            </div>
          )}
          <div style={{
            background: "#fff", borderRadius: 12, marginBottom: 8,
            border: "1px solid #e8eaed", boxShadow: "0 1px 2px rgba(60,64,67,0.08)",
            overflow: "hidden",
          }}>
          {_visible.map((o, i) => {
            // Details mode: only the tapped route renders; the other rows
            // hide until the rider taps ← back.
            if (_detailOpen && o.routeLabel !== expandedKey) return null;
            // Stable identity for expansion state — one option per route,
            // so the label alone is unique ("Walk" for the walk option).
            const oKey = o.routeLabel;
            const isExpanded = expandedKey === oKey;
            const showMore = detailsKey === oKey;
            // Shared shuttle context: bus pinned to this option + how
            // many stops before the pickup it is right now. Computed
            // once so both the collapsed one-liner and the expanded
            // route breakdown read the same values. Mirrors the anchor-
            // advance logic in computeUpcomingArrivals so the count
            // doesn't disagree with the bus pin on the mini-map.
            const shuttleCtx = (() => {
              if (o.mode !== "shuttle") return null;
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
              if (bi === -1) return null;
              const normBus = (s: string) => s.replace(/^#/, "");
              // Include the on-route check so a depot-parked ghost
              // (e.g., Red #122 in Hamden) doesn't pin to an option.
              const busMatch = buses.find((b) =>
                normBus(b.bus_name) === normBus(o.busName) &&
                cfg.busRouteIds.includes(b.route_id) &&
                isBusOnRoute(b, allStops, stopCoords),
              ) ?? null;
              let stopsAway: number | null = null;
              if (busMatch) {
                const busIdx = findRouteAnchor(busMatch, allStops, stopCoords);
                if (busIdx >= 0) {
                  stopsAway = (bi - busIdx + allStops.length) % allStops.length;
                }
              }
              return { busMatch, stopsAway, normBus };
            })();
            return (
              // Keyed by IDENTITY (route label), not list position — the
              // list reorders live (Go pin, departed sink) and an index
              // key would remount every card's map/tracker on reorder.
              <div key={oKey} style={{
                padding: "12px 16px",
                borderBottom: !isExpanded && i < _visible.length - 1 ? "1px solid #f1f3f4" : "none",
                cursor: isExpanded ? "default" : "pointer",
                opacity: o.departed ? 0.7 : 1,
              }}
              onClick={isExpanded ? undefined : () => setExpandedKey(oKey)}>
                {/* The back control lives at the TOP of the details page
                    (above the map) — see the detailOpen bar. */}
                {/* Line 1: leave–arrival range (left) + duration (right),
                    Google-transit style. Range starts at "leave now" (offset
                    0) so it always spans exactly the shown duration — a
                    board-time start read as a 3-min trip next to "27 min". */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  {/* Duration leads (left), arrival trails (right) — swapped
                      2026-07-17 on user request. */}
                  {o.departed ? (
                    <span style={{ fontSize: 16, fontWeight: 600, color: "#5f6368" }}>Departed</span>
                  ) : (
                    <span style={{ fontSize: 16, fontWeight: 600, color: "#202124", whiteSpace: "nowrap" }}>
                      {fmtMin(o.totalSec)}
                    </span>
                  )}
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {!o.departed && (
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#202124" }}>
                        {/* Live mode: arrival only — the start is always "now"
                            (user feedback 2026-07-17). Future mode keeps the
                            range, since the start is the chosen departure. */}
                        {isFuture
                          ? `${fmtClock(0, targetDate!)} – ${fmtClock(o.totalSec, targetDate!)}`
                          : `arrive ${fmtClock(o.totalSec)}`}
                      </span>
                    )}
                    {/* Rows navigate (Google-style ›); the details view
                        exits via ← All routes instead. */}
                    {!isExpanded && <span style={{ fontSize: 16, color: "#9aa0a6" }}>›</span>}
                  </span>
                </div>
                {/* Only one badge survives: YOUR TRIP (marks the committed
                    Go option). FASTEST is implied by sort order — the top
                    card is the recommendation, Google-style — and
                    slower-than-walking is already communicated by the tier
                    sort + the "walking wins" banner. */}
                {_isGoCard(o) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: "#1a73e8",
                      background: "#e8f0fe", padding: "2px 8px", borderRadius: 10,
                    }}>YOUR TRIP</span>
                  </div>
                )}
                {/* Line 2: leg chips — walk / route pill / walk, Google
                    transit-style, omitting a walk leg when it's 0 sec.
                    Collapsed rows ONLY: the details view's step list
                    carries the same durations + route pill, so chips
                    there were pure repetition (user feedback 2026-07-17). */}
                {!isExpanded && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6, marginBottom: 8 }}>
                  {o.mode === "walk" ? (
                    <span style={{
                      fontSize: 13, fontWeight: 600, color: "#5f6368",
                      background: "transparent", border: "1px solid #dadce0",
                      borderRadius: 6, padding: "2px 8px",
                    }}>🚶 Walk</span>
                  ) : (
                    <>
                      {o.walkToSec > 0 && (
                        <>
                          <span style={{ fontSize: 13, color: "#5f6368" }}>🚶 {fmtWalk(o.walkToSec)}</span>
                          <span style={{ fontSize: 13, color: "#9aa0a6" }}>›</span>
                        </>
                      )}
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: "#fff", background: o.color,
                        borderRadius: 6, padding: "2px 8px",
                      }}>{o.routeLabel}</span>
                      {o.walkFromSec > 0 && (
                        <>
                          <span style={{ fontSize: 13, color: "#9aa0a6" }}>›</span>
                          <span style={{ fontSize: 13, color: "#5f6368" }}>🚶 {fmtWalk(o.walkFromSec)}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
                )}
                {/* Collapsed preview: a single summary line. For shuttle
                    options it's "#bus · N stops before yours · arrives
                    in Ym (HH:MM)"; the detailed walk/wait/ride breakdown
                    is deferred to the expanded view so the card stays
                    scannable when the user just wants to pick one. */}
                {o.mode === "shuttle" && shuttleCtx?.busMatch && shuttleCtx.stopsAway !== null && (() => {
                  const { busMatch, stopsAway, normBus } = shuttleCtx;
                  const busEta = o.walkToSec + o.waitSec;
                  // The bus AFTER the pinned one (user request 2026-07-17) —
                  // lets riders judge "can I skip this one?" at a glance.
                  // Strictly later than the pinned arrival so an earlier,
                  // uncatchable bus never masquerades as "next"; the same
                  // vehicle a loop later counts.
                  const nextArr = !o.departed
                    ? (computeUpcomingArrivals(
                        [o.boardStopId], buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus,
                      )
                        .filter((a) => a.routeLabel === o.routeLabel && a.eta > busEta + 30)
                        .sort((a, b) => a.eta - b.eta)[0] ?? null)
                    : null;
                  // The stops-away/dwell/accuracy/bias readouts that used
                  // to be derived here were cut with their UI (2026-07-13
                  // "redundant route info") — the status line + step list
                  // is the whole story now. The calibration data still
                  // feeds the ETAs themselves.
                  return (
                    <>
                      {o.missedBus && !o.departed && (
                        <div style={{ fontSize: 13, color: "#C62828", fontWeight: 600, lineHeight: 1.4, marginBottom: 2 }}>
                          {/* Covers both "already passed" and "will reach the
                              stop before you can" — the switch away from a
                              still-approaching bus read as a glitch when the
                              text claimed it had passed (user 2026-07-17). */}
                          🚌 You can't catch #{o.missedBus} — showing the next bus:
                        </div>
                      )}
                      {/* Collapsed = at most one live-status line (missed-bus
                          warning takes precedence). Expanded: the step list
                          below carries bus number + wait, so the plain
                          "in N min" line would repeat it — only the departed
                          warning still shows there. */}
                      {/* No bus numbers here (user 2026-07-17) — the ride
                          pill in the details view carries the number for
                          matching against the physical bus. */}
                      {(o.departed || (!isExpanded && !o.missedBus)) && (
                      <div style={{ fontSize: 13, color: "#5f6368", fontWeight: 500, lineHeight: 1.4 }}>
                        {o.departed
                          ? (shuttleCtx.stopsAway === 0
                              ? "🚌 The bus is at your stop — you won't arrive in time, check for the next shuttle"
                              : "🚌 The bus will reach your stop before you arrive — check for the next shuttle")
                          : `🚌 in ${fmtMin(busEta)}`}
                        {!o.departed && nextArr && (
                          <span style={{ color: "#9aa0a6" }}>
                            {` · next in ${fmtMin(nextArr.eta)}`}
                          </span>
                        )}
                      </div>
                      )}
                      {o.departed && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRefreshKey((k) => k + 1);
                              setRefreshed(true);
                              setTimeout(() => setRefreshed(false), 1500);
                              if (!fromLL && !fromText) onRequestLocate();
                            }}
                            style={{
                              fontSize: 12, fontWeight: 600, padding: "4px 12px",
                              borderRadius: 5, border: "1px solid #1a73e8",
                              background: "#1a73e8", color: "#fff",
                              cursor: "pointer", fontFamily: "inherit",
                            }}
                          >
                            Find next bus
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
                {/* No bus pin yet — the option was planned off the
                    schedule (future mode, or no live bus on that route
                    right now). Fall back to the plain wait summary so
                    the card isn't blank. Collapsed only — the expanded
                    step list has its own wait line. */}
                {!isExpanded && o.mode === "shuttle" && (!shuttleCtx?.busMatch || shuttleCtx.stopsAway === null) && (
                  <div style={{ fontSize: 13, color: "#5f6368", fontWeight: 500, lineHeight: 1.4 }}>
                    ⏳ wait {fmtWait(o.waitSec)} for {o.busName ? `#${o.busName}` : "next shuttle"}
                  </div>
                )}
                {isExpanded && o.mode === "shuttle" && (() => {
                  const boardCoord = stopCoords[o.boardStopId];
                  const navHref = boardCoord
                    ? `https://www.google.com/maps/dir/?api=1&destination=${boardCoord.lat},${boardCoord.lon}&travelmode=walking`
                    : null;
                  const boardName = (stopNames[o.boardStopId] ?? "").replace(/\s*\/\s*/g, "/");
                  return (
                    <div style={{
                      fontSize: 14, color: "#5f6368", lineHeight: 1.6,
                      marginTop: 10, paddingTop: 10,
                      borderTop: "1px solid #dadce0",
                    }} onClick={(e) => e.stopPropagation()}>
                      {/* THE single description of the trip — one chip line,
                          walk › wait › ride › walk (user feedback 2026-07-17:
                          "could be one line"). The colored pill carries the
                          RIDE TIME + bus number, not the route name — the
                          route is named in the map header above, and stop
                          names live in Stops ▾ / the map / Go guidance.
                          The walk chip is duration only — the live meters
                          readout was cut 2026-07-17 ("don't need the
                          distance"); Go mode still shows it. */}
                      {(() => {
                        const busNo = shuttleCtx?.busMatch
                          ? shuttleCtx.normBus(shuttleCtx.busMatch.bus_name)
                          : (o.busName ? o.busName.replace(/^#/, "") : null);
                        const sep = <span style={{ color: "#9aa0a6" }}>›</span>;
                        return (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 13 }}>
                            {o.walkToSec >= 60 && (<>
                              <span style={{ whiteSpace: "nowrap" }}>🚶 {fmtWalk(o.walkToSec)}</span>
                              {sep}
                            </>)}
                            {o.waitSec >= 60 && (<>
                              <span style={{ whiteSpace: "nowrap" }}>⏳ {fmtWait(o.waitSec)}</span>
                              {sep}
                            </>)}
                            <span style={{
                              fontWeight: 600, color: "#fff", background: o.color,
                              borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap",
                            }}>🚌 {busNo ? `#${busNo} · ` : ""}{fmtMin(o.rideSec)}</span>
                            {o.walkFromSec >= 60 && (<>
                              {sep}
                              <span style={{ whiteSpace: "nowrap" }}>🚶 {fmtWalk(o.walkFromSec)}</span>
                            </>)}
                          </div>
                        );
                      })()}
                      {/* The "▶ Go" button (entry to the guided Go mode)
                          was removed 2026-07-17 with the rest of Go mode —
                          "way too complicated". Directions took its place
                          as the card's one prominent action (user request
                          2026-07-17: "make it more obvious"). */}
                      {navHref && (
                        <a
                          href={navHref}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={`Walking directions to ${boardName}`}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            gap: 6, marginTop: 12, minHeight: 44, borderRadius: 8,
                            border: "1.5px solid #1a73e8", color: "#1a73e8",
                            fontWeight: 600, fontSize: 14,
                            textDecoration: "none", fontFamily: "inherit",
                          }}
                        >🧭 Directions to stop</a>
                      )}
                      {/* One flat row of quiet secondary links — the old
                          nested disclosures (More ▾ → Stops ▾ → Route ▾)
                          made riders dig three levels for a stop list. */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        style={{
                          marginTop: 10, paddingTop: 4, borderTop: "1px dashed #dadce0",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          gap: 2, flexWrap: "wrap",
                        }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDetailsKey(showMore ? null : oKey); }}
                          title={showMore ? "Hide stop list" : "Show stop list"}
                          style={{
                            fontSize: 13, fontWeight: 500, padding: "0 8px",
                            minHeight: 44, display: "inline-flex", alignItems: "center",
                            border: "none", background: "transparent",
                            color: "#1a73e8", cursor: "pointer", fontFamily: "inherit",
                          }}
                        >
                          Stops {showMore ? "▴" : "▾"}
                        </button>
                        {/* Manual way into ride tracking. Auto-detect (the
                            "On <route> #N?" offer) is the usual path, but it
                            needs a GPS fix good enough to place the rider
                            within 60 m of the board stop — indoors, in a
                            urban canyon, or with location permission at
                            city-block precision it simply never fires, and
                            without this the ride page is unreachable. */}
                        {o.mode === "shuttle" && (
                          <>
                            <span style={{ color: "#dadce0", fontSize: 13 }}>·</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onBoard({
                                  routeLabel: o.routeLabel, color: o.color,
                                  busName: o.busName,
                                  boardStopId: o.boardStopId, alightStopId: o.alightStopId,
                                  startedAt: Date.now(),
                                  ...(toLL && toText ? { toLat: toLL.lat, toLon: toLL.lon, toText } : {}),
                                });
                              }}
                              title="Track this ride now — use this if the app didn't notice you boarding"
                              style={{
                                fontSize: 13, fontWeight: 500, padding: "0 8px",
                                minHeight: 44, display: "inline-flex", alignItems: "center",
                                border: "none", background: "transparent",
                                color: "#1a73e8", cursor: "pointer", fontFamily: "inherit",
                              }}
                            >
                              🚌 I'm on it
                            </button>
                          </>
                        )}
                        <span style={{ color: "#dadce0", fontSize: 13 }}>·</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); reportOption(o); }}
                          title="Report that this route is wrong or confusing"
                          style={{
                            fontSize: 13, fontWeight: 500, padding: "0 8px",
                            minHeight: 44, display: "inline-flex", alignItems: "center",
                            border: "none", background: "transparent",
                            color: "#1a73e8", cursor: "pointer", fontFamily: "inherit",
                          }}
                        >
                          🚩 Report
                        </button>
                        {reportStatus && (
                          <span style={{ fontSize: 12, color: "#5f6368" }}>
                            {reportStatus}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {isExpanded && o.mode === "walk" && effectiveFromLL && toLL && (
                  <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                    <TripMap from={fromIsCurrent && userLatLon ? userLatLon : effectiveFromLL} to={toLL} color={o.color} />
                  </div>
                )}
                {isExpanded && showMore && o.mode === "shuttle" && (() => {
                  // Stop list, two sections (auto-opens with the details —
                  // user request 2026-07-17): first the APPROACH (the stops
                  // the bus still has to clear to reach the pickup, muted,
                  // with typical hold times and a live "been sitting here"
                  // counter at its current stop), then the board→alight
                  // ride. The 2026-07-16 cockpit cull stands otherwise —
                  // no embedded map/iframe/pace flags/strikethroughs.
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
                  const normBus = (s: string) => s.replace(/^#/, "");
                  const busMatch = buses.find((b) =>
                    normBus(b.bus_name) === normBus(o.busName) &&
                    cfg.busRouteIds.includes(b.route_id) &&
                    isBusOnRoute(b, allStops, stopCoords),
                  );
                  const busAnchorIdx = busMatch ? findRouteAnchor(busMatch, allStops, stopCoords) : -1;
                  const busSegPos = busAnchorIdx >= 0 ? segStops.indexOf(allStops[busAnchorIdx]) : -1;
                  // Approach: bus's current stop → the stop before the
                  // pickup, only while the bus is genuinely upstream.
                  const stopsAway = busAnchorIdx >= 0 ? (bi - busAnchorIdx + allStops.length) % allStops.length : 0;
                  const approachStops = busAnchorIdx >= 0 && stopsAway > 0 && busSegPos === -1
                    ? (busAnchorIdx <= bi
                        ? allStops.slice(busAnchorIdx, bi)
                        : [...allStops.slice(busAnchorIdx), ...allStops.slice(0, bi)])
                    : [];
                  // Dwell readouts: typical hold at a stop (per-bus stats
                  // preferred, route stats fallback) + live elapsed while
                  // the bus is parked at its current stop.
                  const routeDwells = dwellTimes?.[cfg.routeIds[0]] ?? {};
                  const busDwells = busMatch ? (dwellsByBus?.[normBus(busMatch.bus_name)]?.[cfg.routeIds[0]] ?? {}) : {};
                  const typDwell = (sid: number): number | null => {
                    const pb = busDwells[String(sid)];
                    if (pb && pb.n >= 5) return pb.med;
                    const r = routeDwells[String(sid)];
                    if (r && r.n >= 3) return r.med;
                    return null;
                  };
                  const fmtShort = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);
                  const liveElapsedSec = busMatch && busMatch.at_stop_id != null && busMatch.at_stop_since
                    ? Math.max(0, (Date.now() - new Date(busMatch.at_stop_since + "Z").getTime()) / 1000)
                    : null;
                  return (
                    <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                      {approachStops.length > 0 && (
                        <div style={{ position: "relative", paddingLeft: 16, marginBottom: 4 }}>
                          <span style={{
                            position: "absolute", left: 6, top: 6, bottom: 0,
                            borderLeft: `2px dashed ${o.color}`, opacity: 0.4,
                          }} />
                          {approachStops.map((sid, j) => {
                            const isBusHere = j === 0;
                            const name = (stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/");
                            const typ = typDwell(sid);
                            const showLive = isBusHere && busMatch?.at_stop_id === sid && liveElapsedSec != null;
                            return (
                              <div key={sid} style={{
                                position: "relative", display: "flex", alignItems: "center",
                                padding: "2px 0", opacity: isBusHere ? 1 : 0.65,
                              }}>
                                <span style={{
                                  position: "absolute", left: -13, top: "50%",
                                  transform: "translateY(-50%)",
                                  width: 7, height: 7, borderRadius: "50%",
                                  background: "#fff", border: `2px solid ${o.color}`,
                                  boxSizing: "border-box",
                                }} />
                                <span style={{
                                  fontSize: 13,
                                  fontWeight: isBusHere ? 700 : 400,
                                  color: isBusHere ? o.color : "#5f6368",
                                  marginLeft: 10,
                                }}>
                                  {isBusHere && <span style={{ marginRight: 4 }}>🚌</span>}
                                  {name}
                                  {showLive && (
                                    <span style={{ fontSize: 10, fontWeight: 700, color: "#5f6368", marginLeft: 6 }}
                                          title={typ != null ? `Typically holds ~${fmtShort(typ)}` : "Time the bus has been sitting here"}>
                                      ⏸ {fmtShort(liveElapsedSec!)}{typ != null ? ` / ~${fmtShort(typ)}` : ""}
                                    </span>
                                  )}
                                  {!showLive && typ != null && typ >= 180 && (
                                    <span style={{ fontSize: 10, color: "#9aa0a6", marginLeft: 6 }}
                                          title="Typical hold at this stop">
                                      ⏸ ~{fmtShort(typ)}
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ position: "relative", paddingLeft: 16 }}>
                      <span style={{
                        position: "absolute", left: 6, top: 6, bottom: 6,
                        width: 2, background: o.color, opacity: 0.6,
                      }} />
                      {segStops.map((sid, j) => {
                        const isBoard = j === 0;
                        const isAlight = j === segStops.length - 1;
                        const isEnd = isBoard || isAlight;
                        const isBusHere = j === busSegPos;
                        const name = (stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/");
                        return (
                          <div key={sid} style={{
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
                              fontSize: 14,
                              fontWeight: isEnd || isBusHere ? 700 : 400,
                              color: isEnd ? "#202124" : isBusHere ? o.color : "#5f6368",
                              marginLeft: 10,
                            }}>
                              {isBoard && <span style={{ fontSize: 11, fontWeight: 800, color: o.color, letterSpacing: 0.5, marginRight: 6 }}>BOARD</span>}
                              {isAlight && <span style={{ fontSize: 11, fontWeight: 800, color: o.color, letterSpacing: 0.5, marginRight: 6 }}>GET OFF</span>}
                              {isBusHere && <span style={{ marginRight: 4 }}>🚌</span>}
                              {name}
                              {isBusHere && busMatch?.at_stop_id === sid && liveElapsedSec != null && (
                                <span style={{ fontSize: 10, fontWeight: 700, color: "#5f6368", marginLeft: 6 }}
                                      title="Time the bus has been sitting here">
                                  ⏸ {fmtShort(liveElapsedSec)}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
          </div>
            {_hidden > 0 && !_detailOpen && (
              <button
                onClick={() => setShowAllOptions(true)}
                style={{
                  width: "100%", minHeight: 44, padding: "10px 14px", marginBottom: 10,
                  background: "transparent", border: "none",
                  borderRadius: 8, fontSize: 14, fontWeight: 600, color: "#1a73e8",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Show {_hidden} more route{_hidden !== 1 ? "s" : ""}
              </button>
            )}
            </>;})()}
        </div>
      )}

      {/* Trip actions: Clear wipes the destination (returns the page to
          Saved/Recent); Refresh re-runs planTrip against the latest
          live bus positions without changing the destination — useful
          when a bus has pulled up and you want the ETA recomputed.
          Rendered whenever a trip is in progress (options !== null),
          so the same pair appears for both "0 results" and full lists.
          Hidden in Go mode — the banner's End trip is the exit, and the
          live option auto-refreshes with every bus update anyway. */}
      {options && !goActive && (
        <div style={{
          display: "flex", justifyContent: "center", alignItems: "center",
          gap: 4, marginTop: 18, marginBottom: 10,
        }}>
          <button
            onClick={() => {
              toAbortRef.current?.abort();
              if (toTimerRef.current) { clearTimeout(toTimerRef.current); toTimerRef.current = null; }
              setToText("");
              setToLL(null);
              setToSugg([]);
              setExpandedKey(null);
              setError(null);
              setTripTime("");
            }}
            style={{
              minHeight: 44, padding: "0 14px", fontSize: 14, fontWeight: 500,
              border: "none", background: "transparent", color: "#1a73e8",
              cursor: "pointer", fontFamily: "inherit",
              display: "inline-flex", alignItems: "center",
            }}
          >
            Clear
          </button>
          <span style={{ color: "#dadce0", fontSize: 14 }}>·</span>
          <button
            onClick={() => {
              setRefreshKey((k) => k + 1);
              setRefreshed(true);
              setTimeout(() => setRefreshed(false), 1500);
              // Re-request GPS when From is using current location so the
              // trip re-plans from wherever the user actually is now.
              if (!fromLL && !fromText) onRequestLocate();
            }}
            title="Recompute against the latest bus positions"
            style={{
              minHeight: 44, padding: "0 14px", fontSize: 14, fontWeight: 500,
              border: "none", background: "transparent",
              color: refreshed ? "#2e7d32" : "#1a73e8",
              cursor: "pointer", fontFamily: "inherit",
              display: "inline-flex", alignItems: "center",
              transition: "color 0.2s",
            }}
          >
            {refreshed ? "✓ Refreshed" : "↻ Refresh"}
          </button>
        </div>
      )}

      {/* Empty-state orientation: tell a first-time visitor the system is
          alive ("N shuttles running") and give one-tap destinations so the
          first trip doesn't start with a blank search box. The popular
          chips are training wheels — once the rider has their own saved
          or recent destinations, those take the space instead. */}
      {!options && !goActive && (() => {
        const activeRoutes = ROUTE_LISTS.filter((c) => buses.some((b) => c.busRouteIds.includes(b.route_id)));
        const firstTimer = savedTrips.length === 0 && recentTrips.length === 0;
        return (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, color: buses.length > 0 ? "#2E7D32" : "#78909c", padding: "0 2px", fontWeight: 600 }}>
              {buses.length > 0
                ? `🚌 ${buses.length} shuttle${buses.length === 1 ? "" : "s"} running now on ${activeRoutes.length} route${activeRoutes.length === 1 ? "" : "s"}`
                : "😴 No shuttles running right now"}
            </div>
            {firstTimer && buses.length > 0 && (
              <div style={{ fontSize: 12, color: "#78909c", padding: "2px 2px 0" }}>
                Pick a destination — we compare walking against every shuttle.
              </div>
            )}
            {firstTimer && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {POPULAR_DESTS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyDestination({
                      id: `pop-${p.name}`, name: p.name,
                      fromText: "", fromLat: 0, fromLon: 0,
                      toText: p.name, toLat: p.lat, toLon: p.lon,
                    })}
                    style={{
                      fontSize: 13, padding: "8px 14px", minHeight: 36,
                      borderRadius: 999, border: "1px solid #e0ddd8",
                      background: "#fff", color: "#263238",
                      cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {/* Saved + Recent are hidden whenever we have a live trip on
          screen — the destination search is what the user is acting on.
          They come back automatically once the destination is cleared. */}
      {!options && !goActive && savedTrips.length > 0 && (
        <div style={{ marginTop: 20, marginBottom: 8 }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 3, padding: "0 2px",
          }}>
            <span style={{ fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1 }}>Saved destinations</span>
            <button
              onClick={() => {
                setEditingSavedMode((v) => !v);
                setEditingSavedId(null);
              }}
              style={{
                border: "none", background: "transparent",
                color: editingSavedMode ? "#2E7D32" : "#90a4ae",
                fontSize: 12, fontWeight: editingSavedMode ? 700 : 400,
                cursor: "pointer", padding: "0 4px", lineHeight: 1,
              }}
              title={editingSavedMode ? "Done editing" : "Rename or delete"}
            >{editingSavedMode ? "Done" : "✎"}</button>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 4,
            maxHeight: 180, overflowY: "auto",
          }}>
            {savedTrips.map((t) => {
              const editing = editingSavedMode;
              if (editing) {
                // Edit mode stretches to a full row so the input is
                // comfortable AND the ✕ delete button lives far from the
                // regular tap target to avoid accidental removal.
                return (
                  <div key={t.id} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 8px", borderRadius: 8,
                    background: "#f1f8e9", border: "1px solid #c5e1a5",
                    gridColumn: "1 / -1",
                  }} onClick={(e) => e.stopPropagation()}>
                    <span style={{ color: "#2E7D32", fontSize: 11 }}>★</span>
                    <input
                      defaultValue={t.toText}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim();
                        if (v && v !== t.toText) onRenameSaved(t.id, v);
                        setEditingSavedId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditingSavedId(null);
                      }}
                      style={{
                        flex: 1, minWidth: 0, fontSize: 12, padding: "2px 6px",
                        border: "1px solid #cfd8dc", background: "#fff",
                        borderRadius: 4,
                        fontFamily: "inherit", color: "#263238", outline: "none",
                      }}
                    />
                    <button
                      onMouseDown={(e) => {
                        // Fire before input's onBlur so we don't commit a
                        // half-edited name when the user is really just
                        // removing the entry.
                        e.preventDefault(); e.stopPropagation();
                        setEditingSavedId(null);
                        onDeleteSaved(t.id);
                      }}
                      style={{
                        fontSize: 11, padding: "3px 8px",
                        border: "1px solid #C62828", background: "#fff",
                        color: "#C62828", borderRadius: 4,
                        fontFamily: "inherit", cursor: "pointer",
                      }}
                      title="Delete this saved destination"
                    >✕ delete</button>
                  </div>
                );
              }
              return (
                <div
                  key={t.id}
                  onClick={() => applyDestination(t)}
                  title="Tap to plan"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 10px", borderRadius: 999,
                    background: "#fff",
                    border: "1px solid #c5e1a5",
                    fontSize: 11, color: "#263238", cursor: "pointer",
                    maxWidth: "100%",
                  }}
                >
                  <span style={{ color: "#2E7D32", fontSize: 10 }}>★</span>
                  <span style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: "#C62828", fontWeight: 600,
                  }}>{t.toText}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!options && !goActive && recentTrips.length > 0 && (
        <div style={{ marginTop: savedTrips.length > 0 ? 8 : 20, marginBottom: 10 }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 3, padding: "0 2px",
          }}>
            <span style={{ fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1 }}>Recent destinations</span>
            <button
              onClick={() => recentTrips.forEach((t) => onDeleteRecent(t.id))}
              style={{
                border: "none", background: "transparent",
                color: "#90a4ae",
                fontSize: 12, fontWeight: 400,
                cursor: "pointer", padding: "0 4px", lineHeight: 1,
              }}
              title="Clear all recent destinations"
            >Clear all</button>
          </div>
          <div style={{
            display: "flex", flexDirection: "column", gap: 4,
            maxHeight: 320, overflowY: "auto",
          }}>
            {recentTrips.map((t) => renderTripRow(t, () => onDeleteRecent(t.id), false))}
          </div>
        </div>
      )}
      {autoDetectOffer && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, background: "#1a1a2e", color: "#fff",
          borderRadius: 12, padding: "12px 16px",
          maxWidth: 340, width: "calc(100% - 32px)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            🚌 On {autoDetectOffer.option.routeLabel} #{autoDetectOffer.bus.bus_name.replace(/^#/, "")}?
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {autoDetectOffer.aboard
              ? "You're moving with this bus — track your ride?"
              : "Detected near your board stop"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const o = autoDetectOffer.option;
                onBoard({
                  routeLabel: o.routeLabel, color: o.color,
                  busName: autoDetectOffer.bus.bus_name,
                  boardStopId: o.boardStopId, alightStopId: o.alightStopId,
                  startedAt: Date.now(),
                  ...(toLL && toText ? { toLat: toLL.lat, toLon: toLL.lon, toText } : {}),
                });
                setAutoDetectOffer(null);
              }}
              style={{
                flex: 1, fontSize: 13, fontWeight: 700, padding: "8px 12px",
                border: "none", borderRadius: 8,
                background: autoDetectOffer.option.color, color: "#fff",
                cursor: "pointer", fontFamily: "inherit",
              }}
            >Yes, I'm on it</button>
            <button
              onClick={() => {
                dismissedAutoRef.current.add(autoDetectOffer.key);
                setAutoDetectOffer(null);
              }}
              style={{
                flex: 1, fontSize: 13, fontWeight: 600, padding: "8px 12px",
                border: "1px solid rgba(255,255,255,0.4)", borderRadius: 8,
                background: "transparent", color: "#fff",
                cursor: "pointer", fontFamily: "inherit",
              }}
            >Not me</button>
          </div>
        </div>
      )}
    </div>
  );
};

type UpcomingArrival = {
  eta: number; low: number; high: number;
  routeLabel: string; color: string; busName: string; stopId: number;
};

// Drop buses whose GPS sits far from every stop on the route.
// TransLoc keeps reporting a bus when it's parked at a depot or
// deadheading between shifts — at the Hamden yard we see Red bus #122
// show up ~2 km north of the route, creating phantom arrivals and
// stranded pins on the minimap. 500 m is generous enough to tolerate
// routes that briefly drift off the stop-list geometry (shortcut
// turns, etc.) while rejecting anything that's genuinely off-route.
const OFF_ROUTE_THRESHOLD_M = 500;
function isBusOnRoute(
  bus: { lat: number; lon: number },
  stops: number[],
  stopCoords: Record<number, { lat: number; lon: number }>,
): boolean {
  if (!bus.lat || !bus.lon) return true; // no GPS → don't filter
  let bestM2 = Infinity;
  for (const sid of stops) {
    const sc = stopCoords[sid];
    if (!sc) continue;
    const dlat = (bus.lat - sc.lat) * 111_000;
    const dlon = (bus.lon - sc.lon) * 84_000;
    const m2 = dlat * dlat + dlon * dlon;
    if (m2 < bestM2) bestM2 = m2;
    if (bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M) return true;
  }
  return bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M;
}

// Distance from a point to a line segment, in meters (flat-earth
// approximation adequate for intra-campus distances). Unlike the line
// distance, this clamps projection to [0, 1] — points past either
// endpoint return distance to that endpoint, not some imagined
// perpendicular into the wrong direction.
function distanceToSegmentM(
  p: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const t = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
  const projLat = a.lat + (b.lat - a.lat) * t;
  const projLon = a.lon + (b.lon - a.lon) * t;
  const dlat = (p.lat - projLat) * 111_000;
  const dlon = (p.lon - projLon) * 84_000;
  return Math.sqrt(dlat * dlat + dlon * dlon);
}

// Locate a bus on a route's stop sequence. First-principles algorithm:
//
//   1. Find all segments stops[i] → stops[i+1] within GPS_THRESHOLD_M
//      of the bus's actual GPS — these are plausible candidates.
//   2. If the feed provides last_stop_id and it's on the route, among
//      the candidates prefer the one with the shortest FORWARD
//      distance from last_stop_id. This disambiguates routes that
//      revisit the same vicinity twice (e.g., Red passes 130 Prospect
//      on both inbound and outbound legs) without letting the
//      feed override fresh GPS.
//   3. If no segment is within threshold (bus is genuinely off-route
//      or on a part of the route the stop list doesn't model), fall
//      back to the globally-nearest segment.
//
// Returns the starting-stop index of the segment. The downstream step
// loop treats this as "bus is currently on segment i → i+1" which is
// the correct mental model for both dwelling-at-stop and mid-segment
// cases.
const ANCHOR_GPS_THRESHOLD_M = 150;
function findRouteAnchor(
  bus: { lat: number; lon: number; last_stop_id?: number; at_stop_id?: number },
  stops: number[],
  stopCoords: Record<number, { lat: number; lon: number }>,
): number {
  const N = stops.length;
  if (N === 0) return -1;

  // No GPS — fall back to feed's last_stop_id (or 0 if not on route).
  if (!bus.lat || !bus.lon) {
    const idx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;
    return idx >= 0 ? idx : 0;
  }

  // Bus parked at a stop on this route (at_stop_id is GPS-derived, fresh
  // within one poll cycle): anchor there directly. The segment scan below
  // can lag one stop behind at exactly this moment — the bus sits on the
  // shared endpoint of segments i-1→i and i→i+1, and a stale last_stop_id
  // tie-breaks toward the earlier segment (report #27: banner said "get
  // off in 2 stops" while the bus was already at the stop before the
  // rider's). GPS proximity is still required so a stale at_stop_id
  // can't drag the anchor somewhere the bus isn't.
  if (bus.at_stop_id != null) {
    const ai = stops.indexOf(bus.at_stop_id);
    if (ai >= 0) {
      const sc = stopCoords[stops[ai]];
      if (sc) {
        const dlat = (bus.lat - sc.lat) * 111_000;
        const dlon = (bus.lon - sc.lon) * 84_000;
        if (dlat * dlat + dlon * dlon < ANCHOR_GPS_THRESHOLD_M * ANCHOR_GPS_THRESHOLD_M) return ai;
      }
    }
  }

  // Distance to each segment.
  const dists: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = stopCoords[stops[i]];
    const b = stopCoords[stops[(i + 1) % N]];
    if (!a || !b) { dists[i] = Infinity; continue; }
    dists[i] = distanceToSegmentM(bus, a, b);
  }

  const lastIdx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;

  // Candidates within threshold, sorted by forward distance from
  // last_stop_id (if available) so a route that revisits a vicinity
  // twice picks the right leg. Distance tiebreaker for ties.
  const candidates: number[] = [];
  for (let i = 0; i < N; i++) {
    if (dists[i] < ANCHOR_GPS_THRESHOLD_M) candidates.push(i);
  }
  if (candidates.length > 0) {
    if (lastIdx >= 0) {
      candidates.sort((a, b) => {
        const fa = (a - lastIdx + N) % N;
        const fb = (b - lastIdx + N) % N;
        if (fa !== fb) return fa - fb;
        return dists[a] - dists[b];
      });
    } else {
      candidates.sort((a, b) => dists[a] - dists[b]);
    }
    return candidates[0];
  }

  // Nothing within threshold — bus is off-route-ish. Just pick
  // globally-nearest so downstream code still has a valid anchor.
  let bestIdx = 0;
  let bestD = dists[0];
  for (let i = 1; i < N; i++) {
    if (dists[i] < bestD) { bestD = dists[i]; bestIdx = i; }
  }
  return bestIdx;
}


function computeUpcomingArrivals(
  targetStopIds: number[],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, { lat: number; lon: number }>,
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>,
  dwellTimes?: Record<string, Record<string, { med: number; sd: number; n: number }>>,
  dwellsByBus?: Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>,
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

    const routeBuses = buses.filter((b) =>
      cfg.busRouteIds.includes(b.route_id) && isBusOnRoute(b, stops, stopCoords),
    );
    if (routeBuses.length === 0) continue;

    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};
    const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
    const avgSeg = segValues.length > 0
      ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
      : 0;
    const fallbackSd = avgSeg * 0.5;

    for (const bus of routeBuses) {
      // Anchor = segment start. GPS is the ground-truth signal;
      // last_stop_id only breaks ties on routes that revisit a
      // vicinity (e.g., Red passes 130 Prospect on both inbound
      // and outbound legs). This replaces the older "trust feed,
      // advance one stop at a time" pattern which stalled when
      // last_stop_id was multi-stops-stale and the bus had drifted
      // off-axis from subsequent segment lines.
      const gpsAnchorIdx = findRouteAnchor(bus, stops, stopCoords);
      if (gpsAnchorIdx < 0) continue;

      // at_stop_id is GPS-computed every poll cycle (~5 s) and is more
      // current than last_stop_id (the feed lags by one stop on arrival).
      // If the bus is parked at a known route stop, use that as the anchor
      // so the stall credit and segment walk both start from the right place.
      // Without this, findRouteAnchor's last_stop_id tiebreak picks the
      // segment that ENDS at the current stop (because last_stop_id is still
      // the previous stop), causing busIsAtAnchor to fail and no credit applied.
      let busIdx = gpsAnchorIdx;
      let stallCredit = 0;
      if (bus.at_stop_id && bus.at_stop_since) {
        const atIdx = stops.indexOf(bus.at_stop_id);
        if (atIdx >= 0) {
          busIdx = atIdx;
          stallCredit = Math.max(
            0,
            (Date.now() - new Date(bus.at_stop_since + "Z").getTime()) / 1000,
          );
        }
      }

      // Mid-segment proration: if the bus is en route (not dwelling at
      // the anchor) and GPS shows it between A and B, scale the first
      // segment's time by the fraction of A→B still ahead.
      //
      // Use the along-segment projection t (0 = at A, 1 = at B) — the
      // same number the anchor-advance uses — so the two stay
      // consistent. Perpendicular GPS jitter moves t very little, unlike
      // straight-line-to-B distance which can swing wildly. Remaining
      // fraction = (1 - t), clamped [0, 1]: if anchor-advance didn't
      // fire but t happens to exceed 1 due to sub-step drift, treat it
      // as 0 remaining rather than negative.
      let firstSegProgressFactor = 1;
      if (stallCredit === 0 && bus.lat && bus.lon) {
        const a = stopCoords[stops[busIdx]];
        const b = stopCoords[stops[(busIdx + 1) % stops.length]];
        if (a && b) {
          const t = progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b);
          firstSegProgressFactor = Math.max(0, Math.min(1, 1 - t));
        }
      }

      let cumulative = 0;
      let cumulativeVar = 0;
      const totalStops = stops.length;
      // Walk the loop TWICE so each stop can get two arrivals per bus: the
      // upcoming one and the same vehicle a full lap later. On single-bus
      // routes (Blue Weekend most weekends) that second-lap entry is the only
      // way to answer "and the one after that?" (report #29), and it turns
      // "departed" into an honest wait-for-it-to-come-around when the rider
      // can't catch the current pass (report #30). It also covers the bus's
      // own anchor stop (reachable only at step ≥ totalStops), so a bus
      // dwelling AT a stop still yields an ETA for that stop.
      const recordedForStop = new Map<number, number>();
      const MAX_ETA_SEC = 90 * 60; // sanity cap — beyond this the lap-2 guess is noise
      for (let step = 1; step <= totalStops * 2; step++) {
        const prevI = (busIdx + step - 1) % totalStops;
        const curI = (busIdx + step) % totalStops;
        const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
        let segAvg: number;
        let segVar: number;
        if (seg && seg.n >= 1) {
          segAvg = seg.avg;
          segVar = (seg.sd ?? 0) ** 2;
        } else if (avgSeg > 0) {
          segAvg = avgSeg;
          segVar = fallbackSd * fallbackSd;
        } else {
          const pc = stopCoords[stops[prevI]], cc = stopCoords[stops[curI]];
          segAvg = pc && cc
            ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S)
            : 90;
          segVar = (segAvg * 0.5) ** 2;
        }
        // Burn stall credit on the first segment only, capped by the
        // segment itself so we don't go negative.
        if (step === 1 && stallCredit > 0) {
          const applied = Math.min(stallCredit, segAvg);
          segAvg -= applied;
          stallCredit -= applied;
        }
        // Mid-segment proration on the first segment: scale down by the
        // fraction of the A→B distance still ahead of the bus. Scale
        // variance by fraction² so "almost there" also means "less
        // uncertainty about when."
        if (step === 1 && firstSegProgressFactor < 1) {
          segAvg *= firstSegProgressFactor;
          segVar *= firstSegProgressFactor * firstSegProgressFactor;
        }
        cumulative += segAvg;
        cumulativeVar += segVar;
        if (cumulative > MAX_ETA_SEC) break;
        const sid = stops[curI];
        const recorded = recordedForStop.get(sid) ?? 0;
        if (targetSet.has(sid) && recorded < 2 && cumulative >= 0) {
          recordedForStop.set(sid, recorded + 1);
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
  if (a.eta < 60) return "<1 min";
  return `${lo} min`;
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
      const rawR: GeocodeResult[] = d.results ?? [];
      let results = rawR.filter((g) => haversineMeters(SERVICE_CENTER, g) <= SERVICE_RADIUS_M).slice(0, 8);
      if (results.length === 0) results = rawR.slice(0, 8);
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
    const sizeTimer = setTimeout(() => map.invalidateSize(), 60);
    return () => {
      clearTimeout(sizeTimer);
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      markersRef.current = {};
    };
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
              {suggIcon(g)} {suggLabel(g)}
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
            Saved destinations
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e0ddd8", overflow: "hidden" }}>
            {savedTrips.map((t, i) => (
              <div key={t.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                borderBottom: i === savedTrips.length - 1 ? "none" : "1px solid #f0ede8",
              }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#263238", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: "#9e9e9e", marginRight: 6 }}>→</span>
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
  routePeaks?: Record<string, number>;
  tick: number;
  listView: "all" | "favorites" | "accuracy";
  activeOnly?: boolean;
  hiddenRoutes?: Set<string>;
  favoriteStopIds?: Set<number>;
  favorites: Set<string>;
  onToggleFavorite: (routeId: string) => void;
  savedStops: Set<number>;
  onToggleSavedStop: (stopId: number) => void;
}> = ({ buses, stopNames, stopCoords, routeStops, segmentTimes, dwellTimes, routePeaks, tick, listView, activeOnly, hiddenRoutes, favoriteStopIds, favorites, onToggleFavorite, savedStops, onToggleSavedStop }) => {

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
              // Route subtitle: estimated loop duration + live bus count.
              // Prefer learned segment averages; fall back to straight-line
              // distance over BUS_SPEED_M_S for any missing segment. This
              // keeps the line populated for routes like Red that currently
              // have no calibrated data in the DB (collector hasn't logged
              // them yet, or they've been trimmed), as long as we know the
              // stop coordinates.
              const loopSegs = segmentTimes[primaryRouteId] ?? {};
              let loopSec = 0;
              let hasAny = false;
              const n = stops.length;
              for (let k = 0; k < n; k++) {
                const prev = stops[k];
                const cur = stops[(k + 1) % n];
                const seg = loopSegs[`${prev}-${cur}`];
                if (seg && seg.n >= 1) {
                  loopSec += seg.avg;
                  hasAny = true;
                } else {
                  const pc = stopCoords[prev], cc = stopCoords[cur];
                  if (pc && cc) {
                    loopSec += Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
                  }
                }
              }
              const busCount = buses.filter((b) => cfg.busRouteIds.includes(b.route_id)).length;
              const peak = Math.max(
                busCount,
                ...cfg.busRouteIds.map((bid) => (routePeaks?.[String(bid)] ?? 0)),
              );
              const loopMin = Math.round(loopSec / 60);
              const schedule = fmtSchedule(cfg.label);
              if (!loopSec && !busCount && !peak && !schedule) return null;
              return (
                <>
                  <div style={{ fontSize: 9.5, color: "#78909c", padding: "0 10px 2px", display: "flex", justifyContent: "space-between" }}>
                    <span>{loopSec ? `${hasAny ? "" : "~"}loop ${loopMin} min` : ""}</span>
                    <span>{peak > 0 ? `${busCount}/${peak}` : busCount} {peak === 1 || (peak === 0 && busCount === 1) ? "bus" : "buses"}</span>
                  </div>
                  {schedule && (
                    <div style={{ fontSize: 9.5, color: "#78909c", padding: "0 10px 3px" }}>
                      {schedule}
                    </div>
                  )}
                </>
              );
            })()}
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
                    return lo < hi ? `${lo}-${hi} min` : `${lo} min`;
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
                        const label = `${lo} min`;
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
        etaStr = "<1 min";
      } else {
        etaStr = `${Math.round(e.low / 60)} min`;
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
                  <title>Often pauses ~{ls.dwellMin} min here</title>
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
                const label = expMin !== null ? `${elapsed}/~${expMin} min` : elapsed;
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

interface AccuracyByDistance {
  stops_ahead: string; // "1" | "2" | "3" | "4-5" | "6+"
  n: number;
  // Typical miss (median of |error|), worst-case window (p95 / p90),
  // and signed bias (+ve = bus arrives earlier than we predict →
  // rider could miss it; -ve = bus arrives later than we predict).
  p50_sec?: number | null;
  p90_sec?: number | null;
  p95_sec?: number | null;
  mae_sec?: number | null;
  bias_sec?: number | null;
}

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
  // 90th/95th percentile absolute-error in seconds. The UI picks the
  // higher-confidence one if its window is ≤ 15 min of prediction,
  // otherwise falls back to 90%.
  p90_sec?: number | null;
  p95_sec?: number | null;
  // How accuracy varies with how many stops the bus is away at
  // prediction time. A close bus ("1" stop) is typically an order
  // of magnitude tighter than a far one ("6+").
  by_distance?: AccuracyByDistance[];
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
    p90_sec?: number | null;
    p95_sec?: number | null;
    weighted?: string;
  } | null;
}

function fmtSec(s: number): string {
  const abs = Math.abs(s);
  if (abs < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  return `${m.toFixed(1)} min`;
}

// Pretty-print a confidence window (±X min). Sub-minute values stay
// in seconds so "±30s" doesn't get rounded to "±0.5 min". Round to
// whole minutes once we're past 10 min — the implied precision isn't
// there. Spell "min" (not "m") so it can't be read as miles.
function fmtWindow(sec: number): string {
  if (sec < 60) return `±${Math.round(sec)}s`;
  const m = sec / 60;
  if (m >= 10) return `±${Math.round(m)} min`;
  return `±${m.toFixed(1)} min`;
}

// Choose which percentile to show: prefer 95% if that window sits
// within maxSec (default 15 min), otherwise fall back to 90%. Returns
// null when neither value is available.
function pickConfidence(
  p95: number | null | undefined,
  p90: number | null | undefined,
  maxSec = 15 * 60,
): { windowSec: number; level: 95 | 90 } | null {
  if (p95 != null && p95 <= maxSec) return { windowSec: p95, level: 95 };
  if (p90 != null) return { windowSec: p90, level: 90 };
  if (p95 != null) return { windowSec: p95, level: 95 }; // fallback even if >15m
  return null;
}

// Map a numeric stops-ahead count to the server-side distance bucket
// label. Mirrors _dist_bucket() in server.py — keep in sync.
function distanceBucket(stopsAhead: number): string | null {
  if (stopsAhead <= 0) return null;
  if (stopsAhead <= 10) return String(stopsAhead);
  return "10+";
}


// On-bus tracking banner. Appears once the rider taps "I'm on this bus";
// sticky across tabs. Counts down stops-to-alight from the live bus position
// and turns red ("Get off NEXT stop!") as the stop approaches. Stateless —
// recomputes on every root re-render (i.e. every poll), so it stays current.
// Focused map for the post-boarding view: draws ONLY the boarded route — its
// path, its stops (board emphasised, alight as 🏁), the live buses on that line
// (your bus opaque, others faded), and "you are here". Modeled on AllRoutesMap
// but scoped to one ride so the rider sees just their line and where they are.
const RideRouteMap: FC<{
  ride: BoardedRide;
  buses: BusData[];
  routePaths: Record<string, [number, number][]>;
  stopCoords: Record<number, LatLon>;
  stopNames: Record<number, string>;
  routeStops: Record<string, number[]>;
  userLatLon: LatLon | null;
  onRequestLocate: () => void;
  // The rider's actual destination (from the committed Go trip), distinct from
  // the alight stop — 🏁 marks where you get off, 📍 marks where you're going.
  dest: { lat: number; lon: number; text: string } | null;
}> = ({ ride, buses, routePaths, stopCoords, stopNames, routeStops, userLatLon, onRequestLocate, dest }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const busLayerRef = useRef<L.LayerGroup | null>(null);
  const youMarkerRef = useRef<L.Marker | null>(null);
  const [awaitingPan, setAwaitingPan] = useState(false);

  const cfg = ROUTE_LISTS.find((c) => c.label === ride.routeLabel);
  const routeIds = cfg ? cfg.routeIds : [];
  const normBus = (s: string) => s.replace(/^#/, "");

  // Same bus disc as AllRoutesMap (route-colored, number inside, heading arrow,
  // pulse when dwelling).
  const busIcon = (color: string, headingDeg: number, label: string, dwelling: boolean) => {
    const fontSize = label.length >= 3 ? 9 : 11;
    return L.divIcon({
      className: "bus-marker",
      html: `
        <div style="width:44px;height:44px;position:relative;">
          ${dwelling ? `<div style="position:absolute;inset:4px;border:2px solid ${color};border-radius:50%;opacity:0.35;animation:shuttlePulse 1.8s ease-out infinite;"></div>` : ""}
          <div style="position:absolute;inset:0;transform:rotate(${Math.round(headingDeg)}deg);">
            <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${color};filter:drop-shadow(0 -1px 1px rgba(0,0,0,0.4));"></div>
          </div>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;background:${color};color:#fff;border:2.5px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font:700 ${fontSize}px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-0.02em;">${label}</div>
        </div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
  };

  // Mount-once (rebuilds when route path data lands): tiles, the boarded route's
  // polyline, its stops with board emphasised + alight as 🏁, fit to the route.
  useEffect(() => {
    if (!ref.current || mapRef.current || !cfg) return;
    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);

    const pts: [number, number][] = [];
    for (const rid of routeIds) {
      const path = routePaths[rid];
      if (!path || path.length < 2) continue;
      L.polyline(path, { color: ride.color, weight: 4, opacity: 0.85 }).addTo(map);
      for (const p of path) pts.push(p);
    }

    const seen = new Set<number>();
    for (const rid of routeIds) {
      for (const sid of routeStops[rid] ?? []) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        const c = stopCoords[sid];
        if (!c) continue;
        const nm = (stopNames[sid] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, "/");
        if (sid === ride.alightStopId) {
          L.marker([c.lat, c.lon], {
            icon: L.divIcon({ className: "alight-marker", html: `<div style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4));">🏁</div>`, iconSize: [20, 20], iconAnchor: [3, 18] }),
            keyboard: false, zIndexOffset: 800,
          }).addTo(map).bindTooltip(`Get off: ${nm}`, { direction: "top", offset: [0, -10] });
        } else {
          const isBoard = sid === ride.boardStopId;
          L.circleMarker([c.lat, c.lon], {
            radius: isBoard ? 6 : 4,
            color: isBoard ? ride.color : "#0f172a",
            weight: isBoard ? 3 : 1.5,
            fillColor: isBoard ? ride.color : "#ffffff",
            fillOpacity: 1,
          }).addTo(map).bindTooltip((isBoard ? "Boarded: " : "") + nm, { direction: "top", offset: [0, -4] });
        }
        pts.push([c.lat, c.lon]);
      }
    }

    // Final destination pin (📍) — the place the rider is actually going,
    // distinct from the 🏁 alight stop. Skipped when it sits on top of the
    // alight stop, where a second marker would just be clutter.
    const alightC = stopCoords[ride.alightStopId];
    if (dest && (!alightC || haversineMeters({ lat: dest.lat, lon: dest.lon }, alightC) > 40)) {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const label = dest.text.length > 24 ? dest.text.slice(0, 23).trimEnd() + "…" : dest.text;
      L.marker([dest.lat, dest.lon], {
        icon: L.divIcon({
          className: "dest-marker",
          html: `<div style="display:flex;flex-direction:column;align-items:center;">
            <div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4));">📍</div>
            ${label ? `<div style="margin-top:1px;font:600 10px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#C62828;background:rgba(255,255,255,0.92);border-radius:6px;padding:1px 5px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.25);">${esc(label)}</div>` : ""}
          </div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 22],
        }),
        keyboard: false, zIndexOffset: 700,
      }).addTo(map).bindTooltip(`Destination: ${esc(dest.text)}`, { direction: "top", offset: [0, -22] });
      pts.push([dest.lat, dest.lon]);
    }

    busLayerRef.current = L.layerGroup().addTo(map);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [28, 28] });
    const t1 = setTimeout(() => map.invalidateSize(), 60);
    const t2 = setTimeout(() => map.invalidateSize(), 300);
    return () => {
      clearTimeout(t1); clearTimeout(t2);
      // Cancel any in-flight pan/zoom animation before teardown —
      // Leaflet's queued animation frame otherwise fires on the removed
      // map and throws "_leaflet_pos of undefined".
      try { map.stop(); } catch { /* mid-animation teardown */ }
      try { map.stop(); } catch { /* mid-animation teardown */ }
      map.remove();
      mapRef.current = null; busLayerRef.current = null; youMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride.routeLabel, ride.boardStopId, ride.alightStopId, dest?.lat, dest?.lon, JSON.stringify(Object.keys(routePaths).sort())]);

  // Live buses on this route — redrawn each poll. Your bus is opaque + on top;
  // others on the same line are faded for context.
  useEffect(() => {
    const grp = busLayerRef.current;
    if (!grp || !cfg) return;
    grp.clearLayers();
    for (const b of buses) {
      if (!cfg.busRouteIds.includes(b.route_id)) continue;
      const isMine = normBus(b.bus_name) === normBus(ride.busName);
      L.marker([b.lat, b.lon], {
        icon: busIcon(ride.color, b.heading ?? 0, b.bus_name.replace(/^#/, ""), b.at_stop_id != null),
        keyboard: false, zIndexOffset: isMine ? 1100 : 1000, opacity: isMine ? 1 : 0.5,
      }).bindTooltip(isMine ? `${b.bus_name} · your bus` : b.bus_name, { direction: "top", offset: [0, -16] }).addTo(grp);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buses, ride.busName, ride.routeLabel]);

  // "You are here" — same pulsing blue dot used elsewhere; moved in place per fix.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLatLon) { youMarkerRef.current?.remove(); youMarkerRef.current = null; return; }
    if (youMarkerRef.current) youMarkerRef.current.setLatLng([userLatLon.lat, userLatLon.lon]);
    else youMarkerRef.current = L.marker([userLatLon.lat, userLatLon.lon], { icon: makeYouIcon(), keyboard: false, interactive: false, zIndexOffset: 900 }).addTo(map);
    if (awaitingPan) { setAwaitingPan(false); map.setView([userLatLon.lat, userLatLon.lon], Math.max(map.getZoom(), 16), { animate: true }); }
  }, [userLatLon?.lat, userLatLon?.lon, awaitingPan]);

  const locateMe = () => {
    const map = mapRef.current;
    if (map && userLatLon) { map.setView([userLatLon.lat, userLatLon.lon], Math.max(map.getZoom(), 16), { animate: true }); return; }
    setAwaitingPan(true); onRequestLocate();
  };

  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", padding: "8px 8px 4px", boxSizing: "border-box" }}>
      <style>{`@keyframes shuttlePulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }`}</style>
      <div style={{ position: "relative", width: "100%" }}>
        {/* Capped height so the stop list starts above the fold on phones
            (report #21: "the stops list is too low on page"). */}
        <div ref={ref} style={{ position: "relative", width: "100%", height: "min(32vh, 300px)", borderRadius: 8, border: "1px solid #e0ddd8", overflow: "hidden" }} />
        <button onClick={locateMe} aria-label="Show my location" title="Show my location" style={{ position: "absolute", top: 10, right: 10, zIndex: 1000, width: 44, height: 44, borderRadius: 10, border: "1px solid #cfd8dc", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, lineHeight: 1, padding: 0 }}>📍</button>
      </div>
    </div>
  );
};

// On-bus tracking stop list. Shown under RideRouteMap once the rider taps
// "I'm on this bus" / "Route". Counts down stops-to-alight from the live bus.
const RideStopList: FC<{
  ride: BoardedRide;
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, LatLon>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>;
  dwellsByBus: Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>;
}> = ({ ride, buses, stopNames, stopCoords, routeStops, segmentTimes, dwellTimes, dwellsByBus }) => {
  const cfg = ROUTE_LISTS.find(c => c.label === ride.routeLabel);
  const normBus = (s: string) => s.replace(/^#/, "");

  const allStops: number[] = [];
  if (cfg) {
    const seen = new Set<number>();
    for (const rid of cfg.routeIds) {
      for (const sid of routeStops[rid] ?? []) {
        if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
      }
    }
  }

  const bus = cfg
    ? buses.find(b =>
        normBus(b.bus_name) === normBus(ride.busName) &&
        cfg.busRouteIds.includes(b.route_id) &&
        isBusOnRoute(b, allStops, stopCoords)
      )
    : undefined;

  const busIdx = bus ? findRouteAnchor(bus, allStops, stopCoords) : -1;
  const boardIdx = allStops.indexOf(ride.boardStopId);
  const alightIdx = allStops.indexOf(ride.alightStopId);
  const n = allStops.length;

  let etaSec: number | null = null;
  if (bus) {
    const arr = computeUpcomingArrivals(
      [ride.alightStopId], buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus,
    );
    const mine = arr.find(a => a.stopId === ride.alightStopId && normBus(a.busName) === normBus(ride.busName));
    if (mine) etaSec = mine.eta;
  }

  if (n === 0 || boardIdx < 0 || alightIdx < 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#78909c", fontSize: 14 }}>
        Loading route…
      </div>
    );
  }

  // Build ordered stop list from board → alight (forward in circular route).
  const displayStops: Array<{ idx: number; stopId: number }> = [];
  {
    let i = boardIdx;
    let guard = 0;
    while (guard++ <= n) {
      displayStops.push({ idx: i, stopId: allStops[i] });
      if (i === alightIdx) break;
      i = (i + 1) % n;
    }
  }

  const busStepsFromBoard = busIdx >= 0 ? (busIdx - boardIdx + n) % n : -1;

  return (
    <div style={{ width: "100%", maxWidth: 560, margin: "0 auto", paddingBottom: 24 }}>
      <div style={{ padding: "12px 16px 6px", fontSize: 12, color: "#78909c" }}>
        {ride.routeLabel} · Bus #{normBus(ride.busName)}
        {etaSec !== null && (
          <span style={{ marginLeft: 8, color: ride.color, fontWeight: 600 }}>
            {etaSec < 60 ? "· arriving now!" : `· ${Math.round(etaSec / 60)} min to your stop`}
          </span>
        )}
      </div>
      <div style={{ padding: "4px 16px" }}>
        {displayStops.map(({ idx, stopId }, pos) => {
          const name = (stopNames[stopId] ?? `Stop ${stopId}`).replace(/\s*\/\s*/g, "/");
          const stepsFromBoard = (idx - boardIdx + n) % n;
          // Only cross out stops when the bus is actually WITHIN the
          // board→alight window. When it's still upstream of the boarding
          // stop, busStepsFromBoard wraps to a huge count and every stop
          // ahead got struck through (report #26).
          const alightSteps = (alightIdx - boardIdx + n) % n;
          const busInWindow = busStepsFromBoard >= 0 && busStepsFromBoard <= alightSteps;
          const passed = busInWindow && stepsFromBoard > 0 && stepsFromBoard <= busStepsFromBoard;
          const isBusCur = busIdx >= 0 && idx === busIdx;
          const isAlight = idx === alightIdx;
          const isBoard = idx === boardIdx;

          const icon = isBusCur ? "🚌" : isAlight ? "🏁" : passed ? "✓" : "·";
          const dimmed = passed && !isBoard;
          const highlighted = isBusCur || isAlight;

          return (
            <div key={stopId} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "9px 10px", borderRadius: 8, marginBottom: 2,
              background: highlighted ? (isAlight ? `${ride.color}18` : "#eef2ff") : "transparent",
              position: "relative",
            }}>
              {pos < displayStops.length - 1 && (
                <div style={{
                  position: "absolute", left: 22, top: "50%", bottom: -11,
                  width: 2,
                  background: dimmed ? "#e0ddd8" : isBusCur ? "#90caf9" : "#cfd8dc",
                  zIndex: 0,
                }} />
              )}
              <span style={{
                width: 20, flexShrink: 0, textAlign: "center", zIndex: 1, position: "relative",
                fontSize: icon === "✓" || icon === "·" ? 13 : 18,
                color: icon === "✓" ? "#90a4ae" : "inherit",
              }}>{icon}</span>
              <span style={{
                fontSize: 14, flex: 1,
                fontWeight: highlighted ? 700 : isBoard ? 600 : 400,
                color: dimmed ? "#c5c5c5" : isAlight ? ride.color : isBusCur ? "#1a1a2e" : "#37474f",
                textDecoration: dimmed ? "line-through" : "none",
              }}>
                {name}
                {isBoard && <span style={{ fontSize: 11, color: "#90a4ae", marginLeft: 6, fontWeight: 400 }}>boarded</span>}
                {isAlight && etaSec !== null && !isBusCur && (
                  <span style={{ fontSize: 11, color: ride.color, marginLeft: 6, fontWeight: 600 }}>
                    {etaSec < 60 ? "now!" : `~${Math.round(etaSec / 60)} min`}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const OnBusBanner: FC<{
  ride: BoardedRide;
  buses: BusData[];
  stopNames: Record<number, string>;
  stopCoords: Record<number, LatLon>;
  routeStops: Record<string, number[]>;
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>;
  dwellTimes: Record<string, Record<string, { med: number; sd: number; n: number }>>;
  dwellsByBus: Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>;
  onEnd: () => void;
}> = ({ ride, buses, stopNames, stopCoords, routeStops, segmentTimes, dwellTimes, dwellsByBus, onEnd }) => {
  const cfg = ROUTE_LISTS.find((c) => c.label === ride.routeLabel);
  const alightName = (stopNames[ride.alightStopId] ?? `Stop ${ride.alightStopId}`).replace(/\s*\/\s*/g, "/");
  const normBus = (s: string) => s.replace(/^#/, "");
  const fmtEta = (s: number) => (s < 60 ? "now" : `${Math.round(s / 60)} min`);

  // Build the route's full stop loop (dedup across sub-route ids).
  const allStops: number[] = [];
  if (cfg) {
    const seen = new Set<number>();
    for (const rid of cfg.routeIds) {
      for (const sid of routeStops[rid] ?? []) {
        if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
      }
    }
  }

  const bus = cfg
    ? buses.find(
        (b) =>
          normBus(b.bus_name) === normBus(ride.busName) &&
          cfg.busRouteIds.includes(b.route_id) &&
          isBusOnRoute(b, allStops, stopCoords),
      )
    : undefined;

  let stopsRemaining: number | null = null;
  if (bus && allStops.length > 0) {
    const anchor = findRouteAnchor(bus, allStops, stopCoords);
    const alightIdx = allStops.indexOf(ride.alightStopId);
    if (anchor >= 0 && alightIdx >= 0) {
      stopsRemaining = (alightIdx - anchor + allStops.length) % allStops.length;
    }
  }

  let etaSec: number | null = null;
  if (bus) {
    const arr = computeUpcomingArrivals(
      [ride.alightStopId], buses, routeStops, stopCoords, segmentTimes, dwellTimes, dwellsByBus,
    );
    const mine = arr.find(
      (a) => a.stopId === ride.alightStopId && normBus(a.busName) === normBus(ride.busName),
    );
    if (mine) etaSec = mine.eta;
  }

  const arriving = stopsRemaining !== null && stopsRemaining <= 2;

  // One-shot buzz + notification + in-page popup when it's time to get
  // off (reports #13, #20) — riders look away from the screen mid-ride.
  // Fires at TWO stops out (report #20 asked for earlier warning), so
  // there's time to gather bags and ring the bell. navigator.vibrate is
  // a no-op on iOS Safari; there the popup/banner are the primary cue.
  // Keyed per ride so re-renders (or a later ride to the same stop)
  // don't re-fire.
  const getOffAlertRef = useRef<string | null>(null);
  const [getOffPopup, setGetOffPopup] = useState<string | null>(null);
  useEffect(() => {
    if (stopsRemaining === null || stopsRemaining > 2) return;
    const key = `${ride.busName}-${ride.alightStopId}`;
    if (getOffAlertRef.current === key) return;
    getOffAlertRef.current = key;
    const title = stopsRemaining <= 1 ? "Get off at the next stop" : "Get off in 2 stops";
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported */ }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body: `${ride.routeLabel} → ${alightName}`,
        });
      } catch { /* blocked */ }
    }
    setGetOffPopup(title);
  }, [stopsRemaining, ride.busName, ride.alightStopId, ride.routeLabel, alightName]);

  const etaStr = etaSec !== null ? fmtEta(etaSec) : null;
  const headline =
    bus === undefined
      ? "Looking for your bus…"
      : stopsRemaining === null
        ? "Tracking your ride"
        : stopsRemaining <= 0
          ? `Arriving at ${alightName}`
          : stopsRemaining === 1
            ? `Get off NEXT stop!${etaStr ? ` · ${etaStr}` : ""}`
            : stopsRemaining === 2
              ? `Get off in 2 stops!${etaStr ? ` · ${etaStr}` : ""}`
              : etaStr
                ? `${stopsRemaining} stops · ${etaStr}`
                : `${stopsRemaining} stops until your stop`;

  return (
    <>
    {/* Fullscreen get-off popup (report #20) — impossible to miss even
        mid-doomscroll; tap anywhere to dismiss. */}
    {getOffPopup && (
      <div
        onClick={() => setGetOffPopup(null)}
        style={{
          position: "fixed", inset: 0, zIndex: 10000,
          background: "rgba(26,26,46,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{
          background: "#fff", borderRadius: 16, padding: "22px 20px",
          maxWidth: 340, width: "100%", textAlign: "center",
          boxShadow: "0 8px 40px rgba(0,0,0,0.35)",
        }}>
          <div style={{ fontSize: 36, lineHeight: 1 }}>🔔</div>
          <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a2e", marginTop: 8 }}>
            {getOffPopup}
          </div>
          <div style={{ fontSize: 14, color: "#546e7a", marginTop: 4 }}>
            {ride.routeLabel} → {alightName}
          </div>
          <button
            onClick={() => setGetOffPopup(null)}
            style={{
              marginTop: 14, width: "100%", minHeight: 44,
              fontSize: 15, fontWeight: 700, padding: "10px 14px",
              border: "none", borderRadius: 24,
              background: ride.color, color: "#fff",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >Got it</button>
        </div>
      </div>
    )}
    <div style={{
      position: "sticky", top: 0, zIndex: 500, width: "100%", maxWidth: 1200,
      background: arriving ? "#C62828" : "#1a1a2e", color: "#fff",
      padding: "10px 16px", display: "flex", alignItems: "center", gap: 12,
      boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
    }}>
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: ride.color, border: "2px solid #fff", flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2 }}>{headline}</div>
        <div style={{ fontSize: 12, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          🚌 {ride.routeLabel}{ride.busName ? ` #${normBus(ride.busName)}` : ""} → {alightName}
        </div>
      </div>
      <button
        onClick={onEnd}
        style={{
          flexShrink: 0, fontSize: 13, fontWeight: 600, padding: "6px 14px",
          border: "1px solid rgba(255,255,255,0.6)", borderRadius: 6,
          background: "transparent", color: "#fff", cursor: "pointer",
          fontFamily: "inherit", minHeight: 36,
        }}
      >
        Done
      </button>
    </div>
    </>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

const TransitMap: FC = () => {
  const [buses, setBuses] = useState<BusData[]>([]);
  const [routeStops, setRouteStops] = useState<Record<string, number[]>>({});
  const [stopNames, setStopNames] = useState<Record<number, string>>({});
  const [segmentTimes, setSegmentTimes] = useState<Record<string, Record<string, { avg: number; sd?: number; n: number }>>>({});
  const [dwellTimes, setDwellTimes] = useState<Record<string, Record<string, { med: number; sd: number; n: number }>>>({});
  const [routePeaks, setRoutePeaks] = useState<Record<string, number>>({});
  // Full per-route polyline from downtownerapp's routes_routes.php
  // `path` field. Used to draw exact bus-route shapes on the trip map,
  // replacing the OSRM driving-directions fallback that occasionally
  // picked the wrong street.
  const [routePaths, setRoutePaths] = useState<Record<string, [number, number][]>>({});
  // Nested: {bus_name: {route_id: {stop_id: {med, sd, n}}}} — per-bus dwell
  // that we prefer over route-level when computing stall credit.
  const [dwellsByBus, setDwellsByBus] = useState<Record<string, Record<string, Record<string, { med: number; sd: number; n: number }>>>>({});
  const [busPace, setBusPace] = useState<Record<string, { fast?: boolean; slow?: boolean; ratio?: number; n?: number; skip?: { count: number; ago_sec: number } | null }>>({});
  const [stopCoords, setStopCoords] = useState<Record<number, { lat: number; lon: number }>>({});
  const [tick, setTick] = useState(0);
  // Active ride the rider has boarded (drives the on-bus banner). Seeded from
  // localStorage so a mid-trip refresh keeps tracking; persisted on change.
  const [boardedRide, setBoardedRide] = useState<BoardedRide | null>(() => loadBoardedRide());
  useEffect(() => { saveBoardedRide(boardedRide); }, [boardedRide]);
  // Committed Go trip (guided walk → wait → ride). Held here rather than in
  // TripPlanner because the planner unmounts on tab switches; persisted so
  // a refresh mid-walk resumes guidance.
  // Go mode retired 2026-07-17 ("too complicated") — never restore a
  // persisted Go trip; the save effect below clears any stored one.
  const [goTrip, setGoTrip] = useState<GoTrip | null>(null);
  useEffect(() => { saveGoTrip(goTrip); }, [goTrip]);
  // While a ride is active, the dedicated ride page (map + stop list) replaces
  // the tabbed views entirely — no toggle needed.
  const [hiddenRoutes, setHiddenRoutes] = useState<Set<string>>(new Set());
  const [showMap, setShowMap] = useState(false);
  const [listView, setListView] = useState<"all" | "trip" | "map">(() => {
    const saved = localStorage.getItem("listView");
    return saved === "all" || saved === "trip" || saved === "map" ? saved : "trip";
  });
  useEffect(() => { localStorage.setItem("listView", listView); }, [listView]);
  // All tab defaults to "Active" — a first-time visitor should see the
  // routes running right now, not a wall of 14 diagrams. When nothing is
  // running the filter is moot, so fall back to showing everything
  // (activeFilter) instead of an empty page.
  const [activeOnly, setActiveOnly] = useState(true);
  const activeFilter = activeOnly && buses.length > 0;
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  // Footer feedback form: collapsed by default. Posts to the same
  // /api/report endpoint as the per-route report button, tagged
  // with source:"feedback" so debug queries can distinguish general
  // feedback from route-specific reports.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [feedbackSending, setFeedbackSending] = useState(false);
  const sendFeedback = async () => {
    const msg = feedbackText.trim();
    if (!msg) return;
    setFeedbackSending(true);
    setFeedbackStatus(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: msg,
          source: "feedback",
          client: {
            userAgent: navigator.userAgent,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            timestamp: new Date().toISOString(),
            listView,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setFeedbackText("");
      setFeedbackOpen(false);
      setFeedbackStatus(d?.id ? `Thanks — logged (#${d.id})` : "Thanks — logged");
    } catch {
      setFeedbackStatus("Couldn't send — try again");
    }
    setFeedbackSending(false);
    setTimeout(() => setFeedbackStatus(null), 6_000);
  };
  // Seed userLatLon from localStorage so reloads don't flash "Tap
  // to set start" while the GPS watcher warms up. CRITICAL: the
  // cached entry is only trusted for 5 minutes. Any longer and the
  // rider (or a different rider on a shared phone) might have moved
  // enough that planning against a stale home coord produces
  // garbage — the bug we hit when a wife's search from Trumbull
  // St → 517 Prospect returned no results because the cached coord
  // was "already at 517 Prospect."
  const LOCATION_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
  // GPS course in degrees from north (null when stationary/unknown) —
  // rotates the Go screen's compass arrow toward the pickup stop.
  const [userHeading, setUserHeading] = useState<number | null>(null);
  const [userLatLon, setUserLatLon] = useState<{ lat: number; lon: number } | null>(() => {
    try {
      const raw = localStorage.getItem("lastUserLatLon");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const { lat, lon, t } = parsed ?? {};
      if (typeof lat !== "number" || typeof lon !== "number") return null;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      // Reject anything without a timestamp or older than the cap.
      if (typeof t !== "number" || Date.now() - t > LOCATION_CACHE_MAX_AGE_MS) {
        return null;
      }
      return { lat, lon };
    } catch { /* ignore corrupt storage */ }
    return null;
  });
  // Persist whenever we get a fresh fix — timestamped so the next
  // session can tell how stale the cache is.
  useEffect(() => {
    if (userLatLon) {
      try {
        localStorage.setItem("lastUserLatLon", JSON.stringify({
          lat: userLatLon.lat, lon: userLatLon.lon, t: Date.now(),
        }));
      } catch { /* quota or private mode — non-critical */ }
    }
  }, [userLatLon]);
  // Start in "locating" mode whenever we don't have a fresh cached
  // location — the watchPosition effect below takes over on mount.
  // Initializing from state (rather than flipping to true in the
  // effect) avoids a single-frame flash of "Tap to set start".
  const [locating, setLocating] = useState(() => {
    try {
      const raw = localStorage.getItem("lastUserLatLon");
      if (!raw) return true;
      const parsed = JSON.parse(raw);
      const { t } = parsed ?? {};
      return !(typeof t === "number" && Date.now() - t <= LOCATION_CACHE_MAX_AGE_MS);
    } catch { return true; }
  });
  const [locateError, setLocateError] = useState<string | null>(null);
  const watchIdRef = React.useRef<number | null>(null);
  // Accuracy tier the live watch is currently running at (null = none yet).
  // Every watchPosition registration below records its tier here so the
  // battery-saver effect can tell "needs a different accuracy" from "already
  // correct" — restarting a healthy watch throws away the current fix and
  // re-acquires GPS from cold, which is what a rider sees as a frozen dot.
  const gpsPreciseRef = React.useRef<boolean | null>(null);

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
          gpsPreciseRef.current = true;
          watchIdRef.current = navigator.geolocation.watchPosition(
            (p) => {
              setUserLatLon({ lat: p.coords.latitude, lon: p.coords.longitude });
              setUserHeading(Number.isFinite(p.coords.heading as number) ? p.coords.heading : null);
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 5_000 },
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

  // Auto-start watchPosition on mount. Previously GPS only kicked in
  // when the rider explicitly tapped "use my location" — which meant
  // the cached home coord carried the UI for the first few seconds
  // (or forever, when permissions had already been granted but
  // nothing triggered the actual fetch). Now the watcher runs
  // immediately in silent mode: if permission is already granted
  // it lands a fresh fix within a second; if not, the rider still
  // sees the cached location (valid for ≤5 min, see userLatLon init)
  // or the "Locating…" state below.
  useEffect(() => {
    if (!navigator.geolocation || !window.isSecureContext) return;
    if (watchIdRef.current != null) return;
    gpsPreciseRef.current = true;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setUserLatLon({ lat: p.coords.latitude, lon: p.coords.longitude });
        // GPS course (degrees from north) — only valid while moving;
        // NaN/null when stationary. Drives the Go screen's compass arrow.
        setUserHeading(Number.isFinite(p.coords.heading as number) ? p.coords.heading : null);
        setLocating(false);
        setLocateError(null);
      },
      (err) => {
        // Don't show the error banner for the silent auto-start —
        // only for explicit locate requests. A user who has
        // permissions blocked should still be able to enter a
        // From manually.
        if (err.code === err.PERMISSION_DENIED) return;
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
    // If we don't have ANY location yet (cache stale, first run),
    // show the "Locating…" hint so the rider knows to wait.
    if (!userLatLon) setLocating(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Battery saver (report #23): continuous high-accuracy GPS only while a
  // trip actually needs it (guided Go trip or on-bus ride). Idle browsing
  // — including after the rider reaches their destination and taps Done —
  // downgrades to a coarse, heavily-cached watch. Restarting the watch on
  // transition is the only way to change accuracy; the callback is the
  // same either way.
  // `goTrip || boardedRide` alone mis-classified the single most
  // location-sensitive phase there is — walking to the pickup stop, before
  // any trip has been started — as idle browsing. Those riders got
  // enableHighAccuracy:false with maximumAge:60_000, i.e. a coarse fix up to
  // a minute stale, and watched their dot sit still while they walked
  // (reports #36, #39, #43, #44). Only the passive "all routes" list is
  // genuinely idle; the trip and map views both render a live dot.
  const tripActiveForGps = !!goTrip || !!boardedRide || listView !== "all";
  useEffect(() => {
    if (!navigator.geolocation || !window.isSecureContext) return;
    if (watchIdRef.current == null) return; // nothing running yet — mount effect owns the first start
    if (gpsPreciseRef.current === tripActiveForGps) return; // already at the right tier
    navigator.geolocation.clearWatch(watchIdRef.current);
    gpsPreciseRef.current = tripActiveForGps;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setUserLatLon({ lat: p.coords.latitude, lon: p.coords.longitude });
        setUserHeading(Number.isFinite(p.coords.heading as number) ? p.coords.heading : null);
        setLocating(false);
        setLocateError(null);
      },
      () => { /* silent — same policy as the auto-start watch */ },
      tripActiveForGps
        ? { enableHighAccuracy: true, maximumAge: 5_000 }
        : { enableHighAccuracy: false, maximumAge: 60_000 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripActiveForGps]);

  // Backgrounded tab → no GPS at all. Mobile browsers mostly suspend
  // geolocation for hidden tabs anyway, but that's per-browser folklore;
  // tearing the watch down ourselves makes "inactive page burns no
  // battery" a guarantee rather than a hope. On return the watch
  // restarts at whatever accuracy the current trip state calls for.
  useEffect(() => {
    if (!navigator.geolocation || !window.isSecureContext) return;
    const onVisibility = () => {
      if (document.hidden) {
        if (watchIdRef.current != null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
          gpsPreciseRef.current = null;
        }
      } else if (watchIdRef.current == null) {
        gpsPreciseRef.current = tripActiveForGps;
        watchIdRef.current = navigator.geolocation.watchPosition(
          (p) => {
            setUserLatLon({ lat: p.coords.latitude, lon: p.coords.longitude });
            setUserHeading(Number.isFinite(p.coords.heading as number) ? p.coords.heading : null);
            setLocating(false);
            setLocateError(null);
          },
          () => { /* silent */ },
          tripActiveForGps
            ? { enableHighAccuracy: true, maximumAge: 5_000 }
            : { enableHighAccuracy: false, maximumAge: 60_000 },
        );
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripActiveForGps]);

  // Auto-end forgotten trips (user request 2026-07-17) — an active trip
  // is what keeps the GPS in high-accuracy mode, so one the rider forgot
  // to end would burn battery indefinitely. Three independent triggers:
  //   (a) age cap — no shuttle trip takes 2 hours;
  //   (b) rider has been ≥300 m from their bus for 3 consecutive checks
  //       (~15 s of polls): they got off (or never boarded);
  //   (c) the pinned bus has been absent from the feed for 10 min —
  //       service ended with the ride page still open.
  const offBusStreakRef = React.useRef(0);
  const busLastSeenRef = React.useRef<number>(Date.now());
  useEffect(() => {
    const TRIP_MAX_AGE_MS = 2 * 3600_000;
    const now = Date.now();
    if (goTrip && now - goTrip.startedAt > TRIP_MAX_AGE_MS) {
      setGoTrip(null);
      setBoardedRide(null);
      return;
    }
    if (boardedRide && boardedRide.startedAt && now - boardedRide.startedAt > TRIP_MAX_AGE_MS) {
      setBoardedRide(null);
      setGoTrip(null);
      return;
    }
    if (!boardedRide) {
      offBusStreakRef.current = 0;
      busLastSeenRef.current = now;
      return;
    }
    const cfg = ROUTE_LISTS.find((c) => c.label === boardedRide.routeLabel);
    const norm = (s: string) => s.replace(/^#/, "");
    const bus = cfg
      ? buses.find((b) => norm(b.bus_name) === norm(boardedRide.busName) && cfg.busRouteIds.includes(b.route_id))
      : undefined;
    if (!bus) {
      if (now - busLastSeenRef.current > 10 * 60_000) {
        setBoardedRide(null);
        setGoTrip(null);
      }
      return;
    }
    busLastSeenRef.current = now;
    if (userLatLon && bus.lat && bus.lon) {
      const d = haversineMeters(userLatLon, { lat: bus.lat, lon: bus.lon });
      offBusStreakRef.current = d > 300 ? offBusStreakRef.current + 1 : 0;
      if (offBusStreakRef.current >= 3) {
        offBusStreakRef.current = 0;
        setBoardedRide(null);
        setGoTrip(null);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("Ride ended", { body: "Looks like you've left the bus — tracking stopped to save battery." });
          } catch { /* blocked */ }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buses, userLatLon?.lat, userLatLon?.lon, goTrip, boardedRide]);
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
    // Guard against out-of-order responses: if a slow request lands after a
    // newer one, its state writes are dropped. Also abort the in-flight
    // request on component unmount so we don't setState on a dead tree.
    let seq = 0;
    let latestApplied = 0;
    let currentController: AbortController | null = null;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (currentController) currentController.abort();
      const controller = new AbortController();
      currentController = controller;
      const mySeq = ++seq;
      try {
        const res = await fetch("/api/buses", { signal: controller.signal });
        const data = await res.json();
        if (stopped || mySeq <= latestApplied) return;
        latestApplied = mySeq;
        // Drop out-of-service ghosts (see isBusInService) before anything
        // downstream — map markers, planner, and arrival boards all read
        // this state.
        setBuses(((data.buses ?? []) as BusData[]).filter(isBusInService));
        if (data.routes) setRouteStops(data.routes);
        if (data.stop_names) setStopNames(data.stop_names);
        if (data.segments) setSegmentTimes(data.segments);
        if (data.dwells) setDwellTimes(data.dwells);
        if (data.stop_coords) setStopCoords(data.stop_coords);
        if (data.route_peaks) setRoutePeaks(data.route_peaks);
        if (data.dwells_by_bus) setDwellsByBus(data.dwells_by_bus);
        if (data.route_paths) setRoutePaths(data.route_paths);
        if (data.bus_pace) setBusPace(data.bus_pace);
      } catch { /* aborted or network error — next tick will retry */ }
    };
    // Adaptive cadence: 5s when the tab is visible (active riders
    // watching an ETA), 30s when hidden (battery-friendly background).
    // On visibilitychange we also kick off an immediate poll so the
    // first visible render sees fresh data, not the 30-s-stale tail.
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const intervalMs = () => (document.hidden ? 30_000 : 5_000);
    const restart = () => {
      if (intervalId !== null) clearInterval(intervalId);
      intervalId = setInterval(poll, intervalMs());
    };
    const onVisibility = () => {
      restart();
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    poll();
    restart();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (intervalId !== null) clearInterval(intervalId);
      if (currentController) currentController.abort();
    };
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
    // Accuracy refreshes on a much slower cadence than /api/buses —
    // it's a 14-day rollup, so stale-by-a-few-minutes is fine. We run
    // it regardless of the active tab now so the Trip card can
    // annotate each route with the ±window for "bus N stops away"
    // without a round-trip on tab switch.
    let cancelled = false;
    const fetchAccuracy = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/accuracy");
        const data = await res.json();
        if (!cancelled) setAccuracy(data);
      } catch { /* ignore */ }
    };
    fetchAccuracy();
    const id = setInterval(fetchAccuracy, 2 * 60_000);
    const onVisibility = () => { if (!document.hidden) fetchAccuracy(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

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
      {boardedRide && (
        <OnBusBanner
          ride={boardedRide}
          buses={buses}
          stopNames={stopNames}
          stopCoords={stopCoords}
          routeStops={routeStops}
          segmentTimes={segmentTimes}
          dwellTimes={dwellTimes}
          dwellsByBus={dwellsByBus}
          onEnd={() => { setBoardedRide(null); setGoTrip(null); }}
        />
      )}
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

      {/* View tabs — hidden while on a bus, since the ride page is its own view */}
      {!boardedRide && (
      <div className="app-tabs" style={{ width: "100%", padding: "0 16px", maxWidth: 1200 }}>
        <div style={{
          display: "flex", gap: 4, padding: "4px 4px 6px", fontSize: 11,
          overflowX: "auto", WebkitOverflowScrolling: "touch",
          justifyContent: "center", flexWrap: "wrap",
        }}>
          {(["trip", "all", "map"] as const).map((v) => (
            <button
              key={v}
              onClick={() => { setListView(v); }}
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
      )}

      {/* Ride page — once on a bus this is the whole view (its own page): a map
          of just your route + your location, then the stop list. Tabs are hidden
          above; "Done" in the banner ends the ride and returns to the tabs. */}
      {boardedRide ? (
        <>
          <RideRouteMap
            ride={boardedRide}
            buses={buses}
            routePaths={routePaths}
            stopCoords={stopCoords}
            stopNames={stopNames}
            routeStops={routeStops}
            userLatLon={userLatLon}
            onRequestLocate={startLocating}
            dest={boardedRide?.toLat != null && boardedRide?.toText ? { lat: boardedRide.toLat, lon: boardedRide.toLon!, text: boardedRide.toText } : null}
          />
          <RideStopList
            ride={boardedRide}
            buses={buses}
            stopNames={stopNames}
            stopCoords={stopCoords}
            routeStops={routeStops}
            segmentTimes={segmentTimes}
            dwellTimes={dwellTimes}
            dwellsByBus={dwellsByBus}
          />
        </>
      ) : listView === "map" ? (
        <AllRoutesMap
          buses={buses} routePaths={routePaths}
          stopCoords={stopCoords} stopNames={stopNames} routeStops={routeStops}
          userLatLon={userLatLon} onRequestLocate={startLocating}
        />
      ) : listView === "trip" ? (
        <TripPlanner
          buses={buses} stopNames={stopNames} stopCoords={stopCoords}
          routeStops={routeStops} routePaths={routePaths} segmentTimes={segmentTimes} dwellTimes={dwellTimes} dwellsByBus={dwellsByBus} busPace={busPace}
          userLatLon={userLatLon} onRequestLocate={startLocating}
          locating={locating} locateError={locateError}
          savedTrips={savedTrips}
          onSaveTrip={(t) => saveSavedTrips([...savedTrips, t])}
          onDeleteSaved={(id) => saveSavedTrips(savedTrips.filter((x) => x.id !== id))}
          onRenameSaved={(id, toText) => saveSavedTrips(savedTrips.map((x) => x.id === id ? { ...x, toText, name: toText } : x))}
          recentTrips={recentTrips}
          onRecordRecent={saveRecentTrips}
          onDeleteRecent={(id) => saveRecentTrips(recentTrips.filter((x) => x.id !== id))}
          pendingTrip={pendingTrip} onConsumePending={() => setPendingTrip(null)}
          accuracy={accuracy}
          onBoard={(ride) => { setBoardedRide(ride); }}
          goTrip={goTrip}
          onGoStart={(g) => setGoTrip(g)}
          onGoUpdate={(g) => setGoTrip(g)}
          onGoEnd={() => setGoTrip(null)}
          userHeading={userHeading}
        />
      ) : (
      <>
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
          {activeOnly && buses.length === 0 && (
            <span style={{ fontSize: 11, color: "#78909c", width: "100%" }}>
              No shuttles running right now — showing all routes
            </span>
          )}
        </div>
      )}

      {/* Route jump index: one chip per visible route, scrolls to that
          route's loop diagram — the page is thousands of pixels tall. */}
      {listView === "all" && (
        <div style={{
          padding: "0 16px 6px", display: "flex", gap: 6, flexWrap: "wrap",
          justifyContent: "center",
        }}>
          {ROUTE_LISTS.map((cfg) => {
            const hasBuses = buses.some((b) => cfg.busRouteIds.includes(b.route_id));
            if (activeFilter && !hasBuses) return null;
            const toggle = cfg.busRouteIds.map((bid) => ROUTE_ID_TO_TOGGLE[bid]).find(Boolean);
            if (toggle && hiddenRoutes.has(toggle)) return null;
            return (
              <button
                key={cfg.label}
                onClick={() => document.getElementById(`loop-${cfg.label}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                title={`Jump to the ${cfg.label} route diagram`}
                style={{
                  padding: "3px 10px", borderRadius: 10,
                  border: `1px solid ${cfg.color}`, background: "#fff",
                  color: cfg.color, fontSize: 10, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                {cfg.label}{hasBuses ? "" : " 💤"}
              </button>
            );
          })}
        </div>
      )}

      {/* Stop list (all view — below the map) */}
      {listView === "all" && (
        <div style={{ width: "100%", padding: "0 16px", display: "flex", justifyContent: "center" }}>
          <StopList
            buses={buses} stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops}
            segmentTimes={segmentTimes} dwellTimes={dwellTimes} routePeaks={routePeaks} tick={tick}
            listView={listView} activeOnly={activeFilter}
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
            if (activeFilter && !hasBuses) return null;
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
              // Anchor for the jump-index chips above the list.
              <div key={idx} id={`loop-${cfg.label}`} style={{ scrollMarginTop: 8 }}>
                <TrackLoop
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
              </div>
            );
          })}
        </div>
      )}
      </>
      )}

      {/* Persistent footer: feedback affordance visible across all
          tabs (Trip / All / Accuracy). Collapsed by default so it
          doesn't compete with the primary UI; expands into a small
          textarea when the rider wants to say something. */}
      <div style={{
        width: "100%", maxWidth: 560, margin: "16px auto 24px",
        padding: "0 16px", display: "flex", flexDirection: "column",
        alignItems: "stretch", gap: 8,
      }}>
        {!feedbackOpen ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <button
              onClick={() => setFeedbackOpen(true)}
              style={{
                fontSize: 13, padding: "8px 14px", minHeight: 40,
                border: "1px solid #bbb", borderRadius: 6,
                background: "#fff", color: "#546e7a",
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              💬 Send feedback
            </button>
            {feedbackStatus && (
              <span style={{ fontSize: 12, color: "#78909c" }}>{feedbackStatus}</span>
            )}
          </div>
        ) : (
          <div style={{
            border: "1px solid #e0ddd8", borderRadius: 10, background: "#fff",
            padding: 12, display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{
              fontSize: 11, color: "#78909c", textTransform: "uppercase",
              letterSpacing: 1,
            }}>
              Feedback
            </div>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="Anything on your mind — bugs, ideas, confusing bits…"
              autoFocus
              rows={4}
              style={{
                width: "100%", fontSize: 15, padding: "10px 12px",
                border: "1px solid #ccc", borderRadius: 6,
                fontFamily: "inherit", resize: "vertical", minHeight: 80,
              }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={() => {
                  setFeedbackOpen(false);
                  setFeedbackText("");
                }}
                style={{
                  fontSize: 13, padding: "8px 14px", minHeight: 40,
                  border: "1px solid #bbb", borderRadius: 6,
                  background: "#fff", color: "#546e7a",
                  cursor: "pointer", fontFamily: "inherit", flex: 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={sendFeedback}
                disabled={feedbackSending || !feedbackText.trim()}
                style={{
                  fontSize: 13, padding: "8px 14px", minHeight: 40,
                  border: "1px solid #1976D2", borderRadius: 6,
                  background: feedbackSending || !feedbackText.trim() ? "#90CAF9" : "#1976D2",
                  color: "#fff",
                  cursor: feedbackSending || !feedbackText.trim() ? "default" : "pointer",
                  fontFamily: "inherit", fontWeight: 600, flex: 1,
                }}
              >
                {feedbackSending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Persistent Go-trip bar: keeps the committed trip one tap away
          while the rider browses the All/Map tabs. Live stops-away count
          when the pinned bus is trackable; plain label otherwise. */}
      {goTrip && !boardedRide && listView !== "trip" && (() => {
        let liveNote: string | null = null;
        const cfg = ROUTE_LISTS.find((c) => c.label === goTrip.routeLabel);
        if (cfg) {
          const allStops: number[] = [];
          const seen = new Set<number>();
          for (const rid of cfg.routeIds) {
            for (const sid of (routeStops[rid] ?? [])) {
              if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
            }
          }
          const bi = allStops.indexOf(goTrip.boardStopId);
          const norm = (s: string) => s.replace(/^#/, "");
          const bus = bi >= 0 ? buses.find((b) =>
            norm(b.bus_name) === norm(goTrip.busName) &&
            cfg.busRouteIds.includes(b.route_id) &&
            isBusOnRoute(b, allStops, stopCoords),
          ) : undefined;
          if (bus) {
            const busIdx = findRouteAnchor(bus, allStops, stopCoords);
            if (busIdx >= 0) {
              const away = (bi - busIdx + allStops.length) % allStops.length;
              liveNote = away === 0 ? "bus at your stop" : `bus ${away} stop${away === 1 ? "" : "s"} away`;
            }
          }
        }
        return (
          <div
            onClick={() => setListView("trip")}
            role="button"
            tabIndex={0}
            style={{
              position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)",
              zIndex: 9998, background: "#1a1a2e", color: "#fff",
              borderRadius: 999, padding: "10px 18px",
              display: "flex", alignItems: "center", gap: 10,
              boxShadow: "0 4px 20px rgba(0,0,0,0.35)", cursor: "pointer",
              maxWidth: "calc(100% - 32px)",
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: goTrip.color, flexShrink: 0 }} />
            <span style={{
              fontSize: 13, fontWeight: 600,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {goTrip.routeLabel}{liveNote ? ` · ${liveNote}` : " trip in progress"} — tap to return
            </span>
          </div>
        );
      })()}
    </div>
  );
};

export default TransitMap;
