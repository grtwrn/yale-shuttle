import { describe, it, expect } from "vitest";
import { fromQuantiles, residual, residualMedian } from "./eta/dist";
import { fmtMin } from "./format";
import { fmtBusLine } from "./bunching";
import { waitLegText } from "./etaBand";
import { readFileSync } from "node:fs";
import { arrivalBand, standChipFor, standLeftText, standWaitFor, standWaitView, stopEtaText } from "./standWait";
import RED_STAND from "./__fixtures__/red-stand-2026-09-11.json";
import { shownStandSec, type DwellStat } from "./arrivals";

/**
 * The stand the operator watched on 2026-09-07: a Red bus at 344 Winchester.
 * These are the SERVED quantiles, and the truth is that it stood 9:16.
 */
const WINCHESTER_Q = [49, 125, 140, 167, 262, 307, 372, 433, 502, 642];
const TRUTH_SEC = 9 * 60 + 16;

const table = fromQuantiles(WINCHESTER_Q);
const TYPICAL = residualMedian(table, 0); // 283 s = 4:43

/** What `shownStandSec` hands the render site at `elapsed`, from this table. */
function standAt(elapsed: number) {
  const rest = residual(table, elapsed);
  return { sec: rest(0.5), remaining: true as const, soonSec: rest(0.1), lateSec: rest(0.9), typicalSec: TYPICAL };
}
function viewAt(elapsed: number) {
  return standWaitView({ elapsedSec: elapsed, stand: standAt(elapsed) })!;
}

describe("standWait — the 344 Winchester stand, poll by poll", () => {
  // Every row was hand-checked against the operator's own table (the
  // conditional total at 3:21 is 6:36, at 9:00 it is 10:28). The truth was
  // 9:16; the countdown's RANGE for these polls now comes from the
  // estimator's band (etaBand.ts) and is pinned there.
  const rows: { elapsed: number; chip: string; overdue: boolean }[] = [
    { elapsed: 0,   chip: "leaves in 1-9 min",  overdue: false },
    { elapsed: 201, chip: "leaves in <1-6 min", overdue: false },
    { elapsed: 300, chip: "leaves in <1-5 min", overdue: true },
    { elapsed: 480, chip: "leaves in <1-4 min", overdue: true },
    { elapsed: 540, chip: "leaves in <1-4 min", overdue: true },
  ];

  for (const row of rows) {
    it(`says the right thing ${row.elapsed} s into the stand`, () => {
      const v = viewAt(row.elapsed);
      expect(v.leftText).toBe(row.chip);
      expect(v.overdue).toBe(row.overdue);
    });
  }

  it("stops quoting the typical hold as if it were the remainder", () => {
    // The chip used to print `typicalSec` — 4:43 — beside 3:21 elapsed, which
    // a rider subtracts to 1:22. The model's own answer was 3:15, and the
    // stand in fact had 5:55 to run.
    const v = viewAt(201);
    expect(v.remainingSec).toBeGreaterThan(TYPICAL - 201);
    expect(v.chipTitle).toContain("Standing 3:21");
    expect(v.chipTitle).toContain("4:43");
    expect(v.lateSec).toBeGreaterThan(TRUTH_SEC - 201);
  });
});

describe("standWait — the chip's words", () => {
  const kerb = { sec: 20, remaining: true as const, soonSec: 5, lateSec: 60, typicalSec: 25 };

  it("collapses an ordinary kerb stop to about a minute", () => {
    const v = standWaitView({ elapsedSec: 10, stand: kerb })!;
    // Was "<1-1 min" until 2026-09-10, when the operator read that on a
    // live Blue Day card ("reads a little funny") — the two tokens differ only
    // by the "<", so it is two spellings of about a minute rather than a range.
    expect(v.leftText).toBe("leaves in ~1 min");
  });

  it("writes the tooltip as a sentence, not the chip's shorthand", () => {
    // Reusing `leftText` here once produced "About leaving any moment to go".
    const kerbView = standWaitView({ elapsedSec: 10, stand: kerb })!;
    expect(kerbView.chipTitle).toBe("Standing 0:10 (usually ~0:25 here). It can pull out at any moment, and about 1 min more at the outside.");
    const late = viewAt(540);
    expect(late.chipTitle).toContain("already past the ~4:43 it usually holds");
    const early = standWaitView({ elapsedSec: 0, stand: standAt(0) })!;
    expect(early.chipTitle).toContain("About 1-9 min still to go, and it can pull out sooner.");
  });

  it("says nothing for a stand that is not a remainder", () => {
    expect(standWaitView({ elapsedSec: 0, stand: { sec: 300, remaining: false } })).toBeNull();
  });
});

