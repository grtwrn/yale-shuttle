import { describe, expect, it } from "vitest";

import { routes as SCHEMATIC_ROUTES } from "./map-data";
import {
  LEGEND_ROUTES, mergedRouteStops, ROUTE_COLOR, ROUTE_COLOR_BY_BUS_ID,
  ROUTE_ID_LABEL, ROUTE_LISTS,
} from "./routes";
import type { RouteListConfig } from "./routes";
import { ROUTE_HOURS } from "./schedule";

// A snapshot of `GET https://yale.downtownerapp.com/routes_routes.php?inactive=true`
// taken 2026-08-31, reduced to the identity fields (the stop lists and
// polylines are upstream's and are never hand-maintained, so they are not
// pinned here). ROUTE_LISTS is hand-written and drifts silently against this:
// a renumbered route, a retired one, or a label copy-pasted onto the wrong id
// all look fine to the compiler. These tests are the tripwire.
//
// When upstream genuinely changes, update this snapshot AND ROUTE_LISTS in the
// same commit — re-fetch with:
//   curl -s 'https://yale.downtownerapp.com/routes_routes.php?inactive=true'
const UPSTREAM_ROUTES: { id: number; name: string; shortName: string; color: string }[] = [
  { id: 1,  name: "Blue - Weekday Daytime",             shortName: "BD",              color: "4472C4" },
  { id: 2,  name: "Orange - Weekday Daytime",           shortName: "OD",              color: "ED7D31" },
  { id: 3,  name: "Red - Weekday Daytime",              shortName: "RD",              color: "FF0000" },
  { id: 4,  name: "Blue - Weekend Daytime",             shortName: "BW",              color: "4472C4" },
  { id: 6,  name: "Weekend Grocery (to Trader Joes)",   shortName: "GROC1",           color: "000000" },
  { id: 8,  name: "Pink - VA Hospital / Med School",    shortName: "PINK",            color: "DB1AD2" },
  { id: 9,  name: "Green - West Campus",                shortName: "GRN",             color: "70AD46" },
  { id: 10, name: "Purple - West Campus",               shortName: "PRPL",            color: "6F30A1" },
  { id: 13, name: "Blue - Night",                       shortName: "BN",              color: "4472C4" },
  { id: 14, name: "Orange - Night",                     shortName: "ON",              color: "ED7D31" },
  { id: 15, name: "Gold Route",                         shortName: "GOLD",            color: "FCE36C" },
  { id: 16, name: "Blue West",                          shortName: "BW",              color: "3498DB" },
  { id: 17, name: "Orange East",                        shortName: "OE",              color: "FFB668" },
  { id: 18, name: "Weekend Grocery (to Hamden)",        shortName: "GROC2",           color: "000000" },
  { id: 19, name: "Brown Connector",                    shortName: "Brown Connector", color: "8E664D" },
];

// The colour family each label claims, and the word that must therefore appear
// in upstream's name for that id. This is what catches a label pinned to the
// wrong number — the failure mode that renders a Green bus as a Purple one.
const LABEL_KEYWORD: Record<string, RegExp> = {
  "Red": /red/i,
  "Blue Day": /^blue - weekday/i,
  "Blue Weekend": /^blue - weekend/i,
  "Blue Night": /^blue - night/i,
  "Blue West": /^blue west/i,
  "Orange Day": /^orange - weekday/i,
  "Orange Night": /^orange - night/i,
  "Orange East": /^orange east/i,
  "Brown": /brown/i,
  "Pink": /pink/i,
  "Green": /green/i,
  "Purple": /purple/i,
  "Gold": /gold/i,
  "Grocery TJ": /grocery.*trader/i,
  "Grocery Ham": /grocery.*hamden/i,
};

const upstreamById = new Map(UPSTREAM_ROUTES.map((r) => [r.id, r]));

