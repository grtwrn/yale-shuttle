import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ARRIVAL_CLOCK_RE, ARRIVAL_M, brokenPromise, bucketOf, busOnRoute, CANARY_LINES, CANONICAL_MAX_WALK_M,
  CANONICAL_TRIP, conservativeDrift, deadlineForPromise, DEPARTURE_M,
  departureBetween, fleetOffAir, hasArrivalClock, haversineM, isAtBoardStop, isTransportNoise, liveBusesOf, MAX_WALK_M, MIN_RIDE_M, NEAR_STOP_M,
  pinnedVehicleAt, reachedBoardStop, scraperMissedTheCountdown, standEndedFor, standPollsBefore, unexplainedJumps,
  OFF_ROUTE_M, pairBuses, parseBusEtaText, parseOptions, parseWaitFallback, runVerdict,
  scoreSequence, THRESHOLDS, tripForLine,
} from "./canary-metrics.mjs";

/**
 * Blue Night as the canary saw it on Sun 2026-09-06: the Whitney Ave stops
 * the line serves (real coordinates), a polyline down Whitney between them,
 * and #57 where the feed had it at 17:42 ET — Whitney Ave in Hamden,
 * 4 km north of Peabody, reporting route 13 and a stale last_stop_id of
 * Prospect / Sachem (N). `at` moves the bus.
 */
const BLUE_NIGHT = CANARY_LINES.find((l) => l.label === "Blue Night");
const BLUE_NIGHT_PAYLOAD = (at = { lat: 41.3531, lon: -72.9247 }) => ({
  buses: [{ bus_id: 66036, bus_name: "#57", route_id: 13, lat: at.lat, lon: at.lon, last_stop_id: 106 }],
  routes: { 13: [106, 97, 96, 67, 43] },
  route_paths: { 13: [[41.3172, -72.9247], [41.315675, -72.920859], [41.3121, -72.9243], [41.3095, -72.9282], [41.30199, -72.933299]] },
  stop_coords: {
    106: { lat: 41.3172, lon: -72.9247 }, 97: { lat: 41.315675, lon: -72.920859 },
    96: { lat: 41.3121, lon: -72.9243 }, 67: { lat: 41.3095, lon: -72.9282 }, 43: { lat: 41.30199, lon: -72.933299 },
  },
  stop_names: {
    106: "Prospect / Sachem (N)", 97: "Peabody Museum / Whitney / Sachem", 96: "Payne Whitney Gym",
    67: "Wall / York", 43: "Congress / Cedar",
  },
});

describe("bucketOf", () => {
  it("maps every token fmtMin can print", () => {
    expect(bucketOf("now")).toEqual([0, 10]);
    expect(bucketOf("<1")).toEqual([10, 60]);
    expect(bucketOf("8")).toEqual([480, 540]);
    expect(bucketOf("0")).toEqual([0, 60]);
    expect(bucketOf("banana")).toBeNull();
  });
});

describe("parseBusEtaText", () => {
  it("reads every shape fmtBusPair produces", () => {
    expect(parseBusEtaText("🚌 arriving now").first).toEqual([0, 10]);
    expect(parseBusEtaText("🚌 now, then 16 min").second).toEqual([960, 1020]);
    expect(parseBusEtaText("🚌 in 8, 16 min")).toMatchObject({ first: [480, 540], second: [960, 1020] });
    expect(parseBusEtaText("🚌 in <1, 16 min").first).toEqual([10, 60]);
    expect(parseBusEtaText("🚌 in 8 min")).toMatchObject({ first: [480, 540], second: null });
  });

  it("reads the BUNCHED forms, where two buses print one statement", () => {
    // bunching.ts, the Orange Night case of 2026-09-10: slot 2's point was
    // inside slot 1's own interval, so the line says the interval once and
    // names the cause. There is no second slot to read.
    expect(parseBusEtaText("🚌 23-36 min · 2 buses")).toMatchObject({
      first: [1380, 2220], second: null, spread: true, bunched: true,
      raw: "23-36 min · 2 buses",
    });
    expect(parseBusEtaText("🚌 25 min · 2 buses")).toMatchObject({
      first: [1500, 1560], second: null, spread: false, bunched: true,
      raw: "25 min · 2 buses",
    });
    // "arriving now · 2 buses" is the same case at the kerb.
    expect(parseBusEtaText("🚌 arriving now · 2 buses")).toMatchObject({
      first: [0, 10], second: null, bunched: true,
    });
    // And every unbunched form says so, rather than leaving the flag undefined.
    expect(parseBusEtaText("🚌 in 8, 16 min").bunched).toBe(false);
  });

  it("reads the median-with-band form (etaBand.ts, 2026-09-11) as the band's interval, median beside it", () => {
    // "in 10 (6-18), 26 min": the interval is [6:00, 19:00) exactly as
    // "in 6-18, then 26 min" reads, and the median bucket rides alongside.
    expect(parseBusEtaText("🚌 in 10 (6-18), 26 min")).toMatchObject({
      first: [360, 1140], second: [1560, 1620], spread: true, bunched: false, median: [600, 660],
    });
    expect(parseBusEtaText("🚌 in 5 (2-9) min")).toMatchObject({ first: [120, 600], second: null, spread: true, median: [300, 360] });
    expect(parseBusEtaText("🚌 in 3 (now-6) min")).toMatchObject({ first: [0, 420], median: [180, 240] });
    expect(parseBusEtaText("🚌 in 3 (<1-6) min")).toMatchObject({ first: [10, 420] });
    // Bunched: the head drops its "in" like every other head.
    expect(parseBusEtaText("🚌 29 (23-36) min · 2 buses")).toMatchObject({
      first: [1380, 2220], second: null, spread: true, bunched: true, median: [1740, 1800],
    });
    expect(parseBusEtaText("🚌 in 5 (2-9) min").raw).toBe("in 5 (2-9) min");
    expect(parseBusEtaText("🚌 in 3-7, then 19 min").bunched).toBe(false);
  });

  it("refuses the card's SENTENCES, which also start with the bus emoji", () => {
    // Mistaking one of these for a countdown would invent a jump on the tick a
    // rider was actually being warned about.
    expect(parseBusEtaText("🚌 You can't catch #40 — showing the next bus:")).toBeNull();
    expect(parseBusEtaText("🚌 The bus is at your stop — you won't arrive in time, check for the next shuttle")).toBeNull();
  });
});

describe("parseWaitFallback", () => {
  it("reads the no-live-bus line", () => {
    expect(parseWaitFallback("⏳ wait 7 min for #40")).toEqual({ waitMin: 7, busName: "40" });
    expect(parseWaitFallback("⏳ wait 12 min for next shuttle")).toEqual({ waitMin: 12, busName: null });
    expect(parseWaitFallback("🚌 in 8 min")).toBeNull();
  });
});

describe("conservativeDrift", () => {
  const min = (n) => [n * 60, n * 60 + 60];

  it("is zero for a countdown ticking down normally", () => {
    expect(conservativeDrift(min(10), min(9), 60)).toBe(0);
    expect(conservativeDrift(min(10), min(10), 15)).toBe(0); // still inside the same minute
  });

  it("never invents a jump out of bucket edges", () => {
    // "8 min" -> "7 min" after only 5 s is entirely possible: the true value
    // could have been 480 (bucket floor) and gone to 479.
    expect(conservativeDrift(min(8), min(7), 5)).toBe(0);
  });

  it("reports the operator's complaint: 10 min to nothing in one tick", () => {
    // "10 min" -> "<1 min" 15 s later. Smallest possible fall is 660 -> 60.
    const drift = conservativeDrift(min(10), [10, 60], 15);
    expect(drift).toBe(-525);
    expect(Math.abs(drift)).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });

  it("reports report #32's reversal: 6 min then 16", () => {
    const drift = conservativeDrift(min(6), min(16), 15);
    expect(drift).toBe(555);
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });

  it("does not call the display's own floor a reversal", () => {
    // "arriving now" is the [0, 10) bucket. A card sitting there cannot fall
    // by the fifteen seconds that pass, so the naive expectation of
    // `prev - dt` is unreachable and every tick scored as a small rise. A Red
    // bus standing at Division/Prospect on 2026-09-04 produced a run of
    // +5..+8 s "reversals" this way — the floor, not a defect.
    const now = [0, 10];
    expect(conservativeDrift(now, now, 15)).toBe(0);
    expect(conservativeDrift(now, now, 60)).toBe(0);
    // A near-floor bucket behaves the same once the clamp bites.
    expect(conservativeDrift([10, 60], now, 60)).toBe(0);
    // But a genuine rise off the floor is still a rise.
    expect(conservativeDrift(now, [600, 660], 15)).toBe(600);
  });

  it("gives +15 s for a bare one-minute step up at a 15 s sample", () => {
    // This is the floor the notable-reversal threshold is set above: a single
    // minute gained is real but common; a whole minute gained ON TOP of the
    // elapsed time is what riders write in about.
    expect(conservativeDrift(min(8), min(9), 15)).toBe(15);
    expect(conservativeDrift(min(8), min(9), 15)).toBeLessThan(THRESHOLDS.notableReversalSec);
    expect(conservativeDrift(min(8), min(10), 15)).toBeGreaterThanOrEqual(THRESHOLDS.notableReversalSec);
  });
});