describe("standLeftText — a ceiling once the bus is free to go", () => {
  it("quotes both ends while the shortest plausible stand is still a wait", () => {
    expect(standLeftText(90, 400)).toBe("leaves in 1-6 min");
  });
  it("quotes both ends, including a low end inside a minute", () => {
    expect(standLeftText(13, 293)).toBe("leaves in <1-4 min");
  });
  it("collapses to one figure when the ends round together", () => {
    expect(standLeftText(130, 170)).toBe("leaves in ~2 min");
  });
  it("is a state, not a number, when even the long end is seconds", () => {
    expect(standLeftText(2, 30)).toBe("leaving any moment");
  });
});

describe("standWaitFor — composed from what a render site already holds", () => {
  const WINCHESTER: DwellStat = { med: 574.9, sd: 279.8, n: 28, q: WINCHESTER_Q, qn: 28, pstop: 0.954 };
  const KERB: DwellStat = { med: 30, sd: 20, n: 40, q: [0, 12, 15, 18, 22, 26, 31, 40, 55, 90], qn: 40 };
  const ROUTE: Record<string, DwellStat> = { "11": WINCHESTER, "27": KERB };

  it("reads the stand through shownStandSec — the one source the countdown is billed from", () => {
    const stand = shownStandSec(WINCHESTER, 540, ROUTE)!;
    expect(stand.soonSec).toBeDefined();
    expect(stand.lateSec).toBeDefined();
    expect(stand.soonSec!).toBeLessThanOrEqual(stand.sec);
    expect(stand.lateSec!).toBeGreaterThanOrEqual(stand.sec);
    const v = standWaitFor({ stopId: 11, standingSec: 540 }, ROUTE, undefined)!;
    expect(v.remainingSec).toBeCloseTo(stand.sec, 6);
  });

  it("is silent where there is no bus standing, and where the stop has no table", () => {
    expect(standWaitFor(null, ROUTE, undefined)).toBeNull();
    expect(standWaitFor({ stopId: 99, standingSec: 60 }, ROUTE, undefined)).toBeNull();
  });
});

describe("the one adjacent pair that reads wrong", () => {
  // Operator, 2026-09-10, on a Blue Day bus standing 1:28 at Prospect/Edwards:
  // "<1-1min reads a little funny". The two tokens differ only by the "<", so
  // the line says "less than a minute to a minute" — not a range, two
  // spellings of the same thing.
  it("collapses <1 .. 1 rather than printing both", () => {
    expect(standLeftText(20, 75)).toBe("leaves in ~1 min");
    expect(standLeftText(59, 119)).toBe("leaves in ~1 min");
  });

  it("leaves every other neighbouring pair alone", () => {
    expect(standLeftText(180, 240)).toBe("leaves in 3-4 min");
    expect(standLeftText(30, 150)).toBe("leaves in <1-2 min");
  });

  it("still says 'leaving any moment' when even the high end is inside a minute", () => {
    expect(standLeftText(5, 40)).toBe("leaving any moment");
  });
});

/**
 * ONE PAYLOAD, EVERY STOP LIST (operator, 2026-09-11).
 *
 * "im seeing different estimates in the route list and the minimap … look down
 * at the stop list it had different numbers." Red #310, standing at
 * 344 Winchester; the rider at Prospect / Canner bound for the School of Public
 * Health. Four surfaces, reproduced from production (`predictions_log` +
 * `raw_positions` + the served tables in the fixture beside this file):
 *
 *   collapsed row      "in 2-9, then 17 min"
 *   minimap bubble     "(R) 2-9 min"
 *   wait leg           "⏳ now-6 min"
 *   expanded stop list "344 Winchester  3:08 · <1-8 min left"
 *
 * All four came from ONE belief and all four were right — the stand's remainder
 * is q10/q50/q90 = 56/241/487 s and the model's own drive floor to the board
 * stop is 72 s, so the row's 2-9 IS the chip's <1-8 plus the drive. Two
 * quantities, an arrival and a departure, and nothing on screen said which was
 * which. That is what these tests pin: the arithmetic that ties them, and the
 * words that tell them apart.
 *
 * The Map tab's route cards were a different matter — a genuine second
 * arithmetic, `dwell.med ± sd` for the hold and a bare point for the arrival —
 * which is why both stop lists now compose through `standChipFor` and
 * `stopEtaText` and neither builds its own string.
 */
