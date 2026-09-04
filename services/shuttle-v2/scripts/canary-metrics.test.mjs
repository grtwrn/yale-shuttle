import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ARRIVAL_CLOCK_RE, ARRIVAL_M, brokenPromise, bucketOf, CANARY_LINES, CANONICAL_MAX_WALK_M,
  CANONICAL_TRIP, conservativeDrift, deadlineForPromise, DEPARTURE_M,
  departureBetween, fleetOffAir, hasArrivalClock, haversineM, isAtBoardStop, MAX_WALK_M, MIN_RIDE_M, NEAR_STOP_M,
  pairBuses, parseBusEtaText, parseOptions, parseWaitFallback, runVerdict,
  scoreSequence, THRESHOLDS, tripForLine,
} from "./canary-metrics.mjs";

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

describe("rideableLines", () => {
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