describe("parseOptions", () => {
  // Captured from the live site, 2026-09-03 16:49 ET, geolocation at
  // Prospect/Canner with School of Public Health as the destination.
  const LIVE = `YALE SHUTTLE
4:49 PM
Trip
Map
Issues
FROM
📍 Current location
TO
🏁 School of Public Health (YSPH)
WHEN
Now
☁️
79°F · no rain · cooling to 70° by 12am
OVERVIEW — TOP 2 OF 4 ROUTES
🚌
🚌 (B) 8 min
 (R) 16 min
🏁 (B) 5:12p
 (R) 5:18p
Blue Day
Red
23 min
🚌 in 8, 16 min
arrive 5:13p
›
🚶 8 min
›
Blue Day
›
🚶 1 min
29 min
🚌 in 16, 40 min
arrive 5:18p
›
🚶 1 min
›
Red
›
🚶 1 min
38 min
arrive 5:27p
›
🚶 Walk
Show 2 more routes
Clear`;

  it("reads each card off the real page text", () => {
    const opts = parseOptions(LIVE);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Red", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 23, arriveText: "5:13p", walkToMin: 8, walkFromMin: 1 });
    expect(opts[0].eta.first).toEqual([480, 540]);
    expect(opts[1].eta.second).toEqual([2400, 2460]);
    expect(opts[2]).toMatchObject({ mode: "walk", totalMin: 38 });
  });

  it("ignores the map overview's own '16 min', which is not a card", () => {
    // The overview line " (R) 16 min" sits above the list; a card is only a
    // card when it quotes an arrival clock.
    expect(parseOptions(LIVE)).toHaveLength(3);
  });

  // The SAME page after the 2026-09-04 card redesign: the route pill leads
  // the card (top-left) with the countdown beside it, so both now sit ABOVE
  // the duration instead of below it. Captured from a phone-sized browser on
  // a frozen /api/buses payload, Prospect/Canner -> LEPH/60 College.
  const LIVE_LINE_FIRST = `OVERVIEW — ALL 4 ROUTES
▴
🚌
🚌
🚌
🚌
🚌 (O) 15 min
🏁 (B) 10:33a
 (O) 10:39a
 (R) 10:47a
🚌 (B) 3 min
 (R) 25 min
 (B) 36 min
🏁 (B) 11:08a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Blue Day
Orange Day
Red
Brown
Blue Day
🚌 in 3, 21 min
23 min
arrive 10:33a
›
Orange Day
🚌 in 15, 39 min
29 min
arrive 10:39a
·
🚶 16 min
›
›
Red
🚌 in 25, 31 min
37 min
arrive 10:47a
·
🚶 1 min
›
· most direct
›
🚶 Walk
38 min
arrive 10:48a
›
Brown
🚌 in 36 min
68 min
arrive 11:17a
·
🚶 3 min
›
›
🚶 10 min
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads the redesigned card, whose pill sits above the duration", () => {
    const opts = parseOptions(LIVE_LINE_FIRST);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Orange Day", "Red", "Walk", "Brown"]);
    expect(opts[0]).toMatchObject({ totalMin: 23, arriveText: "10:33a", walkToMin: 0, walkFromMin: 0 });
    expect(opts[0].eta.raw).toBe("in 3, 21 min");
    expect(opts[1]).toMatchObject({ totalMin: 29, walkToMin: 16 });
    expect(opts[3]).toMatchObject({ mode: "walk", totalMin: 38 });
    // The last card runs into the page footer, and "Contribute" is exactly
    // as label-shaped as a route name.
    expect(opts[4]).toMatchObject({ routeLabel: "Brown", walkToMin: 3, walkFromMin: 10 });
  });

  // #111, later the same day, removed the 🚌 from that countdown so "in" could
  // follow the route pill directly. The parser had been taught the new ORDER
  // but not the new SHAPE: `startOf` accepted a bare countdown while the line
  // that yields the reading still demanded the glyph, so the canary read zero
  // countdowns for the twelve minutes after the deploy and reported the app
  // as offering no Red at all. Both shapes are fixtures now.
  const LIVE_NO_GLYPH = LIVE_LINE_FIRST
    .split("\n")
    .map((l) => (/^🚌 (in |now, then |arriving now)/.test(l) ? l.replace(/^🚌 /u, "") : l))
    .join("\n");

  it("reads the countdown after the 🚌 was dropped from it", () => {
    const opts = parseOptions(LIVE_NO_GLYPH);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Orange Day", "Red", "Walk", "Brown"]);
    expect(opts[0].eta.raw).toBe("in 3, 21 min");
    expect(opts[2].eta.raw).toBe("in 25, 31 min");
    expect(opts[4].eta.raw).toBe("in 36 min");
  });

  it("does not mistake the ride bar for the countdown", () => {
    // The expanded card carries "🚌 12 min" for the ride leg — glyph-prefixed,
    // minute-suffixed, and NOT a countdown. It has no "in", which is the whole
    // reason parseBusEtaText can be the single arbiter.
    const withRide = LIVE_NO_GLYPH.replace("arrive 10:47a", "arrive 10:47a\n🚌 12 min");
    const red = parseOptions(withRide).find((o) => o.routeLabel === "Red");
    expect(red.eta.raw).toBe("in 25, 31 min");
  });

  // The SAME page after the 2026-09-04 swap: the arrival clock left the head
  // of line 2 and became the RIGHT column of it, under the duration, so in the
  // innerText stream it now trails the walk/ride legs instead of leading them
  // (and the "·" that used to separate it from them is gone with it). The
  // parser reads a card as a SET of lines around its duration anchor, not as
  // an ordered one, so this needed no change to `parseOptions` — but #111 also
  // "needed no change" right up until it blinded the canary for twelve
  // minutes, so the claim is a fixture rather than an argument. Captured from
  // a phone-sized browser on a live /api/buses, Prospect/Canner -> LEPH/60
  // College.
  const LIVE_ARRIVAL_RIGHT = `YALE SHUTTLE
11:22 AM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.303422, -72.931698
☆
WHEN
Now
Plan for later…
☀️
77°F · no rain · cooling to 69° by 8pm
▾
°F
|
°C
OVERVIEW — ALL 4 ROUTES
▴
🚌
🚌
🚌
🚌
🏁 (B) 11:40a
 (R) 11:41a
 (O) 11:43a
🚌 (B) 3 min
 (R) 12 min
 (O) 8 min
 (B) 8 min
🏁 (B) 11:36a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Blue Day
Red
Orange Day
Brown
Blue Day
in 3, 11 min
18 min
arrive 11:40a
›
Red
in 12, 18 min
19 min
🚶 1 min
›
🚌 7 min
arrive 11:41a
›
Orange Day
in 8, 32 min
21 min
🚶 9 min
›
🚌 12 min
arrive 11:43a
›
Brown
in 8, 26 min
24 min
🚶 3 min
›
🚌 6 min
›
🚶 10 min
arrive 11:46a
›
🚶 Walk
38 min
arrive 12:00p
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads the card after the arrival clock moved under the duration", () => {
    const opts = parseOptions(LIVE_ARRIVAL_RIGHT);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Red", "Orange Day", "Brown", "Walk"]);
    // Every field the canary scores, off a card whose lines are in the new order.
    expect(opts[0]).toMatchObject({ totalMin: 18, arriveText: "11:40a", walkToMin: 0, walkFromMin: 0 });
    expect(opts[0].eta.raw).toBe("in 3, 11 min");
    expect(opts[1]).toMatchObject({ totalMin: 19, arriveText: "11:41a", walkToMin: 1 });
    expect(opts[1].eta.raw).toBe("in 12, 18 min");
    expect(opts[2]).toMatchObject({ totalMin: 21, arriveText: "11:43a", walkToMin: 9 });
    // Both walks, on the card that has them, still land in the right order —
    // the ride bar ("bus 6 min") sits between them and must not be counted.
    expect(opts[3]).toMatchObject({ totalMin: 24, arriveText: "11:46a", walkToMin: 3, walkFromMin: 10 });
    expect(opts[3].eta.raw).toBe("in 8, 26 min");
    expect(opts[4]).toMatchObject({ mode: "walk", totalMin: 38, arriveText: "12:00p" });
  });

  // Later the same day: the leg list stopped requiring a walk. A trip with no
  // walk at either end still has a RIDE, and gating the whole block on
  // "walkTo > 0 || walkFrom > 0" left such a card with a blank second line.
  // So a card can now carry a bare "bus N min" as the FIRST line after its
  // duration — where the countdown would sit if the countdown were below the
  // duration, which is the shape this parser read before 2026-09-04. Blue Day
  // below is that card. It is the ride-bar-vs-countdown collision the suite
  // already guards, arriving from a new direction, so it gets a real capture:
  // the countdown is found in `pre` (above the duration) before the ride bar
  // in `post` is ever considered, and the ride bar parses as no countdown at
  // all because it has no "in".
  const LIVE_RIDE_WITHOUT_WALKS = `YALE SHUTTLE
11:44 AM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.303422, -72.931698
☆
WHEN
Now
Plan for later…
☀️
77°F · no rain · cooling to 69° by 8pm
▾
°F
|
°C
OVERVIEW — ALL 4 ROUTES
▴
🚌
🚌
🚌
🚌
🏁 (B) 12:07p
🚌 (R) 1 min
 (B) 7 min
 (B) 16 min
 (O) 22 min
🏁 (R) 11:53a
 (B) 12:04p
 (O) 12:18p
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Red
Blue Day
Brown
Orange Day
Red
in 1, 7 min
8 min
🚶 1 min
›
🚌 7 min
arrive 11:53a
›
Blue Day
in 7, 12 min
20 min
🚌 12 min
arrive 12:04p
›
Brown
in 16, 34 min
32 min
🚶 3 min
›
🚌 6 min
›
🚶 10 min
arrive 12:16p
›
Orange Day
in 22, 22 min
34 min
🚶 9 min
›
🚌 12 min
arrive 12:18p
›
🚶 Walk
38 min
arrive 12:22p
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads a card whose only leg is the ride", () => {
    const opts = parseOptions(LIVE_RIDE_WITHOUT_WALKS);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Blue Day", "Brown", "Orange Day", "Walk"]);
    // The card with no walks: its countdown must be the pinned pair, NOT the
    // "bus 12 min" ride bar sitting directly under its duration.
    const blue = opts[1];
    expect(blue).toMatchObject({ totalMin: 20, arriveText: "12:04p", walkToMin: 0, walkFromMin: 0 });
    expect(blue.eta.raw).toBe("in 7, 12 min");
    // And the cards that do have walks are unchanged by it.
    expect(opts[0]).toMatchObject({ totalMin: 8, arriveText: "11:53a", walkToMin: 1, walkFromMin: 0 });
    expect(opts[2]).toMatchObject({ totalMin: 32, arriveText: "12:16p", walkToMin: 3, walkFromMin: 10 });
    expect(opts[3]).toMatchObject({ totalMin: 34, arriveText: "12:18p", walkToMin: 9 });
    expect(opts[4]).toMatchObject({ mode: "walk", totalMin: 38, arriveText: "12:22p" });
  });

  // 2026-09-04, later still: the word "arrive" is gone (operator: "remove
  // 'arrive' from arrival time and just show the time"). That word was how
  // `parseOptions` RECOGNISED a card at all — `if (!arrive && lines[h] !==
  // "Departed") continue` — so shipping it without the parser would have
  // dropped every card on the page, which is the exact blindness of #111.
  //
  // The bare pattern is anchored at both ends, and this capture is the proof
  // it collides with nothing: the map overview quotes the SAME clock values
  // ("(B) 12:31p" is Blue Day's own arrival) but every one of its lines
  // carries a route prefix, and the page header reads "12:13 PM" — space,
  // upper case. Five lines on the whole page match, and they are the five
  // cards.
  const LIVE_BARE_CLOCK = `YALE SHUTTLE
12:13 PM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.303422, -72.931698
☆
WHEN
Now
Plan for later…
☀️
78°F · Clear · no rain expected
▾
°F
|
°C
OVERVIEW — ALL 4 ROUTES
▴
🚌
🚌
🚌
🚌
🏁 (R) 12:27p
 (B) 12:31p
 (O) 12:34p
🚌 (R) 6 min
 (B) 4 min
 (O) 8 min
 (B) 10 min
🏁 (B) 12:30p
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Red
Blue Day
Orange Day
Brown
Red
in 6, 14 min
14 min
🚶 1 min
›
🚌 7 min
12:27p
›
Blue Day
in 4, 7 min
17 min
🚌 12 min
12:31p
›
Orange Day
in 8, 31 min
20 min
🚶 9 min
›
🚌 12 min
12:34p
›
Brown
in 10, 28 min
26 min
🚶 3 min
›
🚌 6 min
›
🚶 10 min
12:40p
›
🚶 Walk
38 min
12:52p
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("is recognised by the predicate `openCard` taps on, too", () => {
    // TWO readers, one page. `parseOptions` finds the cards; `openCard` in
    // rider-canary.mjs must find the same rows to tap for the pinned bus and
    // the board stop. On THIS text they disagreed for 25 minutes on
    // 2026-09-04 — `openCard` kept its own copy of the pattern and still
    // required the word #123 had removed — and the canary recorded
    // `board: null`, `pins: []` and a null distance on every bus, then filed
    // `no-arrival` off ground truth it never had. One exported pattern now,
    // and this fails if the two ever drift apart again.
    expect(hasArrivalClock(LIVE_BARE_CLOCK)).toBe(true);
    const clocks = LIVE_BARE_CLOCK.split("\n").map((l) => l.trim())
      .filter((l) => ARRIVAL_CLOCK_RE.test(l));
    // One per card, and the parser finds exactly as many cards.
    expect(clocks.length).toBe(parseOptions(LIVE_BARE_CLOCK).length);
    expect(clocks.every((c) => !/arrive/i.test(c))).toBe(true);
  });

  it("reads the card after the word 'arrive' was dropped from the clock", () => {
    const opts = parseOptions(LIVE_BARE_CLOCK);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Blue Day", "Orange Day", "Brown", "Walk"]);
    expect(opts.map((o) => o.arriveText))
      .toEqual(["12:27p", "12:31p", "12:34p", "12:40p", "12:52p"]);
    expect(opts[0]).toMatchObject({ totalMin: 14, walkToMin: 1, walkFromMin: 0 });
    expect(opts[0].eta.raw).toBe("in 6, 14 min");
    expect(opts[1]).toMatchObject({ totalMin: 17, walkToMin: 0, walkFromMin: 0 });
    expect(opts[3]).toMatchObject({ totalMin: 26, walkToMin: 3, walkFromMin: 10 });
    expect(opts[4]).toMatchObject({ mode: "walk", totalMin: 38 });
  });

  it("finds the clock ONLY on the cards, never in the map overview above them", () => {
    // The overview prints the same times with a route prefix, and the header
    // prints a third one in another format. Anchoring is what separates them,
    // so this asserts the count over the whole page rather than per card.
    const clockish = LIVE_BARE_CLOCK.split("\n").map((l) => l.trim())
      .filter((l) => /^(?:arrive\s+)?\d{1,2}:\d{2}[ap]$/i.test(l));
    expect(clockish).toEqual(["12:27p", "12:31p", "12:34p", "12:40p", "12:52p"]);
    // The lines it must NOT take, quoted from the same capture.
    for (const near of ["\u{1F3C1} (R) 12:27p", "(B) 12:31p", "(O) 12:34p", "12:13 PM"]) {
      expect(/^(?:arrive\s+)?\d{1,2}:\d{2}[ap]$/i.test(near)).toBe(false);
    }
  });

  it("still reads the 'arrive ...' spelling production is serving", () => {
    // The canary watches production, which is a deploy behind this branch.
    // Both spellings must parse until the new one has shipped everywhere.
    const old = LIVE_BARE_CLOCK.replace(/^(\d{1,2}:\d{2}[ap])$/gm, "arrive $1");
    expect(parseOptions(old).map((o) => o.arriveText))
      .toEqual(["12:27p", "12:31p", "12:34p", "12:40p", "12:52p"]);
  });

  it("does not take the map overview's legend for the first card's line", () => {
    // The legend lists every drawn route immediately above the first card, so
    // the walk-back that finds the pill must stop after one label.
    expect(parseOptions(LIVE_LINE_FIRST)[0].routeLabel).toBe("Blue Day");
  });

  it("reads a departed card and its missed-bus warning", () => {
    const text = `Departed
🚶 1 min
›
Red
›
🚶 1 min
🚌 The bus will reach your stop before you arrive — check for the next shuttle
Find next bus
14 min
🚌 You can't catch #40 — showing the next bus:
🚌 in 9 min
arrive 5:40p
›
Blue Day
›
🚶 2 min`;
    const opts = parseOptions(text);
    expect(opts[0]).toMatchObject({ departed: true, routeLabel: "Red", totalMin: null });
    expect(opts[1]).toMatchObject({ routeLabel: "Blue Day", missedBus: "40" });
    expect(opts[1].eta.first).toEqual([540, 600]);
  });
});

describe("scoreSequence", () => {
  const at = (s) => 1_700_000_000_000 + s * 1000;
  const sample = (t, raw, extra = {}) => ({
    atMs: at(t), present: true, eta: parseBusEtaText(raw), missedBus: null, ...extra,
  });

  it("stays silent on a healthy countdown", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 10 min"), sample(60, "🚌 in 9 min"),
      sample(120, "🚌 in 8 min"), sample(180, "🚌 in 7 min"),
    ]);
    expect(r.transitions).toHaveLength(0);
    expect(r.readings).toBe(4);
    expect(r.worstDriftSec).toBe(0);
  });

  it("catches the drop the operator described", () => {
    const r = scoreSequence([sample(0, "🚌 in 10 min"), sample(15, "🚌 arriving now")]);
    expect(r.catastrophic).toBe(1);
    expect(r.transitions[0].driftSec).toBeLessThan(0);
    expect(r.transitions[0].reversal).toBe(false);
  });

  it("marks a jump the app itself explained by swapping vehicles", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 1 min"),
      sample(15, "🚌 in 12 min", { missedBus: "40" }),
    ]);
    // This IS a change of cast — "you can't catch #40, showing the next bus"
    // — so pairing reads it as one: the 1-min bus leaves, a 12-min bus takes
    // the head of the list. It used to be a single +615 s reversal, which
    // said the same thing less precisely. The app's own announcement is
    // carried on every kind, so a finding can still say it was explained.
    expect(r.events.map((e) => e.kind).sort()).toEqual(["appeared", "dropped"]);
    expect(r.events.every((e) => e.pinAnnouncedChange)).toBe(true);
    expect(r.drops[0]).toMatchObject({ severe: true, leader: true, lastShownEtaSec: 60 });
  });

  it("does not compare across a gap where the option vanished", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 10 min"),
      { atMs: at(15), present: false, eta: null, missedBus: null },
      sample(30, "🚌 in 1 min"),
    ]);
    expect(r.transitions).toHaveLength(0);
  });

  it("does not compare readings further apart than the gap ceiling", () => {
    const r = scoreSequence([sample(0, "🚌 in 10 min"), sample(600, "🚌 in 20 min")]);
    expect(r.transitions).toHaveLength(0);
  });

  // ── the three transitions the metric used to get wrong ──────────────────
  //
  // All three are verbatim from the archived runs
  // (scripts/.canary/runs.jsonl, 57 runs to 2026-09-04). Under the old
  // positional comparison every one of them scored past 3200 s and was filed
  // as the same "catastrophic" defect. Two of them ARE a defect; the first is
  // not, and lumping them together is what hid the difference.
  const pair = (a, b, dt) => scoreSequence([sample(0, `🚌 ${a}`), sample(dt, `🚌 ${b}`)]);

  it("scores a re-sorted list as the near-nothing it is", () => {
    // Orange Night. The app can print the two buses out of ETA order — the
    // pinned countdown and the bus-after-it come from different computations
    // — so the 45-min bus led the line and then trailed it. Positionally that
    // was -2265 s in 15 s; by vehicle both buses moved about a second.
    const r = pair("in 45, 5 min", "in 6, 44 min", 15);
    expect(r.dropped).toBe(0);
    expect(r.appeared).toBe(0);
    expect(r.catastrophic).toBe(0);
    expect(r.worstDriftSec).toBeLessThan(THRESHOLDS.notableReversalSec);
  });

  it("names the imminent bus leaving the list as a severe drop, not a drift", () => {
    // Brown, +3255 s positionally. The 57-min bus is untouched; the one the
    // rider had stood up for is simply gone.
    const r = pair("in 1, 57 min", "in 56 min", 15);
    expect(r.catastrophic).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.droppedSevere).toBe(1);
    expect(r.drops[0]).toMatchObject({
      kind: "dropped", leader: true, severe: true, lastShownEtaSec: 60,
      from: "in 1, 57 min", to: "in 56 min",
    });
    // The surviving bus is scored on its own terms, and it was ticking down.
    expect(r.worstDriftSec).toBe(0);
  });

  it("does the same for a bus that vanishes while it is arriving", () => {
    // Brown again, +3240 s positionally, 16 s apart. "now" is the display
    // floor, so this is a bus at the stop that never appeared again.
    const r = pair("now, then 54 min", "in 54 min", 16);
    expect(r.catastrophic).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.droppedSevere).toBe(1);
    expect(r.drops[0]).toMatchObject({ leader: true, severe: true, lastShownEtaSec: 0 });
  });

  it("keeps a genuine lurch a lurch — the drop kind must not swallow it", () => {
    // The window is set above the two jumps this project already attributes
    // to one vehicle, so neither is renamed as a change of cast.
    expect(pair("in 10 min", "arriving now", 15).catastrophic).toBe(1);   // the operator's
    expect(pair("in 6 min", "in 16 min", 15).catastrophic).toBe(1);       // report #32's
  });

  it("counts a newcomer at the head of the list, but not one behind it", () => {
    // A bus taking over the lead is an event the rider sees as the countdown
    // resetting. A bus joining the SECOND slot is `nextArrivalAfterPinned`
    // finding a later vehicle it did not know about a tick ago — routine.
    const ahead = pair("in 20 min", "in 3, 20 min", 15);
    expect(ahead.appeared).toBe(1);
    expect(ahead.appearances[0]).toMatchObject({ kind: "appeared", etaSec: 180 });
    expect(ahead.dropped).toBe(0);
    const behind = pair("in 8 min", "in 8, 20 min", 15);
    expect(behind.appeared).toBe(0);
    expect(behind.transitions).toHaveLength(0);
  });

  it("does not call a trailing bus's departure severe", () => {
    // The second slot emptying is routine; only a bus the rider could still
    // have caught is the severe case.
    const r = pair("in 8, 20 min", "in 8 min", 15);
    expect(r.dropped).toBe(1);
    expect(r.droppedSevere).toBe(0);
    expect(r.drops[0]).toMatchObject({ leader: false, lastShownEtaSec: 1200 });
  });

  it("does not call two bunched buses folding into one statement a vanishing", () => {
    // The Orange Night card at 22:19: slot 2's point was inside slot 1's own
    // interval, so the app now says the interval once and names the cause. The
    // second slot leaves the TEXT; the bus is still on the row. Counted as an
    // event, and it must not fail a run.
    const r = pair("now, then 1 min", "now-6 min · 2 buses", 15);
    expect(r.dropped).toBe(1);
    expect(r.drops[0]).toMatchObject({ severe: true, event: "bunched", eventful: true });
    expect(r.droppedSevereEventful).toBe(1);
    expect(r.droppedSevereEventless).toBe(0);
    // The same drop WITHOUT the suffix is the defect it always was — the
    // excuse is the app saying why, not the shape of the line.
    const bare = pair("now, then 1 min", "now-6 min", 15);
    expect(bare.drops[0]).toMatchObject({ severe: true, eventful: false });
    expect(bare.droppedSevereEventless).toBe(1);
  });

  it("keeps the old record shape, so the archived runs still read", () => {
    const r = pair("in 10 min", "arriving now", 15);
    for (const k of ["readings", "transitions", "reversals", "notableReversals",
      "catastrophic", "worstDriftSec", "p90AbsDriftSec"]) {
      expect(r, `${k} went missing`).toHaveProperty(k);
    }
    // `transitions` still holds drift and nothing else, because the thresholds
    // and every reader of the log are written in terms of `driftSec`.
    expect(r.transitions.every((t) => t.kind === "drift" && typeof t.driftSec === "number")).toBe(true);
  });
});

describe("two buses that have bunched", () => {
  // CAPTURED INNERTEXT, not an argument. #111 "needed no change" either and
  // blinded the canary for twelve minutes, so every layout or wording change
  // to the card lands a real capture here. Both of these came off a
  // phone-sized (390 px) headless browser driving the real bundle against a
  // staged server with two Orange Night buses mocked onto route 14 — the line
  // this change exists for (project-case-orange-night-bunching, 2026-09-10).
  //
  // The countdown line has NO "in" in this form (measured: it is what keeps
  // the widest string inside the span beside the widest route pill), which
  // makes it the one countdown that could be mistaken for a duration header
  // — `isHeader` is /^\d+\s*min$/ and "8 min" matches it. The suffix is what
  // keeps them apart, so the point form is fixtured as well as the interval.

  // #49 standing at 100 Church Street South, #51 five stops back: the pinned
  // bus is the STANDING one, so the row shows its interval and #51's point is
  // inside it. The 22:19 card.
  const LIVE_BUNCHED_RANGE = `YALE SHUTTLE
11:37 PM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.310583, -72.926188
☆
WHEN
Now
Plan for later…
🌤
71°F · Partly cloudy · no rain expected
▾
°F
|
°C
OVERVIEW — ALL 1 ROUTE
▴
🚌
🚌 (O) 5-18 min
🏁 (O) 12:01a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Orange Night
🚶 Walk
17 min
11:54p
›
Orange Night
5-18 min · 2 buses
23 min
🚌 12 min
12:01a
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  // #51 moving and pinned, #49 standing behind it: the pin has no range of
  // its own and the bus that is uncertain is in slot 2. The 22:28 card.
  const LIVE_BUNCHED_POINT = `YALE SHUTTLE
11:37 PM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.310583, -72.926188
☆
WHEN
Now
Plan for later…
🌤
71°F · Partly cloudy · no rain expected
▾
°F
|
°C
OVERVIEW — ALL 1 ROUTE
▴
🚌
🚌 (O) 8 min
🏁 (O) 11:57p
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Orange Night
🚶 Walk
17 min
11:54p
›
Orange Night
8 min · 2 buses
20 min
🚌 12 min
11:57p
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads the interval form, and the card around it", () => {
    const opts = parseOptions(LIVE_BUNCHED_RANGE);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Walk", "Orange Night"]);
    expect(opts[1]).toMatchObject({ totalMin: 23, arriveText: "12:01a" });
    expect(opts[1].eta).toMatchObject({
      first: [300, 1140], second: null, spread: true, bunched: true,
      raw: "5-18 min \u00b7 2 buses",
    });
  });

  it("reads the point form, and does not take it for a duration header", () => {
    const opts = parseOptions(LIVE_BUNCHED_POINT);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Walk", "Orange Night"]);
    // 20 min is the trip, 8 min is the countdown: one card, not two.
    expect(opts[1]).toMatchObject({ totalMin: 20, arriveText: "11:57p" });
    expect(opts[1].eta).toMatchObject({
      first: [480, 540], second: null, spread: false, bunched: true,
      raw: "8 min \u00b7 2 buses",
    });
  });
});

describe("the median-with-band form on a captured page (etaBand.ts, 2026-09-11)", () => {
  // Real bundle, phone-sized chromium at 390 px against a staged server with
  // Red's production tables and two buses placed on the published sequence
  // (pr-preview/eta-band/probe.mjs). Captured innerText, verbatim.

  // #304 standing at 344 Winchester, #316 far behind: the band is wide enough
  // to print, the median sits inside it, the second bus stands apart, and the
  // low end is floored at what the bus must still stand and then drive.
  const LIVE_BAND_MEDIAN = `YALE SHUTTLE TRACKER
Unofficial app · not affiliated with Yale University
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.303422, -72.931698
☆
WHEN
Now
Plan for later…
☁️
71°F · Cloudy · no rain expected
▾
°F
|
°C
OVERVIEW — ALL 1 ROUTE
▴
🚌
🚌 (R) 4 (2-10) min
🏁 (R) 11:36a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Red
Red
in 4 (2-10), 17 min
17 min
🚌 12 min
11:36a
›
🚶 Walk
37 min
11:56a
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  // #304 driving toward the 344 Winchester layover, #316 behind it INSIDE the
  // band: bunching.ts folds the pair, the head keeps its median and its band.
  const LIVE_BAND_BUNCHED = `YALE SHUTTLE TRACKER
Unofficial app · not affiliated with Yale University
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 41.303422, -72.931698
☆
WHEN
Now
Plan for later…
☁️
71°F · Cloudy · no rain expected
▾
°F
|
°C
OVERVIEW — ALL 1 ROUTE
▴
🚌
🚌 (R) 12 (6-20) min
🏁 (R) 11:44a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Red
Red
12 (6-20) min · 2 buses
25 min
🚌 12 min
11:44a
›
🚶 Walk
37 min
11:56a
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads the median with its band, the second bus after it, and the card around them", () => {
    const opts = parseOptions(LIVE_BAND_MEDIAN);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 17, arriveText: "11:36a" });
    // The low end is 2, not "now": a standing bus's band is floored at
    // departNow + the shortest stand left (etaBand.ts `standingLowFloor`).
    expect(opts[0].eta).toMatchObject({
      first: [120, 660], second: [1020, 1080], spread: true, bunched: false, median: [240, 300],
      raw: "in 4 (2-10), 17 min",
    });
  });

  it("reads the bunched median-with-band head", () => {
    const opts = parseOptions(LIVE_BAND_BUNCHED);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 25 });
    expect(opts[0].eta).toMatchObject({
      first: [360, 1260], second: null, spread: true, bunched: true, median: [720, 780],
      raw: "12 (6-20) min \u00b7 2 buses",
    });
  });
});

describe("was there an EVENT behind the flag?", () => {
  // Every one of these is a real transition from scripts/.canary/runs.jsonl
  // with the bus positions the feed recorded alongside it. #71 measured that
  // 92.4 % of catastrophic drops have a real-world event behind them, and the
  // canary was reporting that as jitter.
  const at = (s) => 1_700_000_000_000 + s * 1000;
  const s = (t, raw, buses) => ({
    atMs: at(t), present: true, eta: parseBusEtaText(`🚌 ${raw}`), missedBus: null, buses,
  });
  const pairAt = (a, b, dt, from, to) => scoreSequence([s(0, a, from), s(dt, b, to)]);

  it("does not blame the app for a bus that reached the stop and pulled away", () => {
    // Brown #301: 23 m and at_stop, then 147 m. The card honestly moved to
    // the next bus. Still counted, but it must not fail a run.
    const r = pairAt("now, then 54 min", "in 54 min", 16,
      [{ name: "#301", distM: 23, atStop: 145 }], [{ name: "#301", distM: 147, atStop: null }]);
    expect(r.drops[0]).toMatchObject({ severe: true, event: "departure", eventful: true });
    expect(r.droppedSevereEventful).toBe(1);
    expect(r.droppedSevereEventless).toBe(0);
  });

  it("still blames it for a bus that vanished while it was closing", () => {
    // Brown #301 again, 225 m -> 77 m: coming straight at the stop, and the
    // card dropped it anyway. This is the defect. The verdict is "none"
    // rather than "closing" only because 225 m is outside NEAR_STOP_M —
    // either way nothing left, which is the question being asked.
    const r = pairAt("in 1, 57 min", "in 56 min", 15,
      [{ name: "#301", distM: 225, atStop: null }], [{ name: "#301", distM: 77, atStop: null }]);
    expect(r.drops[0]).toMatchObject({ severe: true, eventful: false });
    expect(r.droppedSevereEventless).toBe(1);
    // And a bus dropped while closing from INSIDE the stop's radius is the
    // same defect, named exactly.
    const near = pairAt("in 1, 57 min", "in 56 min", 15,
      [{ name: "#301", distM: 110, atStop: null }], [{ name: "#301", distM: 60, atStop: null }]);
    expect(near.drops[0]).toMatchObject({ severe: true, event: "closing", eventful: false });
  });

  it("does not let a bus on the far side of the loop excuse anything", () => {
    // Blue West #126, 416 m -> 301 m: nothing was at the stop to leave it.
    // Without the near-stop precondition a bus merely driving AWAY out there
    // would read as a departure — 23 of the archive's 64 catastrophic drifts,
    // which would talk the metric out of most of its own log.
    const r = pairAt("in 1, 40 min", "in 38, 77 min", 15,
      [{ name: "#126", distM: 416, atStop: null }], [{ name: "#126", distM: 301, atStop: null }]);
    expect(r.drops.find((d) => d.severe)).toMatchObject({ event: "none", eventful: false });
    expect(departureBetween(
      [{ name: "#126", distM: 900, atStop: null }],
      [{ name: "#126", distM: 1400, atStop: null }])).toBe("none");
  });

  it("says so plainly when it cannot tell", () => {
    // No bus list at all (the rider simulator's samples), and a bus the feed
    // stopped reporting. Neither is a departure, so neither excuses a flag.
    expect(departureBetween(undefined, undefined)).toBe("unknown");
    expect(departureBetween([{ name: "#1", distM: 20 }], [{ name: "#2", distM: 20 }])).toBe("unknown");
    // Inside the feed's ~30 m deadband nothing has been shown to move.
    expect(departureBetween([{ name: "#1", distM: 20 }], [{ name: "#1", distM: 45 }])).toBe("closing");
    expect(departureBetween([{ name: "#1", distM: 20 }], [{ name: "#1", distM: 55 }])).toBe("departure");
  });
});

describe("a bus already at the stop when the rider walks up", () => {
  // Seven of the ten `no-arrival` findings in the log were this: the card
  // says "now, then N min" precisely BECAUSE a bus is at the stop, and the
  // run failed for never seeing an arrival it was looking straight at.
  it("is at the stop, by distance or by the feed's own word", () => {
    // 2026-09-04 11:35 — #310, 38 m, at_stop 48, which is the board stop.
    expect(isAtBoardStop(38, 48, 48)).toBe(true);
    // 12:02 — #304 at 13 m. 11:03 — #304 at 49 m, four metres past the old bound.
    expect(isAtBoardStop(13, 48, 48)).toBe(true);
    expect(isAtBoardStop(49, 48, 48)).toBe(true);
    // The feed's word carries a bus the distance test would still miss.
    expect(isAtBoardStop(72, 48, 48)).toBe(true);
    // 11:50 — #316 885 m out, flagged at no stop. Not an arrival.
    expect(isAtBoardStop(885, null, 48)).toBe(false);
    // Flagged at a DIFFERENT stop is not this stop.
    expect(isAtBoardStop(300, 11, 48)).toBe(false);
    // And with no board stop resolved, distance is all there is.
    expect(isAtBoardStop(38, 48, null)).toBe(true);
    expect(isAtBoardStop(300, 48, null)).toBe(false);
  });
});

describe("the arrival clock has TWO readers", () => {
  // `parseOptions` is one. `openCard` in rider-canary.mjs is the other: it
  // finds the collapsed row to tap for the pinned vehicle and the board stop.
  // #123 taught the first both spellings and could not know the second
  // existed, so the 12:30 run on 2026-09-04 tapped no card for 25 minutes —
  // `board: null`, `pins: []`, every `distM` null — and then filed
  // `no-arrival` off ground truth it never had.
  it("matches both spellings of the clock", () => {
    expect(ARRIVAL_CLOCK_RE.test("arrive 5:13p")).toBe(true);  // until 2026-09-04
    expect(ARRIVAL_CLOCK_RE.test("10:33a")).toBe(true);        // #123 onwards
    expect(ARRIVAL_CLOCK_RE.test("12:31p")).toBe(true);
    // And nothing else on the card, or the tap lands on the wrong row.
    expect(ARRIVAL_CLOCK_RE.test("23 min")).toBe(false);
    expect(ARRIVAL_CLOCK_RE.test("in 3, 21 min")).toBe(false);
    expect(ARRIVAL_CLOCK_RE.test("12:13 PM")).toBe(false);     // the page header
  });

  it("finds a clock in the card text `openCard` actually greps", () => {
    // The predicate is per-LINE over a card's innerText, which is how
    // `openCard` uses it. The old copy tested the blob unanchored, so it
    // could not have been shared even if anyone had thought to.
    expect(hasArrivalClock("Blue Day\nin 3, 21 min\n23 min\n10:33a\n›")).toBe(true);
    expect(hasArrivalClock("Blue Day\nin 3, 21 min\n23 min\narrive 10:33a\n›")).toBe(true);
    expect(hasArrivalClock("Blue Day\nin 3, 21 min\n23 min\n›")).toBe(false);
    expect(hasArrivalClock("")).toBe(false);
    expect(hasArrivalClock(null)).toBe(false);
  });

});

describe("a bus with coordinates always gets a distance", () => {
  // The 12:30 run recorded `{"name":"#310","id":65956,"distM":null,"atStop":27}`
  // on every sample: real buses, real at_stop values, no distance, because the
  // board stop was never read. Null distances make every arrival, departure
  // and event verdict downstream blind, so this asserts the shape the samples
  // must have.
  // Both coordinates are REAL and copied, not invented: the board stop is the
  // one every archived Red run read out of the app's own Directions link, and
  // the origin is `CANONICAL_TRIP`'s. The 12:30 samples record no lat/lon at
  // all — only the null distances the defect produced — so there is no real
  // bus position to fixture, and inventing one to make a radius assertion
  // pass is how a wrong measurement gets written down as fact.
  const BOARD = { lat: 41.324769, lon: -72.923522 };

  it("measures every bus once the board stop is known", () => {
    const buses = [
      { bus_name: "#310", bus_id: 65956, ...BOARD, at_stop_id: 27 },
      { bus_name: "#304", bus_id: 65960, ...CANONICAL_TRIP.destination, at_stop_id: null },
    ];
    for (const b of buses) {
      const d = Math.round(haversineM(b, BOARD));
      expect(Number.isFinite(d), `${b.bus_name} has no distance`).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
    // A bus standing on the board stop is at it; one at the far end of the
    // trip is nowhere near. Those are the only two claims the real
    // coordinates support.
    expect(Math.round(haversineM(buses[0], BOARD))).toBeLessThan(ARRIVAL_M);
    expect(Math.round(haversineM(buses[1], BOARD))).toBeGreaterThan(NEAR_STOP_M);
  });

  it("returns no distance at all when the board stop was never read", () => {
    // Precisely the 12:30 shape: `board` is null, so the snapshot writes null
    // rather than a number, and every downstream verdict is blind.
    const board = null;
    const distM = board ? Math.round(haversineM({ lat: 41.3, lon: -72.9 }, board)) : null;
    expect(distM).toBeNull();
  });

  it("cannot judge an arrival at all without a board stop", () => {
    // This is what the run did: a bus sitting AT the stop reads as not there,
    // because there is no stop to be at. The verdict must be suppressed
    // rather than reported — the same rule as a feed that refused every poll.
    expect(isAtBoardStop(null, 27, null)).toBe(false);
    expect(isAtBoardStop(NaN, 48, null)).toBe(false);
    // And a NaN distance never sneaks past the radius test.
    expect(isAtBoardStop(Number.NaN, null, 48)).toBe(false);
  });
});

describe("a line nobody is driving is idle, not broken", () => {
  // Red's end of service, 2026-09-04 18:33:15. The keepalive forces
  // CANARY_LINE=Red, which used to bypass the rideable check, so the canary
  // watched a line with zero buses for twelve minutes: 46 samples, every one
  // `present: false`, every one carrying an EMPTY bus list. It filed
  // line-missing ("Red is running (0 live buses)"), no-board-stop and
  // option-vanished against an app that was correctly declining to offer a
  // route nobody was driving.
  const sample = (t, buses) => ({
    atMs: 1_700_000_000_000 + t * 1000, present: false, eta: null, buses,
  });

  it("knows the fleet has gone home", () => {
    expect(fleetOffAir([sample(0, []), sample(15, []), sample(30, [])])).toBe(true);
  });

  it("reads the LAST poll, so a line going off-air mid-watch counts", () => {
    // The ordinary way an evening ends: buses on the road at first sight,
    // none by the end. That retires the run; it does not fail it.
    const off = [sample(0, [{ name: "#310", distM: 400 }]), sample(15, [])];
    expect(fleetOffAir(off)).toBe(true);
    // And the mirror: a line that still has a bus at the end has NOT gone
    // off-air, so a vanished option there is still a real defect.
    const on = [sample(0, []), sample(15, [{ name: "#310", distM: 400 }])];
    expect(fleetOffAir(on)).toBe(false);
  });

  it("says nothing when it has no bus lists to judge", () => {
    // Samples from before the bus snapshot existed, and the empty run.
    expect(fleetOffAir([{ atMs: 1, present: true, eta: null }])).toBe(false);
    expect(fleetOffAir([])).toBe(false);
    expect(fleetOffAir(undefined)).toBe(false);
  });

  it("does not make a line rideable just because it was forced", async () => {
    // The pool bug itself: `rideableLines` already says Red is not rideable
    // with no buses, and forcing must pick WHICH line, not whether there is
    // anything to watch.
    const { rideableLines } = await import("./rider-canary.mjs");
    const payload = {
      routes: { 3: [1, 2] },
      stop_coords: { 1: CANONICAL_TRIP.origin, 2: CANONICAL_TRIP.destination },
      stop_names: {},
      buses: [],
    };
    const red = rideableLines(payload).find((l) => l.label === "Red");
    expect(red.liveBuses).toBe(0);
    expect(red.trip).not.toBeNull();   // the trip is fine; the fleet is not
    expect(red.rideable).toBe(false);
  });
});

describe("the canary's own feed failing is not the app's fault", () => {
  // Both fixtures are archived Red runs whose ONLY reason for not being `ok`
  // was `/api/buses` timing out on this Pi. 31 feed errors across 24 of 60
  // runs, and no rider saw any of them.
  it("passes a run whose only trouble was a timed-out ground-truth poll", () => {
    // 2026-09-04 09:27:57 Red — watched 9.2 min, the bus ARRIVED, one poll
    // aborted. It was filed as a finding.
    expect(runVerdict({ failures: [], feedPolls: 110, feedErrorCount: 1 })).toBe("ok");
    // 09:02:10 Red — 25.7 min, two aborted polls out of ~300.
    expect(runVerdict({ failures: [], feedPolls: 308, feedErrorCount: 2 })).toBe("ok");
    // The worst affected run in the archive lost three polls; still ok.
    expect(runVerdict({ failures: [], feedPolls: 100, feedErrorCount: 3 })).toBe("ok");
  });

  it("still fails a run for anything the app actually did", () => {
    expect(runVerdict({ failures: [{ kind: "eta-jump" }], feedPolls: 100, feedErrorCount: 2 }))
      .toBe("finding");
  });

  it("calls total loss of the feed `unreachable` — neither ok nor a finding", () => {
    // SYNTHETIC: no archived run lost every poll (the worst is 3 of ~100), so
    // this shape has not been seen in the wild. It is the one case where the
    // canary has no ground truth at all, and calling it `ok` would let a
    // network outage read as a quiet healthy night.
    expect(runVerdict({ failures: [], feedPolls: 120, feedErrorCount: 120 })).toBe("unreachable");
    // It outranks a finding, because those findings were judged against
    // nothing.
    expect(runVerdict({ failures: [{ kind: "no-arrival" }], feedPolls: 120, feedErrorCount: 120 }))
      .toBe("unreachable");
    // A run that never polled at all is not "unreachable" — it is whatever
    // its failures say, so an early crash keeps its own verdict.
    expect(runVerdict({ failures: [{ kind: "fatal" }], feedPolls: 0, feedErrorCount: 0 }))
      .toBe("finding");
    expect(runVerdict()).toBe("ok");
  });
});

describe("how long to keep watching", () => {
  const min = (n) => n * 60_000;

  it("gives a watch that opens on a bus at the stop the floor, not the promise", () => {
    // "now, then 72 min": `first` is the [0, 10) bucket, so the promise is
    // zero and only the eight-minute floor keeps the watch alive at all.
    expect(deadlineForPromise(0, 10, 25, 0)).toBe(min(8));
  });

  it("extends when the card re-pins to a bus 19 min out", () => {
    // THE 2026-09-04 12:02 DEFECT. The deadline was set once, at first sight,
    // from a bus already at the stop — so the watch expired eight minutes in
    // with "in 19, 31 min" on screen and blamed the app.
    const opened = deadlineForPromise(0, 10, 25, 0);
    const repinned = deadlineForPromise(min(1), 20 * 60, 25, 0);
    expect(repinned).toBeGreaterThan(opened);
    // 2 x 20 + 6 = 46 min, which the 25-minute ceiling cuts to 25 from the
    // START of the watch — never 25 more minutes from this reading.
    expect(repinned).toBe(min(25));
  });

  it("cannot be pushed past the ceiling by a countdown that keeps re-promising", () => {
    for (const t of [0, min(5), min(20), min(24)]) {
      expect(deadlineForPromise(t, 40 * 60, 25, 0)).toBeLessThanOrEqual(min(25));
    }
  });
});

describe("no bus came: whose fault", () => {
  const at = (s) => 1_700_000_000_000 + s * 1000;
  const s = (t, raw) => ({ atMs: at(t), present: true, eta: parseBusEtaText(`🚌 ${raw}`) });

  it("blames the app for a promise that came due while it was still watching", () => {
    // Purple, 2026-09-04 19:18: "in 14, 42 min" and no bus 10 min after it
    // was due. That is the app, and it must keep failing the run.
    const samples = [s(0, "in 14, 42 min"), s(600, "in 4, 32 min")];
    const broken = brokenPromise(samples, at(1500));
    expect(broken).toMatchObject({ raw: "in 14, 42 min" });
    expect(broken.overdueSec).toBe(600);
  });

  it("blames nobody when the ceiling stopped the watch before anything was due", () => {
    // Red, 09:02: opened on "in 30, 51 min" and the 25-minute cap cut it
    // short. No promise ever came due, so `no-arrival` would be a lie —
    // this is `unfinished`, and it does not fail the run.
    const samples = [s(0, "in 30, 51 min"), s(1500, "in 5, 18 min")];
    expect(brokenPromise(samples, at(1542))).toBeNull();
  });

  it("counts the promise from the reading that made it, not from the watch's start", () => {
    // A bus 2 min out at minute twelve is overdue at minute fifteen even
    // though the watch is young by its opening promise.
    expect(brokenPromise([s(0, "in 30 min"), s(720, "in 2 min")], at(900)))
      .toMatchObject({ raw: "in 2 min" });
    // And a reading with no countdown cannot break a promise it never made.
    expect(brokenPromise([{ atMs: at(0), present: true, eta: null }], at(9999))).toBeNull();
    expect(brokenPromise([], at(9999))).toBeNull();
  });
});

describe("how close counts as arrived", () => {
  it("is above the distance the log kept truncating at", () => {
    // 32 detected arrivals across the archive land at 12..44 m against a 45 m
    // bound, four of them in [40,45) and none above — a bound cutting a tail.
    // The 11:03 run filed no-arrival with the bus 49 m out and the feed's own
    // at_stop_id naming that stop.
    expect(ARRIVAL_M).toBeGreaterThan(49);
    // And below the band where the feed never calls a bus stopped at all
    // ([80,100) m is 0 at_stop against 10 not).
    expect(ARRIVAL_M).toBeLessThan(80);
    // A departure has to clear the feed's own position deadband.
    expect(DEPARTURE_M).toBeLessThan(ARRIVAL_M);
    expect(NEAR_STOP_M).toBeGreaterThan(ARRIVAL_M);
  });
});

describe("pairBuses", () => {
  const min = (n) => [n * 60, n * 60 + 60];

  it("matches by nearest ETA rather than by slot", () => {
    const p = pairBuses({ first: min(45), second: min(5) }, { first: min(6), second: min(44) }, 15);
    expect(p.matched).toHaveLength(2);
    expect(p.dropped).toHaveLength(0);
    // The 45-min bus was printed first and is now printed second.
    const crossed = p.matched.find((m) => m.fromSlot === 0);
    expect(crossed.toSlot).toBe(1);
    expect(Math.abs(crossed.driftSec)).toBeLessThan(60);
  });

  it("lets a bus leave rather than forcing it to become the one that replaced it", () => {
    // "in 2, 38 min" -> "in 17, 38 min" is the archive's most common shape of
    // false catastrophe (22 of the 77): the 38-min bus never moved.
    const p = pairBuses({ first: min(2), second: min(38) }, { first: min(17), second: min(38) }, 15);
    expect(p.matched).toHaveLength(1);
    expect(p.matched[0].driftSec).toBe(0);
    expect(p.dropped).toHaveLength(1);
    expect(p.dropped[0].bucket).toEqual(min(2));
    expect(p.appeared).toHaveLength(1);
    expect(p.appeared[0].bucket).toEqual(min(17));
  });

  it("refuses no pairing it is not forced to refuse", () => {
    // One bus in, one bus out, and a jump inside the window: there is nothing
    // else it could be, so it stays a drift.
    const p = pairBuses({ first: min(10) }, { first: [0, 10] }, 15);
    expect(p.matched).toHaveLength(1);
    expect(p.dropped).toHaveLength(0);
  });

  it("reads the leader by ETA, not by print order", () => {
    // The app prints these out of order, so slot 0 is not the leader.
    const p = pairBuses({ first: min(45), second: min(5) }, { first: min(44) }, 15);
    expect(p.dropped).toHaveLength(1);
    expect(p.dropped[0].bucket).toEqual(min(5));
    expect(p.dropped[0].leader).toBe(true);
  });
});

describe("the pairing window", () => {
  it("sits above every jump this project attributes to one vehicle", () => {
    // Below these it would rename the headline defect as a vehicle swap and
    // stop counting it, which is the opposite of the point.
    const operators = conservativeDrift([600, 660], [10, 60], 15);   // "10 min" -> "<1 min"
    const report32 = conservativeDrift([360, 420], [960, 1020], 15); // "6 min" -> "16 min"
    expect(THRESHOLDS.pairWindowSec).toBeGreaterThanOrEqual(Math.abs(operators));
    expect(THRESHOLDS.pairWindowSec).toBeGreaterThanOrEqual(Math.abs(report32));
  });

  it("sits below the smallest pairing the archive shows to be absurd", () => {
    // Blue West, "in 1, 40 min" -> "in 38, 77 min": the 40-min bus plainly
    // became the 38-min one and the 1-min bus vanished. Pairing 1 -> 38 is
    // 2175 s, and a window that allowed it would report that vanishing as
    // drift — which is exactly what the old metric did.
    expect(THRESHOLDS.pairWindowSec).toBeLessThan(
      Math.abs(conservativeDrift([60, 120], [2280, 2340], 15)));
  });
});

describe("CANARY_LINES", () => {
  it("agrees with ROUTE_LISTS about which route ids carry each line", async () => {
    // A harness cannot import the .ts source, so the copy is pinned by reading
    // it — the same guard walk.test.ts puts on the walk model.
    const { CANARY_LINES } = await import("./canary-metrics.mjs");
    const src = readFileSync(new URL("../web/src/routes.ts", import.meta.url), "utf8");
    for (const line of CANARY_LINES) {
      const row = src.match(
        new RegExp(`busRouteIds:\\s*\\[([^\\]]*)\\][^\\n]*label:\\s*"${line.label}"`),
      );
      expect(row, `no ROUTE_LISTS row for ${line.label}`).toBeTruthy();
      expect(row[1].split(",").map((s) => Number(s.trim())))
        .toEqual(line.busRouteIds);
    }
  });
});

describe("the catastrophic bar", () => {
  it("is the same number the accuracy gate uses for a lurch", () => {
    // The field bar and the CI bar must not drift apart: a jump the gate would
    // fail on the recorded pass is a jump the canary must name in the wild.
    const gate = readFileSync(
      new URL("../web/src/accuracy-layover.test.ts", import.meta.url), "utf8");
    const m = gate.match(/does not lurch between one poll and the next[\s\S]*?toBeLessThan\((\d+)\)/);
    expect(m, "the lurch assertion moved or was renamed").toBeTruthy();
    expect(THRESHOLDS.catastrophicSec).toBe(Number(m[1]));
  });

  it("would have caught the first live run's 225 s drop", () => {
    // Red #304 at the 344 Winchester layover: "in 7 min" -> "in 2 min", 15 s
    // apart, bus 386 m out and the pin unchanged. The gate skips this moment.
    const drift = conservativeDrift([420, 480], [120, 180], 15);
    expect(drift).toBe(-225);
    expect(Math.abs(drift)).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });
});

describe("which trip a line is ridden on", () => {
  // A synthetic payload in the shape /api/buses serves. Nothing in the suite
  // touches the network.
  const near = (pt, dLat) => ({ lat: pt.lat + dLat, lon: pt.lon });
  const payload = {
    routes: {
      3: [1, 2, 3, 4],              // reaches both ends of the operator's trip
      9: [10, 11, 12, 13, 14, 15, 16, 17],  // nowhere near either
      15: [20, 21, 22, 23],         // every stop on top of the next
      99: [],
    },
    stop_coords: {
      1: near(CANONICAL_TRIP.origin, 0.0005),        // ~55 m from the origin
      2: { lat: 41.315, lon: -72.927 },
      3: near(CANONICAL_TRIP.destination, 0.0005),   // ~55 m from the destination
      4: { lat: 41.310, lon: -72.930 },
      // A line 20 km east: inside no radius of either end.
      10: { lat: 41.30, lon: -72.68 }, 11: { lat: 41.30, lon: -72.67 },
      12: { lat: 41.30, lon: -72.66 }, 13: { lat: 41.30, lon: -72.65 },
      14: { lat: 41.30, lon: -72.64 }, 15: { lat: 41.30, lon: -72.63 },
      16: { lat: 41.30, lon: -72.62 }, 17: { lat: 41.30, lon: -72.61 },
      // Four stops within a few metres of each other, 20 km away.
      20: { lat: 41.40, lon: -72.60 }, 21: { lat: 41.40001, lon: -72.60 },
      22: { lat: 41.40002, lon: -72.60 }, 23: { lat: 41.40003, lon: -72.60 },
    },
    stop_names: { 1: "A", 3: "B", 10: "E0", 12: "E2", 13: "E3", 17: "E7" },
    buses: [{ route_id: 3, bus_name: "#1" }],
  };
  const line = (id) => CANARY_LINES.find((l) => l.busRouteIds[0] === id);

  it("uses the operator's own trip for a line that reaches both ends", () => {
    const t = tripForLine(payload, line(3));
    expect(t.kind).toBe("canonical");
    expect(t.destination.display_name).toBe("School of Public Health (YSPH)");
  });

  it("derives a trip from the line's own stops when it does not", () => {
    const t = tripForLine(payload, line(9));
    expect(t.kind).toBe("derived");
    expect(t.origin.label).toBe("E0");
    // A quarter of eight stops is index 2.
    expect(t.destination.display_name).toBe("E2");
    // A stop is auto-picked by the frontend the way a curated landmark is.
    expect(t.destination.type).toBe("bus_stop");
  });

  it("walks forward until the two ends are far enough apart to be a ride", () => {
    // Every stop on route 15 is within a few metres, so no pair qualifies.
    expect(tripForLine(payload, line(15))).toBeNull();
  });

  it("skips a line upstream serves no stops for", () => {
    expect(tripForLine({ routes: {}, stop_coords: {} }, line(3))).toBeNull();
  });

  it("does not treat the planner's absolute walk limit as a usable walk", () => {
    // At MAX_WALK_M fourteen of fifteen lines "serve" the operator's trip,
    // including ones the app is right to bury. The canonical radius has to be
    // the walk the app itself would plan, not the one past which it gives up.
    expect(CANONICAL_MAX_WALK_M).toBeLessThan(MAX_WALK_M);
    expect(MIN_RIDE_M).toBeLessThan(CANONICAL_MAX_WALK_M);
  });
});

describe("busOnRoute", () => {
  it("is the app's own off-route line, not a second opinion", () => {
    const src = readFileSync(new URL("../web/src/anchor.ts", import.meta.url), "utf8");
    const m = src.match(/export const OFF_ROUTE_THRESHOLD_M = (\d+);/);
    expect(Number(m[1])).toBe(OFF_ROUTE_M);
  });

  it("rules out #57 deadheading down Whitney Ave from Hamden with route 13 set", () => {
    const p = BLUE_NIGHT_PAYLOAD();
    expect(busOnRoute(p, p.buses[0], BLUE_NIGHT)).toBe(false);
    // ...and where it stopped at 17:52, 977 m short of the line.
    const parked = BLUE_NIGHT_PAYLOAD({ lat: 41.328989, lon: -72.921811 });
    expect(busOnRoute(parked, parked.buses[0], BLUE_NIGHT)).toBe(false);
    expect(liveBusesOf(parked, BLUE_NIGHT)).toEqual([]);
  });

  it("keeps a bus on the polyline, even between stops", () => {
    // Mid-leg between Peabody and Payne Whitney, 30 m off the chord.
    const p = BLUE_NIGHT_PAYLOAD({ lat: 41.31389, lon: -72.92290 });
    expect(busOnRoute(p, p.buses[0], BLUE_NIGHT)).toBe(true);
    expect(liveBusesOf(p, BLUE_NIGHT).map((b) => b.bus_name)).toEqual(["#57"]);
  });

  it("falls back to the stops when the payload carries no polyline", () => {
    const near = BLUE_NIGHT_PAYLOAD({ lat: 41.3160, lon: -72.9210 });
    const far = BLUE_NIGHT_PAYLOAD();
    delete near.route_paths;
    delete far.route_paths;
    expect(busOnRoute(near, near.buses[0], BLUE_NIGHT)).toBe(true);
    expect(busOnRoute(far, far.buses[0], BLUE_NIGHT)).toBe(false);
  });

  it("never rules out a bus without GPS", () => {
    const p = BLUE_NIGHT_PAYLOAD();
    expect(busOnRoute(p, { route_id: 13, bus_name: "#1" }, BLUE_NIGHT)).toBe(true);
  });
});

describe("rideableLines", () => {
  it("does not count a bus that is off its route as the line running (2026-09-06 17:42)", async () => {
    const { rideableLines } = await import("./rider-canary.mjs");
    const p = BLUE_NIGHT_PAYLOAD();
    const bn = rideableLines(p).find((l) => l.label === "Blue Night");
    // The trip can be built — the stops are all there — but nothing is on it.
    expect(bn.trip).not.toBeNull();
    expect(bn.liveBuses).toBe(0);
    expect(bn.rideable).toBe(false);
    // The same bus on the line is a line to ride.
    const on = rideableLines(BLUE_NIGHT_PAYLOAD({ lat: 41.31389, lon: -72.92290 })).find((l) => l.label === "Blue Night");
    expect(on.liveBuses).toBe(1);
    expect(on.rideable).toBe(true);
  });

  it("rides only a line with live buses AND a trip", async () => {
    const { rideableLines } = await import("./rider-canary.mjs");
    const payload = {
      routes: { 3: [1, 2], 9: [] },
      stop_coords: { 1: CANONICAL_TRIP.origin, 2: CANONICAL_TRIP.destination },
      stop_names: {},
      buses: [{ route_id: 3, bus_name: "#1" }, { route_id: 9, bus_name: "#2" }],
    };
    const byLabel = Object.fromEntries(rideableLines(payload).map((l) => [l.label, l]));
    expect(byLabel.Red.rideable).toBe(true);
    // Green has a bus but upstream lists no stops for it — nothing to ride.
    expect(byLabel.Green.rideable).toBe(false);
    // Blue Day has the trip but no bus on the road.
    expect(byLabel["Blue Day"].rideable).toBe(false);
  });
});

describe("the destination the canary serves to the app", () => {
  it("is written in the geocoder's own response shape, display_name and all", () => {
    // The canary fulfils /api/geocode with this object verbatim. The frontend
    // calls display_name.split() to build the suggestion row, so an object
    // that carries `label` instead takes the whole app down through its error
    // boundary — "Cannot read properties of undefined (reading 'split')",
    // which is exactly what happened live on 2026-09-03 the first time a
    // derived trip was passed straight through.
    const payload = {
      routes: { 9: [10, 11, 12, 13] },
      stop_coords: {
        10: { lat: 41.30, lon: -72.68 }, 11: { lat: 41.30, lon: -72.67 },
        12: { lat: 41.30, lon: -72.66 }, 13: { lat: 41.30, lon: -72.65 },
      },
      stop_names: { 10: "E0", 11: "E1" },
    };
    const line = CANARY_LINES.find((l) => l.busRouteIds[0] === 9);
    for (const dest of [CANONICAL_TRIP.destination, tripForLine(payload, line).destination]) {
      expect(typeof dest.display_name).toBe("string");
      expect(dest.display_name.length).toBeGreaterThan(0);
      expect(dest).not.toHaveProperty("label");
      expect(typeof dest.lat).toBe("number");
      expect(typeof dest.lon).toBe("number");
    }
  });
});

describe("an expanded card carrying the berth map", () => {
  // The berth inset draws two labelled dots — where the feed says the stop is
  // and where the bus is measured to pull up. "published stop" and "expected
  // stop" are lower-case, letters-and-space only, and sit BELOW the duration,
  // which is the precise shape that made "nearby" outrank the route pill
  // (report #102) and "Contribute" end the card list. Both are in NOT_A_ROUTE,
  // and this capture is what proves it rather than an argument that the parser
  // is fine — #111 "needed no change" too, and blinded the canary for twelve
  // minutes.
  //
  // UPDATED 2026-09-11, when the inset became a live Leaflet map. The two words
  // still reach `innerText` — a permanent tooltip lands there exactly as an SVG
  // <text> did — and the map brings five new lines with it: the zoom buttons
  // "+" and "−", Leaflet's attribution, the ⤢ that opens the full map, and the
  // two lines of the arm-the-map row (the 👆 and its words split because the
  // row is a flex container, which blockifies its children for innerText).
  // None of them is `isLabelish`: the glyphs are not letters, the attribution
  // carries "|" and "©", and "Tap the map to zoom and pan" is 27 characters
  // against that pattern's 20. The lines below are a VERBATIM capture from
  // `scripts/berth-map-capture.mjs` at 390 px, spliced into this card — not a
  // hand-written guess at what the map prints.
  //
  // The Directions button is relabelled in the same breath (operator,
  // 2026-09-11: "the directions to stop button should now say directions to
  // published stop since we show two"), and only on a card that shows a berth.
  const LIVE_BERTH_INSET = `YALE SHUTTLE
