import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bucketOf, conservativeDrift, parseBusEtaText, parseOptions, parseWaitFallback,
  scoreSequence, THRESHOLDS,
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
    expect(r.transitions[0]).toMatchObject({ reversal: true, pinAnnouncedChange: true });
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