describe("ROUTE_LISTS vs the upstream route roster", () => {
  it("references only route ids upstream actually serves", () => {
    for (const cfg of ROUTE_LISTS) {
      for (const rid of cfg.busRouteIds) {
        expect(upstreamById.has(rid), `${cfg.label}: busRouteId ${rid} is not an upstream route`).toBe(true);
      }
      for (const rid of cfg.routeIds) {
        expect(
          upstreamById.has(Number(rid)),
          `${cfg.label}: routeId "${rid}" is not an upstream route`,
        ).toBe(true);
      }
    }
  });

  it("covers every upstream route exactly once", () => {
    const covered = ROUTE_LISTS.flatMap((c) => c.busRouteIds);
    expect([...covered].sort((a, b) => a - b)).toEqual(UPSTREAM_ROUTES.map((r) => r.id));
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("keeps routeIds and busRouteIds describing the same routes", () => {
    // They are separate fields (one indexes `payload.routes`, keyed by string;
    // the other matches `bus.route_id`, a number) but they must never disagree
    // — a bus would then be drawn against another line's stop sequence.
    for (const cfg of ROUTE_LISTS) {
      expect(cfg.routeIds.map(Number).sort((a, b) => a - b), cfg.label)
        .toEqual([...cfg.busRouteIds].sort((a, b) => a - b));
    }
  });

  it("attaches each label to the id whose upstream name matches", () => {
    for (const [rid, label] of Object.entries(ROUTE_ID_LABEL)) {
      const upstream = upstreamById.get(Number(rid));
      expect(upstream, `route ${rid}`).toBeDefined();
      const keyword = LABEL_KEYWORD[label];
      expect(keyword, `no keyword rule for label "${label}"`).toBeDefined();
      expect(
        keyword!.test(upstream!.name),
        `route ${rid} is labelled "${label}" but upstream calls it "${upstream!.name}"`,
      ).toBe(true);
    }
  });

  it("gives every upstream route a label", () => {
    for (const r of UPSTREAM_ROUTES) {
      expect(ROUTE_ID_LABEL[r.id], `route ${r.id} (${r.name}) has no label`).toBeDefined();
    }
  });
});

// ── Colour invariants ──────────────────────────────────────────────────────
//
// Two failures kept recurring and both are pinned here:
//
//  1. Two lines that run at the same time shared a colour. Orange Day, Orange
//     Night and Orange East were all #E65100 while Orange Night and Orange
//     East both run 18:00–01:00 daily, so the two lines a rider actually has
//     to choose between every evening looked identical. Fixed 2026-08-31; the
//     old allow-list for it is gone.
//  2. The palette was written out by hand in several places (a `legendRoutes`
//     array in TransitMap.tsx, a `routeColorMap` and 21 polyline literals in
//     map-data.ts), so fixing one left the others disagreeing — a legend chip
//     in a colour its own polyline didn't use. Everything now derives from
//     ROUTE_LISTS; these tests fail if a second table ever reappears.
//
// "Runs at the same time" is computed from ROUTE_HOURS rather than listed, so
// a schedule change re-derives the constraint instead of silently outdating a
// hardcoded pair list.

/** Absolute minutes-of-week a route is in service, per ROUTE_HOURS. */
function serviceMinutes(label: string): Set<number> {
  const out = new Set<number>();
  const wins = ROUTE_HOURS[label];
  if (!wins) return out;
  for (const w of wins) {
    for (const day of w.days) {
      // endMin > 1440 spills into the next day; the modulo wraps Sat → Sun.
      for (let t = w.startMin; t < w.endMin; t++) out.add((day * 1440 + t) % 10080);
    }
  }
  return out;
}

function overlaps(a: Set<number>, b: Set<number>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) return true;
  return false;
}

describe("ROUTE_LISTS colours", () => {
  it("are all opaque 6-digit hex", () => {
    for (const cfg of ROUTE_LISTS) {
      expect(cfg.color, cfg.label).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("gives every route a distinct label", () => {
    const labels = ROUTE_LISTS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has a published schedule for every route, so simultaneity is decidable", () => {
    // Without this, a route missing from ROUTE_HOURS would silently opt out of
    // the collision test below (`isRouteActiveAt` treats it as always-running).
    for (const cfg of ROUTE_LISTS) {
      expect(ROUTE_HOURS[cfg.label], `${cfg.label} has no ROUTE_HOURS window`).toBeDefined();
      expect(serviceMinutes(cfg.label).size, cfg.label).toBeGreaterThan(0);
    }
  });

  it("never gives two simultaneously-running routes the same colour", () => {
    const mins = new Map(ROUTE_LISTS.map((c) => [c.label, serviceMinutes(c.label)]));
    const clashes: string[] = [];
    for (let i = 0; i < ROUTE_LISTS.length; i++) {
      for (let j = i + 1; j < ROUTE_LISTS.length; j++) {
        const a = ROUTE_LISTS[i], b = ROUTE_LISTS[j];
        if (a.color.toUpperCase() !== b.color.toUpperCase()) continue;
        if (!overlaps(mins.get(a.label)!, mins.get(b.label)!)) continue;
        clashes.push(`${a.label} and ${b.label} are both ${a.color} and both run at once`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("gives all 15 routes distinct colours", () => {
    // Stricter than the rule above, and the one the legend needs: all 15 chips
    // are on screen together whatever the hour.
    const byColor = new Map<string, string[]>();
    for (const cfg of ROUTE_LISTS) {
      const key = cfg.color.toUpperCase();
      byColor.set(key, [...(byColor.get(key) ?? []), cfg.label]);
    }
    const collisions = [...byColor.entries()]
      .filter(([, labels]) => labels.length > 1)
      .map(([color, labels]) => `${labels.join(" / ")} share ${color}`);
    expect(collisions).toEqual([]);
  });

  it("keeps the two evening orange lines apart", () => {
    // The regression this file exists for: these two are the only pair a rider
    // has to tell apart on every single evening trip.
    expect(ROUTE_COLOR["Orange Night"]).not.toBe(ROUTE_COLOR["Orange East"]);
    expect(overlaps(serviceMinutes("Orange Night"), serviceMinutes("Orange East"))).toBe(true);
  });
});

describe("every colour table derives from ROUTE_LISTS", () => {
  it("ROUTE_COLOR matches ROUTE_LISTS", () => {
    expect(ROUTE_COLOR).toEqual(
      Object.fromEntries(ROUTE_LISTS.map((c) => [c.label, c.color])),
    );
  });

  it("ROUTE_COLOR_BY_BUS_ID covers every upstream route with its list colour", () => {
    for (const cfg of ROUTE_LISTS) {
      for (const rid of cfg.busRouteIds) {
        expect(ROUTE_COLOR_BY_BUS_ID[rid], `route ${rid} (${cfg.label})`).toBe(cfg.color);
      }
    }
    expect(Object.keys(ROUTE_COLOR_BY_BUS_ID).length).toBe(UPSTREAM_ROUTES.length);
  });

  it("LEGEND_ROUTES has one chip per route, in order, in the route's colour", () => {
    expect(LEGEND_ROUTES.length).toBe(ROUTE_LISTS.length);
    LEGEND_ROUTES.forEach((chip, i) => {
      const cfg = ROUTE_LISTS[i];
      expect(chip.color, `legend chip "${chip.label}"`).toBe(cfg.color);
      expect(chip.label.length, `legend chip for ${cfg.label}`).toBeGreaterThan(0);
    });
    // Toggle keys group lines under one filter switch, so they may repeat only
    // where that is intended — but a chip must always have one.
    for (const chip of LEGEND_ROUTES) expect(chip.toggleLabel.length).toBeGreaterThan(0);
  });

  // Which ROUTE_LISTS line each schematic polyline in map-data.ts draws. The
  // polylines split a line into directional halves ("Red NB" / "Red SB"), so
  // their own `label` can't be matched to ROUTE_LISTS directly. Pinning the
  // mapping here is what makes a wrong-but-plausible colour (say, the route-4
  // spur painted in Blue Day's blue, which is exactly what it used to be) a
  // test failure rather than a silent drift.
  const SCHEMATIC_LINE: Record<string, string> = {
    red_nb_south: "Red", red_nb: "Red", red_sb: "Red", red_loop: "Red",
    blue_day_nb: "Blue Day", blue_day_sb: "Blue Day",
    blue_night_nb: "Blue Night", blue_night_sb: "Blue Night",
    orange_day_out: "Orange Day", orange_day_ret: "Orange Day",
    orange_night: "Orange Night", orange_east: "Orange East",
    blue_r4: "Blue Weekend", blue_west: "Blue West",
    brown: "Brown", pink: "Pink", green: "Green", purple: "Purple",
    gold: "Gold", grocery_tj: "Grocery TJ", grocery_ham: "Grocery Ham",
  };

  it("draws every schematic polyline in its own line's ROUTE_LISTS colour", () => {
    for (const r of SCHEMATIC_ROUTES) {
      const line = SCHEMATIC_LINE[r.id];
      expect(line, `schematic route "${r.id}" is not mapped to a ROUTE_LISTS line`).toBeDefined();
      // One polyline is drawn translucent (an 8-digit #RRGGBBAA).
      const base = r.color.slice(0, 7).toUpperCase();
      expect(base, `schematic route "${r.id}" (${line}) uses ${r.color}`)
        .toBe(ROUTE_COLOR[line].toUpperCase());
      expect(r.color.length === 7 || r.color.length === 9, `${r.id}: ${r.color}`).toBe(true);
    }
  });

  it("maps every schematic polyline exactly once", () => {
    expect(SCHEMATIC_ROUTES.map((r) => r.id).sort())
      .toEqual(Object.keys(SCHEMATIC_LINE).sort());
  });
});

describe("mergedRouteStops", () => {
  const cfgFor = (routeIds: string[]): RouteListConfig => ({
    routeIds, busRouteIds: routeIds.map(Number), label: "T", color: "#000000",
  });

  // Upstream's real route 9 (Green) sequence, 2026-08-31. Buildings 600/800/900
  // appear twice because the bus runs down the West Campus spur and back up.
  const GREEN_9 = [78, 84, 89, 77, 94, 143, 144, 133, 88, 92, 81, 26, 25, 23, 22, 23, 24, 25, 127, 26, 80, 91, 87];
  // Upstream's real route 10 (Purple): the whole return leg is a repeat.
  const PURPLE_10 = [10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 72];

  it("keeps a single route's sequence verbatim, out-and-back repeats included", () => {
    expect(mergedRouteStops(cfgFor(["9"]), { "9": GREEN_9 })).toEqual(GREEN_9);
    expect(mergedRouteStops(cfgFor(["10"]), { "10": PURPLE_10 })).toEqual(PURPLE_10);
  });

  it("does not invent hops no bus ever makes", () => {
    // The de-duplicating version produced 22→24 and 24→127 on Green and 22→72
    // on Purple. None of those pairs appears once in 90 days of `segments`,
    // while the real 23→22 and 127→26 have thousands of observations.
    const hops = (seq: number[]) =>
      new Set(seq.map((s, i) => `${s}-${seq[(i + 1) % seq.length]}`));
    const green = hops(mergedRouteStops(cfgFor(["9"]), { "9": GREEN_9 }));
    expect(green.has("22-24")).toBe(false);
    expect(green.has("24-127")).toBe(false);
    expect(green.has("23-22")).toBe(true);
    const purple = hops(mergedRouteStops(cfgFor(["10"]), { "10": PURPLE_10 }));
    expect(purple.has("22-72")).toBe(false);
    expect(purple.has("127-26")).toBe(true);
  });

  it("de-duplicates only across stitched route ids", () => {
    const stops = mergedRouteStops(cfgFor(["1", "2"]), {
      "1": [10, 20, 30, 20],
      "2": [30, 40, 10, 50],
    });
    // Route 1 verbatim (its 20 repeat survives), then only route 2's new stops.
    expect(stops).toEqual([10, 20, 30, 20, 40, 50]);
  });

  it("survives a route id the payload has not delivered yet", () => {
    expect(mergedRouteStops(cfgFor(["99"]), {})).toEqual([]);
    expect(mergedRouteStops(cfgFor(["99", "1"]), { "1": [1, 2, 1] })).toEqual([1, 2, 1]);
  });

  it("returns the live sequence for every configured route", () => {
    // Nothing in ROUTE_LISTS may reference a route whose stops the payload
    // never carries — that route would silently vanish from the planner.
    const routeStops = Object.fromEntries(
      UPSTREAM_ROUTES.map((r) => [String(r.id), [r.id * 10, r.id * 10 + 1]]),
    );
    for (const cfg of ROUTE_LISTS) {
      expect(mergedRouteStops(cfg, routeStops).length, cfg.label).toBeGreaterThan(1);
    }
  });
});