1:31 PM
Trip
Map
Issues
↻
Red
in 9, 24 min
14 min
🚶 2 min
›
🚌 9 min
1:45p
›
Division/Prospect
published stop
expected stop
+
−
 Leaflet | © OpenStreetMap contributors
⤢
👆
Tap the map to zoom and pan
Wait about 55 m past the published stop
Red buses actually stop there — seen 37 of the last 40 times one served this stop.
🧭 Directions to published stop
Blue Day
in 4, 19 min
17 min
1:48p
›
Clear
💬 Send feedback
Contribute
🧪
Not affiliated with or endorsed by Yale University.`;

  it("still reads the line as Red, not as one of the map's labels or controls", () => {
    const opts = parseOptions(LIVE_BERTH_INSET);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Blue Day"]);
  });

  it("takes the countdown from the card, not from the sentence's metres", () => {
    const [red] = parseOptions(LIVE_BERTH_INSET);
    expect(red.eta?.raw).toBe("in 9, 24 min");
    expect(red.eta?.first).toEqual([540, 600]);
    expect(red.totalMin).toBe(14);
    expect(red.walkToMin).toBe(2);
  });
});

describe("an expanded card whose bus is holding short of a stop", () => {
  // Report #102 added one word to the expanded card: `nearby`, beside the
  // pause chip, for a bus taking its layover just short of the marker.
  //
  // It is lower-case and letters-only, so `isLabelish` reads it as a route
  // pill — and `label` prefers a match found BELOW the duration, which is
  // exactly where the expanded stop list lives. Un-guarded, this card reports
  // its line as "nearby" instead of "Red": the same failure as "Contribute"
  // before IS_PAGE_CHROME, and the same failure as #111, where a layout change
  // that "needed no parser change" blinded the canary for twelve minutes.
  //
  // So the word is in NOT_A_ROUTE, and this is the capture that proves it —
  // an argument that the parser is fine is not what this suite accepts.
  const LIVE_HOLDING_NEARBY = `YALE SHUTTLE