describe("the 2026-09-11 Red card — one belief, four surfaces", () => {
  const CASE = RED_STAND as {
    standingStopId: number; boardStopId: number; standingSec: number;
    etaSec: number; departNowSec: number;
    shown: { row: string; chip: string; bubble: string; reportedChip: string };
    dwells: Record<string, DwellStat>;
  };
  const rest = { stopId: CASE.standingStopId, standingSec: CASE.standingSec, approach: false };
  const view = () => standWaitFor(rest, CASE.dwells, undefined)!;
  /**
   * The band the row printed that day, fed in as the arrival's own: the
   * estimator's `low`/`high` are not in the recording, and what the operator
   * read was departNow + the stand's q10 and q90 — 128 s and 559 s. With the
   * standing floor at departNow + soonSec (= 128 s) the band prints the same.
   */
  const arrival = () => ({
    eta: CASE.etaSec, departNow: CASE.departNowSec,
    low: CASE.departNowSec + view().soonSec, high: CASE.departNowSec + view().lateSec,
  });
  const band = () => arrivalBand(view(), arrival(), 0)!;

  it("reproduces the row, the bubble and the chip the operator read", () => {
    const v = view();
    // The median (117 s, held by #119's clamp) sits UNDER the floored low
    // end, so the row prints the band alone — exactly the recorded string.
    expect(fmtBusLine({ leadSec: CASE.etaSec, leadBand: band() })).toBe(CASE.shown.row);
    expect(stopEtaText(rest, arrival(), CASE.dwells, undefined)).toBe(CASE.shown.bubble);
    expect(standChipFor(rest, CASE.dwells, undefined)!.clock).toBe("3:10");
    // The words the chip carries NOW. The reported string was "<1-8 min left".
    expect(standChipFor(rest, CASE.dwells, undefined)!.text).toBe(CASE.shown.chip);
    // What the operator actually read, kept so the report is legible from here.
    expect(CASE.shown.reportedChip).toBe("<1-8 min left");
    expect(Math.round(v.soonSec)).toBe(56);
    expect(Math.round(v.remainingSec)).toBe(241);
    expect(Math.round(v.lateSec)).toBe(487);
  });

  it("does NOT lift a standing bus's low end (the #228 floor was refused on measurement)", () => {
    // Real arrivals beat departNow + the shortest stand left on 31–52% of
    // standing pairs, so the printed low end must be the estimator's own.
    const lowered = arrivalBand(view(), { ...arrival(), low: 0 }, 0)!;
    expect(lowered.lowSec).toBe(0);
    expect(lowered.highSec).toBeCloseTo(band().highSec, 6);
    // Standing and moving buses now print the same band for the same arrival.
    expect(arrivalBand(null, { ...arrival(), low: 0 }, 0)).toEqual(lowered);
  });

  it("says DEPARTURE for the chip and ARRIVAL for everything else", () => {
    const chip = standChipFor(rest, CASE.dwells, undefined)!;
    // The one word that separates them. "left" was read as "left until it gets
    // here", which is the row's quantity, not this one.
    expect(chip.text).toMatch(/^(leaves in |leaving )/);
    expect(chip.text).not.toMatch(/left$/);
    // ...and no surface that means ARRIVAL borrows the departure's words.
    for (const s of [
      fmtBusLine({ leadSec: CASE.etaSec, leadBand: band() }),
      stopEtaText(rest, arrival(), CASE.dwells, undefined)!,
      waitLegText(band(), CASE.etaSec, 60, 0)!,
    ]) expect(s).not.toMatch(/leav/);
  });

  it("gives BOTH stop lists the identical chip for the identical bus", () => {
    // The trip card's expanded stop list and the Map tab's route card call the
    // same function with the same belief and the same table, so there is nothing
    // left to disagree — which is the whole point of it being a function.
    const trip = standChipFor(rest, CASE.dwells, undefined)!;
    const map = standChipFor({ ...rest }, CASE.dwells, undefined)!;
    expect(map).toEqual(trip);
    // And the chip's own fields do not depend on the arrival it sits beside:
    // the trip card's row builds its view WITH a countdown and a drive floor,
    // the chip builds one without, and the two must still say the same thing.
    const withEta = standWaitFor(rest, CASE.dwells, undefined)!;
    expect(trip.text).toBe(withEta.leftText);
    expect(trip.overdue).toBe(withEta.overdue);
    expect(trip.title).toBe(withEta.chipTitle);
  });

  it("gives the Map tab's own row for the board stop the row's answer, not a point", () => {
    // `fmtMin(117 s)` is "1 min" — what that surface printed while the trip card
    // and its minimap both said "2-9 min" off the same `UpcomingArrival`, and
    // BELOW the model's own drive floor of 72 s + 56 s of stand.
    expect(fmtMin(CASE.etaSec)).toBe("1 min");
    expect(stopEtaText(rest, arrival(), CASE.dwells, undefined)).toBe(CASE.shown.bubble);
  });

  it("leaves a stop with no standing bus exactly as it was — a bare point", () => {
    // The fall-through has to be byte-identical or every row of every card moves.
    for (const eta of [0, 9, 45, 117, 300, 1804]) {
      expect(stopEtaText(null, { eta }, CASE.dwells, undefined)).toBe(fmtMin(eta));
    }
    expect(standChipFor(null, CASE.dwells, undefined)).toBeNull();
  });

  /**
   * THE TYPICAL-HOLD BADGE, which the Map tab derived from `dwell.med ± sd`.
   * That figure is arrival-to-arrival and so contains the drive into the hop,
   * which is the mistake arrivals.ts documents twice. Measured on this very
   * payload it is not a rounding difference.
   */
  it("reads the typical hold off the model, not off dwell.med", () => {
    const win = CASE.dwells["11"]!;
    // What the Map tab used to badge: round(557.4/60)-round(757.6/60).
    expect(`${Math.round(win.med / 60)}-${Math.round((win.med + win.sd!) / 60)} min`).toBe("9-13 min");
    // What the model says the stand at that stop typically is.
    const typical = shownStandSec(win, null, CASE.dwells, undefined)!;
    expect(Math.round(typical.sec)).toBe(299);
    expect(typical.sec).toBeLessThan(win.med / 2 + 60);
  });
});