1:31 PM
Trip
Map
Issues
↻
Red
in 9, 24 min
14 min
🚶 2 min
›
🚌 9 min
1:45p
›
344 Winchester
🚌 344 Winchester
⏸ 6:12 / ~4:29
nearby
Winchester / Division
Division / Sheffield
Division / Prospect
Blue Day
in 4, 19 min
17 min
1:48p
›
🚶 Walk
41 min
2:12p
›
Clear
💬 Send feedback
Contribute
🧪
Not affiliated with or endorsed by Yale University.`;

  it("still reads the line as Red, not as the holding marker", () => {
    const opts = parseOptions(LIVE_HOLDING_NEARBY);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red", "Blue Day", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 14, arriveText: "1:45p", walkToMin: 2 });
    expect(opts[0].eta.raw).toBe("in 9, 24 min");
    // The countdown is still found above the duration, not confused with the
    // ride bar ("🚌 9 min") or with the stop line that carries the bus glyph.
    expect(opts[1]).toMatchObject({ totalMin: 17, arriveText: "1:48p" });
    expect(opts[1].eta.raw).toBe("in 4, 19 min");
    expect(opts[2]).toMatchObject({ mode: "walk", totalMin: 41 });
  });
});

/**
 * THE PAGE CHROME AFTER THE RENAME (2026-09-10).
 *
 * The app is called "Shuttle Tracker" now — Yale's mark is not the product's
 * name — and the header carries a second line under it, "Unofficial live
 * tracker for the Yale shuttles". Both land in the page's innerText, which is
 * the only thing this parser reads.
 *
 * Nothing about that SHOULD reach a card: the header is a dozen lines above
 * the first duration, `startOf` walks back at most two, and the tagline is 44
 * characters where `isLabelish` stops at 20. But #111 "needed no change" too
 * and blinded the canary for twelve minutes, so this is a capture rather than
 * that argument — 390x844, the operator's own Prospect / Canner -> School of
 * Public Health trip, taken off a staged build of the rename branch against a
 * live /api/buses.
 */
describe("the renamed header", () => {
  const LIVE_RENAMED = `SHUTTLE TRACKER
Unofficial live tracker for the Yale shuttles
10:50 PM
Trip
Map
Issues
↻
FROM
📍 Current location
⇅
TO
🏁 School of Public Health (YSPH)
☆
WHEN
Now
Plan for later…
🌤
71°F · Partly cloudy · no rain expected
▾
°F
|
°C
OVERVIEW — TOP 3 OF 4 ROUTES
▴
🚌
🚌
🚌
🚌 (B) 6 min
 (O) 11 min
🏁 (B) 11:04p
 (B) 11:12p
 (O) 11:11p
🚌 (B) 16 min
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Blue West
Blue Night
Orange Night
Blue West
in 6, 33 min
16 min
🚶 2 min
›
🚌 7 min
›
🚶 3 min
11:07p
›
Blue Night
in 16, 46 min
22 min
🚶 17 min
›
🚌 4 min
›
🚶 1 min
11:13p
›
Orange Night
in 11, 36 min
23 min
🚶 9 min
›
🚌 8 min
›
🚶 3 min
11:14p
›
🚶 Walk
38 min
11:29p
›
Show 1 more route
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads four cards off the renamed page, and no card out of the header", () => {
    const opts = parseOptions(LIVE_RENAMED);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue West", "Blue Night", "Orange Night", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 16, arriveText: "11:07p", walkToMin: 2, walkFromMin: 3 });
    expect(opts[0].eta.raw).toBe("in 6, 33 min");
    expect(opts[3]).toMatchObject({ mode: "walk", totalMin: 38, arriveText: "11:29p" });
  });

  it("never takes the brand or the tagline for a route pill", () => {
    const labels = parseOptions(LIVE_RENAMED).map((o) => o.routeLabel);
    // "SHUTTLE TRACKER" is letters-and-space and so IS label-shaped, exactly
    // as "YALE SHUTTLE" was; what keeps it out is distance from the anchor,
    // not its spelling. The tagline is too long to be label-shaped at all.
    expect(labels).not.toContain("SHUTTLE TRACKER");
    expect(labels.some((l) => /Unofficial/.test(l ?? ""))).toBe(false);
  });
});