/**
 * NEITHER STOP LIST COMPOSES ITS OWN CHIP. Source-level, in the idiom of
 * `mapFilter.test.ts`: the two render sites are 1,100 lines apart in one 8k-line
 * file and have drifted apart twice already (a per-bus dwell beside a route
 * dwell, then `dwell.med` beside the conditional quantiles). A test that only
 * checked the functions would pass either way.
 */
describe("the render sites read the shared composition", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");

  it("imports both helpers and calls each twice", () => {
    expect(src).toContain('import { arrivalBand, standChipFor, standWaitFor, stopEtaText } from "./standWait";');
    expect(src).toContain('import { bandTitle, waitLegText } from "./etaBand";');
    // The trip card's expanded stop list and the Map tab's route card.
    expect(src.match(/standChipFor\(/g)?.length).toBe(2);
    // The trip card's minimap chip and the Map tab's per-stop countdown.
    expect(src.match(/stopEtaText\(/g)?.length).toBe(2);
  });

  it("has retired the arrival-to-arrival median and the bare point", () => {
    // `dwell.med ± sd` as a hold to PUT ON SCREEN. It is the whole hop, drive
    // included, and no stop list may quote it as a stand.
    expect(src).not.toMatch(/longDwell/);
    expect(src).not.toMatch(/\.med \+ [a-zA-Z]*\.?sd\)? \/ 60/);
    // A bare point for a stop's arrival, beside surfaces that print a range.
    expect(src).not.toContain("fmtMin(e.eta)");
  });

  it("does not let the Map tab's stop rows read the payload's own clock", () => {
    // `at_stop_id` / `at_stop_since` are withheld for a bus resting short of its
    // layover marker, which is what made the chip go blank beside a countdown
    // that was pricing the rest (report #102). The belief answers instead.
    // Scoped to `stopRow`: the map MARKER's tooltip legitimately reports the raw
    // "at stop N min", which is a fact about the feed and sits beside no ETA.
    const from = src.indexOf("const stopRow = (stopId: number");
    const to = src.indexOf("// Collapsed card:", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // Comments may still NAME the retired fields; code may not read them.
    const stopRow = src.slice(from, to).replace(/^\s*\/\/.*$/gm, "");
    expect(stopRow).not.toContain("at_stop_since");
    expect(stopRow).not.toContain("at_stop_id");
    expect(stopRow).toContain("standChipFor(");
    expect(stopRow).toContain("stopEtaText(");
  });
});