/**
 * THE STAND THE BOARD-STOP RULE CANNOT SEE.
 *
 * Every frame below is copied out of scripts/.canary/runs.jsonl on the Pi —
 * `atMs`, the countdown text the rider was shown, and the feed's own bus list
 * — for the transitions the canary filed as `eta-jump` in the 24 h to
 * 2026-09-08 21:00 UTC. Six of the sixteen it filed that day were the app
 * repricing a bus that had just left a stand somewhere out on the loop, which
 * is what the ring posterior is FOR (docs/eta-ring-posterior.md).
 */
describe("a stand ending out on the loop", () => {
  const frame = (atMs, raw, buses, missedBus = null) => ({
    atMs, present: true, eta: parseBusEtaText(`🚌 ${raw}`), missedBus, buses,
  });
  const jumpsOf = (samples, pins) => unexplainedJumps(scoreSequence(samples, THRESHOLDS, { pins }));

  /** Gold, 2026-09-08 20:35 ET. One bus on the line, standing at stop 10. */
  const GOLD = [
    ...[1_788_899_855_485, 1_788_899_872_327, 1_788_899_887_451, 1_788_899_902_587,
      1_788_899_917_777, 1_788_899_933_153, 1_788_899_948_462, 1_788_899_963_744,
      1_788_899_979_069, 1_788_899_996_038]
      .map((at) => frame(at, "in 8, 44 min", [{ name: "#310", distM: 263, atStop: 10 }])),
    frame(1_788_900_011_375, "in 7, 43 min", [{ name: "#310", distM: 237, atStop: 10 }]),
    frame(1_788_900_026_702, "in 1, 37 min", [{ name: "#310", distM: 188, atStop: 10 }]),
  ];
  const GOLD_PINS = [{ atMs: 1_788_899_980_836, busName: "310" }, { atMs: 1_788_900_028_614, busName: "310" }];

  it("credits the pinned bus's countdown collapsing on the frame its stand ended", () => {
    // Ten frames at exactly 263 m — the feed repeating a fix, which is the only
    // way a stand is visible here — then 237, then 188. #310 reached the board
    // stop 1.7 min after the jump, so "in 1 min" was the truthful number and
    // "in 8" was the stale one.
    expect(standPollsBefore(GOLD, 9, "#310")).toBe(9);
    expect(standEndedFor(GOLD, 10, "310")).toBe(true);
    expect(jumpsOf(GOLD, GOLD_PINS)).toEqual([]);
  });

  it("still files it when there is no pin to attribute the stand to", () => {
    // No pin, no vehicle, no credit: the rule never guesses which bus moved.
    expect(jumpsOf(GOLD, [])).toHaveLength(1);
  });

  it("counts one card-wide re-price once, not once per slot", () => {
    // Gold has ONE bus, so the "37 min" is #310's next lap — the first number
    // plus the loop — and it cannot fail to move when the first does. The
    // canary filed this transition twice on 2026-09-08, as the leader and as
    // "the bus after the pinned one", with identical text.
    const seq = scoreSequence(GOLD, THRESHOLDS, { pins: GOLD_PINS });
    const both = seq.transitions.filter((t) => t.catastrophic);
    expect(both).toHaveLength(2);
    expect(both.map((t) => t.event).sort()).toEqual(["next-lap", "stand-end"]);
    // And with the leader NOT credited, the pair still reports as one finding.
    expect(unexplainedJumps({ transitions: both.map((t) => ({ ...t, eventful: false })) })).toHaveLength(1);
  });
});

describe("what a stand ending must NOT excuse", () => {
  const frame = (atMs, raw, buses, missedBus = null) => ({
    atMs, present: true, eta: parseBusEtaText(`🚌 ${raw}`), missedBus, buses,
  });
  const jumpsOf = (samples, pins) => unexplainedJumps(scoreSequence(samples, THRESHOLDS, { pins }));

  it("keeps the flag on a bus that dropped to a minute as it PULLED IN and then sat", () => {
    // Pink, 2026-09-08 19:05 ET. #124 arrives at stop 149, 297 m out; the card
    // goes "in 6" -> "in 1". The bus then stood there and took 7.7 min to
    // reach the board stop, so the jump moved the number AWAY from the truth.
    // A stand BEGINNING is not a departure and buys nothing.
    const PINK = [
      frame(1_788_894_726_988, "in 8, 25 min", [{ name: "#124", distM: 461, atStop: 46 }, { name: "#324", distM: 2426, atStop: null }]),
      frame(1_788_894_742_309, "in 7, 25 min", [{ name: "#124", distM: 328, atStop: null }, { name: "#324", distM: 2426, atStop: null }]),
      frame(1_788_894_757_628, "in 6, 25 min", [{ name: "#124", distM: 297, atStop: 149 }, { name: "#324", distM: 2426, atStop: null }]),
      frame(1_788_894_772_952, "in 1, 25 min", [{ name: "#124", distM: 269, atStop: 149 }, { name: "#324", distM: 2426, atStop: null }]),
    ];
    const pins = [{ atMs: 1_788_894_711_830, busName: "124" }, { atMs: 1_788_894_774_854, busName: "124" }];
    expect(standEndedFor(PINK, 3, "124")).toBe(false);
    expect(jumpsOf(PINK, pins).map((t) => t.to)).toEqual(["in 1, 25 min"]);
  });

  it("keeps the flag on a countdown that jumped OUTWARD while its bus closed in", () => {
    // Green, 2026-09-08 15:29 ET. "in <1, 10 min" -> "in 9, 20 min" with the
    // app announcing it had swapped vehicles — and #302, the bus it wrote off,
    // was 123 m out and reached the stop 32 s later. A stand ending can only
    // make a bus sooner, so a rise is never credited by it.
    const GREEN = [
      frame(1_788_882_244_579, "in 1, 10 min", [{ name: "#302", distM: 217, atStop: 23 }, { name: "#329", distM: 4669, atStop: null }, { name: "#126", distM: 9102, atStop: 84 }]),
      frame(1_788_882_261_473, "in <1, 10 min", [{ name: "#302", distM: 133, atStop: null }, { name: "#329", distM: 4266, atStop: null }, { name: "#126", distM: 9102, atStop: 84 }]),
      frame(1_788_882_276_779, "in 9, 20 min", [{ name: "#302", distM: 123, atStop: null }, { name: "#329", distM: 3895, atStop: null }, { name: "#126", distM: 9102, atStop: 84 }], 302),
    ];
    const pins = [{ atMs: 1_788_882_246_225, busName: "302" }, { atMs: 1_788_882_278_463, busName: "329" }];
    expect(jumpsOf(GREEN, pins).map((t) => t.to)).toContain("in 9, 20 min");
  });

  it("keeps the flag on the SECOND number when only some other bus left a stand", () => {
    // Red, 2026-09-08 12:47 ET. The card is pinned to #304, whose own number
    // does not move; the second number drops five minutes on the frame #307
    // leaves stop 121 after nine frozen fixes. Tempting, and refused: nothing
    // names the vehicle in slot 1, and across the archive a non-pinned stand
    // end sits under 32 % of catastrophic secondary drops against 45 % of
    // ordinary ones — likelier where nothing went wrong.
    const RED = [
      frame(1_788_872_351_618, "in 1, 35 min", [{ name: "#304", distM: 414, atStop: 11 }, { name: "#306", distM: 2446, atStop: 72 }, { name: "#307", distM: 3015, atStop: 121 }]),
      frame(1_788_872_366_913, "in 1, 35 min", [{ name: "#304", distM: 414, atStop: 11 }, { name: "#306", distM: 2546, atStop: null }, { name: "#307", distM: 3015, atStop: 121 }]),
      frame(1_788_872_382_221, "in 1, 35 min", [{ name: "#304", distM: 414, atStop: 11 }, { name: "#306", distM: 2636, atStop: null }, { name: "#307", distM: 3015, atStop: 121 }]),
      frame(1_788_872_397_531, "in 1, 35 min", [{ name: "#304", distM: 414, atStop: 11 }, { name: "#306", distM: 2636, atStop: null }, { name: "#307", distM: 3015, atStop: 121 }]),
      frame(1_788_872_412_854, "in 1, 30 min", [{ name: "#304", distM: 370, atStop: 11 }, { name: "#306", distM: 2676, atStop: 117 }, { name: "#307", distM: 2927, atStop: null }]),
    ];
    const pins = [{ atMs: 1_788_872_414_604, busName: "304" }];
    expect(standEndedFor(RED, 4, "307")).toBe(true);   // #307 really did leave
    expect(standEndedFor(RED, 4, "304")).toBe(true);   // so did the pinned bus
    expect(jumpsOf(RED, pins).map((t) => t.to)).toEqual(["in 1, 30 min"]);
  });

  it("names no vehicle when the nearest pin is too stale to be about this frame", () => {
    expect(pinnedVehicleAt([{ atMs: 1_000_000, busName: "#40" }], 1_000_000 + 200_000)).toBeNull();
    expect(pinnedVehicleAt([{ atMs: 1_000_000, busName: "#40" }], 1_000_000 + 1_000)).toBe("40");
    expect(pinnedVehicleAt([], 1_000_000)).toBeNull();
  });
});

describe("a watch that read no countdown", () => {
  it("blames the scraper when nothing was read and no bus ever arrived", () => {
    // 2026-09-04 14:47: five frames, zero readable countdowns, no arrival.
    expect(scraperMissedTheCountdown({ readings: 0, anyPresent: true, arrived: false })).toBe(true);
  });

  it("does not blame it when the watch ended because the bus reached the stop", () => {
    // 2026-09-08 19:24 Purple and 19:46 Orange Day: one reading each, 0.4 and
    // 0.5 min watched, `arrived` set. A successful ride, filed as a defect.
    expect(scraperMissedTheCountdown({ readings: 1, anyPresent: true, arrived: true })).toBe(false);
  });

  it("says nothing about a run where the option was never on the plan", () => {
    expect(scraperMissedTheCountdown({ readings: 0, anyPresent: false, arrived: false })).toBe(false);
  });
});

describe("the standing-bus range", () => {
  // REVERSED on 2026-09-09. The block that stood here asserted the range was
  // deliberately NOT scored, on the reasoning that reading either END of it
  // would see entering and leaving the range as a lurch of minutes. The first
  // half of that (a layover has no single arrival) is true; the second is not.
  // Every reading in this file is already an INTERVAL and `conservativeDrift`
  // reports the smallest movement two intervals permit, so a wide interval
  // yields drift 0 — the false lurch the old decision feared cannot occur.
  //
  // What the old decision cost: on the morning of 2026-09-09 the canary filed
  // three clean Red runs while the app billed ~4:45 at 344 Winchester against
  // real stands of 9:16, 2:20 and 2:15 and the countdown flapped between 1:57
  // and 3:09. Standing polls were the whole of that window and every one was
  // dropped on the floor.
  it("reads a range as the interval it is", () => {
    expect(parseBusEtaText("🚌 in 3-7 min")).toEqual({
      first: [180, 480], second: null, raw: "in 3-7 min", spread: true, bunched: false,
    });
    expect(parseBusEtaText("🚌 now-7 min").first).toEqual([0, 480]);
    expect(parseBusEtaText("🚌 in <1-7, then 19 min")).toEqual({
      first: [10, 480], second: [1140, 1200], raw: "in <1-7, then 19 min", spread: true,
      bunched: false,
    });
  });

  it("survives the measured drive floor unchanged — only the low end's VALUE moves", () => {
    // 2026-09-10: `standWait.ts` stopped RECONSTRUCTING the drive floor by
    // subtraction and took the model's own `departNow` instead, which is what
    // the operator's own card needed — it read `Red in <1-8, then 14 min` for
    // a bus standing at 344 Winchester, three hops and ~500 m from the board
    // stop. `fmtBusRange` is untouched, so this is not a layout change: every
    // string the countdown can produce is a form the parser already accepted,
    // and both spellings sit in this file above. Pinned so the claim is a test
    // rather than an argument.
    const before = parseBusEtaText("🚌 in <1-8, then 14 min");
    const after = parseBusEtaText("🚌 in 1-8, then 14 min");
    expect(before).toEqual({ first: [10, 540], second: [840, 900], raw: "in <1-8, then 14 min", spread: true, bunched: false });
    expect(after).toEqual({ first: [60, 540], second: [840, 900], raw: "in 1-8, then 14 min", spread: true, bunched: false });
    // The high end and the second bus are untouched, so a run spanning the
    // change reads as the low end tightening and nothing else.
    expect(after.first[1]).toBe(before.first[1]);
    expect(after.second).toEqual(before.second);
  });

  it("marks it, so a before/after over the archive can split on the boundary", () => {
    expect(parseBusEtaText("🚌 in 3-7 min").spread).toBe(true);
    expect(parseBusEtaText("🚌 in 3 min").spread).toBe(false);
  });

  it("cannot manufacture a lurch out of entering or leaving the range", () => {
    // The old decision's stated fear, tested rather than argued. "in 3 min"
    // ([180,240)) widening to "in 3-7 min" ([180,480]) is 15 s later: the
    // intervals overlap everywhere the clock allows, so the drift is zero.
    const plain = parseBusEtaText("🚌 in 3 min"), range = parseBusEtaText("🚌 in 3-7 min");
    expect(conservativeDrift(plain.first, range.first, 15)).toBe(0);
    expect(conservativeDrift(range.first, plain.first, 15)).toBe(0);
  });

  it("does not blunt the plain forms, or the ride bar", () => {
    expect(parseBusEtaText("🚌 in 3 min")).not.toBeNull();
    expect(parseBusEtaText("🚌 in 3, 19 min")).not.toBeNull();
    // `🚌 12 min` is the collapsed card's RIDE duration, not a countdown, and
    // `parseBusEtaText` is the arbiter that keeps the two apart.
    expect(parseBusEtaText("🚌 12 min")).toBeNull();
    expect(parseBusEtaText("🚌 3-7 min")).toBeNull();
  });
});

describe("flapping", () => {
  const mk = (lines, stepSec = 15) => lines.map((line, i) => ({
    present: true, atMs: Date.parse("2026-09-09T13:36:00Z") + i * stepSec * 1000,
    eta: parseBusEtaText(line),
  }));

  it("catches the sequence the operator watched on Red, which no jump metric sees", () => {
    // 09:36:00 4:36, :15 1:57, :30 3:09, :45 3:09, 09:37:00 1:57, :30 2:46 —
    // two states about 72 s apart, visited alternately. Every consecutive pair
    // is under `catastrophicSec`, so the jump loop passes it clean.
    const r = scoreSequence(mk(["🚌 in 4 min", "🚌 in 1 min", "🚌 in 3 min",
      "🚌 in 3 min", "🚌 in 1 min", "🚌 in 2 min"]));
    expect(r.catastrophic).toBe(0);
    expect(r.flapping).toBe(1);
    expect(r.flaps[0].moves).toBeGreaterThanOrEqual(THRESHOLDS.flapMinMoves);
    expect(r.flaps[0].leader).toBe(true);
  });

  it("says nothing about a healthy countdown", () => {
    const r = scoreSequence(mk(["🚌 in 8 min", "🚌 in 8 min", "🚌 in 7 min",
      "🚌 in 7 min", "🚌 in 6 min", "🚌 in 6 min"]));
    expect(r.flapping).toBe(0);
  });

  it("says nothing about one big move, however large", () => {
    // A 5 -> 1 on a departure is the app being right, and it must arrive
    // instantly (operator, 2026-09-03). One move is not an alternation.
    const r = scoreSequence(mk(["🚌 in 9 min", "🚌 in 9 min", "🚌 in 1 min",
      "🚌 in 1 min", "🚌 now, then 19 min"]));
    expect(r.flapping).toBe(0);
  });

  it("needs the moves to alternate, not merely to be large", () => {
    const r = scoreSequence(mk(["🚌 in 9 min", "🚌 in 7 min", "🚌 in 5 min",
      "🚌 in 3 min", "🚌 in 1 min"]));
    expect(r.flapping).toBe(0);
  });

  it("does not count a chain that took longer than a rider would stand for it", () => {
    const slow = scoreSequence(mk(["🚌 in 4 min", "🚌 in 1 min", "🚌 in 3 min",
      "🚌 in 1 min"], 200));
    expect(slow.flapping).toBe(0);
  });
});

describe("a browser network log is not a page error", () => {
  // 2026-09-10: a Red run failed `page-error` on six copies of
  // ERR_CONNECTION_CLOSED and nothing else — the canary's own link, which the
  // operator already ruled on for `feed-error` on 2026-09-04.
  it("exempts what the browser's network stack logs", () => {
    expect(isTransportNoise("console: Failed to load resource: net::ERR_CONNECTION_CLOSED")).toBe(true);
    expect(isTransportNoise("console: Failed to load resource: the server responded with a status of 502")).toBe(true);
  });

  it("does not exempt anything the app can do", () => {
    // The blank-screen class this listener exists for.
    expect(isTransportNoise("ReferenceError: Cannot access 'x' before initialization")).toBe(false);
    expect(isTransportNoise("console: TypeError: Cannot read properties of undefined")).toBe(false);
    // An uncaught fetch failure arrives as a pageerror, not a console message,
    // so it carries no `console: ` prefix and stays a finding.
    expect(isTransportNoise("TypeError: Failed to fetch")).toBe(false);
  });
});

describe("a bus that reaches the stop has not vanished", () => {
  // Green, 2026-09-10 17:23. #325 closed 351 -> 323 -> 189 -> 130 m under
  // "in <1, 8 min", then appeared at 47 m with `at_stop 25` — the board stop.
  // The card moved to the next bus and said so. The canary filed `bus-vanished`
  // AND `eta-jump`, because `departureBetween` sees a decreasing distance and
  // answers "closing", never "it got there".
  const BOARD = 25;
  const at = (ms, raw, buses) => ({ present: true, atMs: ms, eta: parseBusEtaText("🚌 " + raw), buses });
  const t0 = Date.parse("2026-09-10T21:23:16Z");
  const samples = [
    at(t0, "in <1, 8 min", [{ name: "325", distM: 130 }, { name: "332", distM: 6588 }]),
    at(t0 + 15000, "in 12, 21 min", [{ name: "325", distM: 47, atStop: BOARD }, { name: "332", distM: 6532 }]),
  ];

  it("credits the arrival, so the drop is not a finding", () => {
    const r = scoreSequence(samples, THRESHOLDS, { boardStopId: BOARD });
    const drop = r.drops.find((d) => d.severe);
    expect(drop, "the drop is still detected").toBeTruthy();
    expect(drop.eventful).toBe(true);
    expect(drop.event).toBe("arrival");
  });

  it("still fails the run when the bus is nowhere near the stop", () => {
    const far = [
      at(t0, "in <1, 8 min", [{ name: "325", distM: 400 }]),
      at(t0 + 15000, "in 12, 21 min", [{ name: "325", distM: 480 }]),
    ];
    const r = scoreSequence(far, THRESHOLDS, { boardStopId: BOARD });
    const drop = r.drops.find((d) => d.severe);
    expect(drop.eventful).toBe(false);
  });

  it("takes the feed's own at_stop and NOT the distance", () => {
    // 90 m out, but upstream says it is AT the board stop — ARRIVAL_M would
    // refuse this and the feed's own reckoning should not be second-guessed.
    expect(reachedBoardStop([{ name: "325", distM: 90, atStop: BOARD }], BOARD)).toBe(true);
    expect(reachedBoardStop([{ name: "325", distM: 90, atStop: 999 }], BOARD)).toBe(false);
    // Distance alone must NOT count: a bus closing through 60 m and being
    // dropped is the defect, not an arrival.
    expect(reachedBoardStop([{ name: "325", distM: 55 }], BOARD)).toBe(false);
  });

  it("says nothing without a board stop, so an old record scores as before", () => {
    expect(reachedBoardStop([{ name: "325", distM: 90, atStop: 25 }], null)).toBe(false);
  });
});


/**
 * THE EXPANDED CARD WITH A STANDING BUS, AFTER THE CHIP NAMED ITS QUANTITY
 * (2026-09-11).
 *
 * The pause chip in the expanded card's stop list used to read
 * "⏸ 3:08 · <1-8 min left" — which the operator read as an ARRIVAL, twelve
 * pixels under a row saying "in 2-9, then 17 min" and a bubble saying
 * "(R) 2-9 min". It says "leaves in <1-8 min" now.
 *
 * Nothing about that SHOULD reach the parser: the chip line starts with "⏸",
 * carries digits and a "·", and so matches neither `isLabelish` (letters and
 * spaces only) nor `parseBusEtaText`. But "nearby" was the same argument and
 * "Contribute" before it, and #111 "needed no change" too and blinded the
 * canary for twelve minutes — so this is a capture, not the argument. 390x844,
 * the operator's own Prospect / Canner -> School of Public Health trip, off a
 * staged build of this branch with #310's real fix and clocks replayed onto
 * /api/buses.
 *
 * Note what the capture shows about the DOM: the stop name, the bus glyph and
 * the chip are inline spans in one element, so `innerText` runs them together
 * as "🚌344 Winchester⏸ 3:26 · leaves in <1-7 min". That single line is
 * therefore neither label-shaped nor countdown-shaped, which is the belt to the
 * braces above.
 */
describe("the expanded card's standing chip", () => {
  const LIVE_STAND_LEAVES_IN = `SHUTTLE TRACKER
Trip
Map
Issues
↻
← All routes
RED ROUTE · Runs M–F 7a–6p
▴
🚌
🚌 (R) 2-9 min
🏁 (R) 9:12a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Red
Red
in 2-9, then 61 min
18 min
9:13a
⚠️
Due to Construction the State Street Station has been relocated to Chapel and Union.
🚶 1 min
›
⏳ <1-7 min
›
🚌 #310 · 12 min
published stop
expected stop
25 m
© OpenStreetMap contributors
Wait about 55 m past the published stop
Red buses actually stop there — seen 37 of the last 40 times one served this stop.
🧭 Directions to stop
🚌 I'm on it
·
🔔 Remind me
·
🚩 Report
📱 Yale tracker
▾
🚌 #310 · 3 stops away
🚌344 Winchester⏸ 3:26 · leaves in <1-7 min
Winchester/Division
Division/Sheffield
BOARDDivision/Prospect
Prospect/Hillside
SCL
130 Prospect Street (S)
College/Wall (S)
Phelps Gate
College/Crown
College/George
GET OFFLEPH/60 College
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("still reads the line as Red — not 'SCL', and not the chip", () => {
    // The detail view draws ONE card (`_detailOpen` hides the others), so one
    // option is the right answer here, not a truncated list.
    const opts = parseOptions(LIVE_STAND_LEAVES_IN);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Red"]);
    expect(opts[0]).toMatchObject({ totalMin: 18, arriveText: "9:13a" });
    expect(opts[0].eta.raw).toBe("in 2-9, then 61 min");
    // The range, read as an interval — 2 min at the earliest, 9 at the latest.
    expect(opts[0].eta.first).toEqual([120, 600]);
    expect(opts[0].eta.spread).toBe(true);
    // The stop list is still EVIDENCE, just not a source of route names: the
    // ride bar and the standing chip are both in the card's body.
    expect(opts[0].busLines).toContain("🚌 #310 · 12 min");
  });

  it("would have read the line as a stop name before the stop-list cut", () => {
    // The defect, stated as the thing that changed: "SCL" and "Phelps Gate" are
    // letters-only stop names on this very ride, below the duration.
    const lines = LIVE_STAND_LEAVES_IN.split("\n").map((l) => l.trim());
    expect(lines).toContain("SCL");
    expect(lines).toContain("Phelps Gate");
    expect(lines.indexOf("SCL")).toBeGreaterThan(lines.indexOf("18 min"));
  });

  it("does not take the chip for a countdown", () => {
    for (const l of [
      "⏸ 3:26 · leaves in <1-7 min",
      "⏸ 3:26 · leaves in 1-6 min",
      "⏸ 3:26 · leaves in ~1 min",
      "⏸ 3:26 · leaving any moment",
      "🚌344 Winchester⏸ 3:26 · leaves in <1-7 min",
    ]) expect(parseBusEtaText(l)).toBeNull();
  });
});
