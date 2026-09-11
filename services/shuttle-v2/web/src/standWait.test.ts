import { describe, it, expect } from "vitest";
import { fromQuantiles, residual, residualMedian } from "./eta/dist";
import { fmtBusPair, fmtBusRange, fmtMin } from "./format";
import { readFileSync } from "node:fs";
import { standChipFor, standLeftText, standWaitFor, standWaitView, stopEtaText, RANGE_MIN_SPREAD_SEC, chipCountdownText, waitLegText, type StandWaitView} from "./standWait";
import RED_STAND from "./__fixtures__/red-stand-2026-09-11.json";
import { shownStandSec, type DwellStat } from "./arrivals";

/**
 * The stand the operator watched on 2026-09-07: a Red bus at 344 Winchester.
 * These are the SERVED quantiles, and the truth is that it stood 9:16.
 */
const WINCHESTER_Q = [49, 125, 140, 167, 262, 307, 372, 433, 502, 642];
const TRUTH_SEC = 9 * 60 + 16;
/** Drive from the stand to the rider's board stop — the part no departure skips. */
const DRIVE_SEC = 180;

const table = fromQuantiles(WINCHESTER_Q);
const TYPICAL = residualMedian(table, 0); // 283 s = 4:43

/** What `shownStandSec` hands the render site at `elapsed`, from this table. */
function standAt(elapsed: number) {
  const rest = residual(table, elapsed);
  return { sec: rest(0.5), remaining: true as const, soonSec: rest(0.1), lateSec: rest(0.9), typicalSec: TYPICAL };
}
/** The countdown the rider reads: the stand still to run, plus the drive. */
function etaAt(elapsed: number) {
  return DRIVE_SEC + standAt(elapsed).sec;
}
/** What the countdown SHOULD have said, knowing the stand ended at 9:16. */
function truthAt(elapsed: number) {
  return DRIVE_SEC + (TRUTH_SEC - elapsed);
}
function viewAt(elapsed: number, atBoardStop = false) {
  return standWaitView({ elapsedSec: elapsed, stand: standAt(elapsed), etaSec: etaAt(elapsed), atBoardStop })!;
}
const mins = (s: string) => Number(s.replace(/[^0-9]/g, ""));

describe("standWait — the 344 Winchester stand, poll by poll", () => {
  // Every row was hand-checked against the operator's own table (the
  // conditional total at 3:21 is 6:36, at 9:00 it is 10:28). `truth` is what a
  // perfect countdown would have shown at that instant.
  const rows: { elapsed: number; chip: string; range: string; truth: string; overdue: boolean }[] = [
    { elapsed: 0,   chip: "leaves in 1-9 min",     range: "in 4-12 min", truth: "12 min", overdue: false },
    { elapsed: 201, chip: "leaves in <1-6 min", range: "in 3-9 min",  truth: "8 min",  overdue: false },
    { elapsed: 300, chip: "leaves in <1-5 min", range: "in 3-8 min",  truth: "7 min",  overdue: true },
    { elapsed: 480, chip: "leaves in <1-4 min", range: "in 3-7 min",  truth: "4 min",  overdue: true },
    { elapsed: 540, chip: "leaves in <1-4 min", range: "in 3-7 min",  truth: "3 min",  overdue: true },
  ];

  for (const row of rows) {
    it(`says the right thing ${row.elapsed} s into the stand`, () => {
      const v = viewAt(row.elapsed);
      expect(v.leftText).toBe(row.chip);
      expect(v.range).not.toBeNull();
      expect(fmtBusRange(v.range!.lowSec, v.range!.highSec)).toBe(row.range);
      expect(fmtMin(truthAt(row.elapsed))).toBe(row.truth);
      expect(v.overdue).toBe(row.overdue);
    });
  }

  it("brackets the 9:16 truth at every one of those polls — no point estimate did", () => {
    for (const row of rows) {
      const v = viewAt(row.elapsed);
      const truth = truthAt(row.elapsed);
      // As MINUTES, which is what the rider reads: at elapsed 0 the q90 is
      // 9:14 against a 9:16 stand, two seconds short, and both floor to the
      // same minute. Everywhere else there is room to spare.
      expect(mins(fmtMin(v.range!.lowSec))).toBeLessThanOrEqual(mins(fmtMin(truth)));
      expect(mins(fmtMin(v.range!.highSec))).toBeGreaterThanOrEqual(mins(fmtMin(truth)));
      // And the chip's ceiling covers what was really left of the stand.
      expect(v.lateSec).toBeGreaterThanOrEqual(TRUTH_SEC - row.elapsed - 3);
    }
  });

  it("never shows anything below the drive floor, at any second of the stand", () => {
    for (let e = 0; e <= 900; e += 5) {
      const v = viewAt(e);
      expect(v.departNowSec).toBeCloseTo(DRIVE_SEC, 6);
      expect(v.range!.lowSec).toBeGreaterThanOrEqual(DRIVE_SEC);
      // The point number the range replaces sits inside it, so the change can
      // never move the answer the model actually bills.
      expect(v.range!.lowSec).toBeLessThanOrEqual(etaAt(e));
      expect(v.range!.highSec).toBeGreaterThanOrEqual(etaAt(e));
    }
  });

  it("is the fix for the overshoot the operator named: 10:28 against a 9:16 truth", () => {
    // Nine minutes in, the conditional TOTAL is 10:28 — later than the stand
    // actually ran. As a countdown that is "in 4 min" when the bus was there
    // in 3, and a rider who strolls misses it.
    const e = 540;
    expect(e + standAt(e).sec).toBeGreaterThan(TRUTH_SEC);
    expect(fmtBusPair(etaAt(e))).toBe("in 4 min");
    expect(fmtMin(truthAt(e))).toBe("3 min");
    // The range's low end is the truth, and it cannot be later: it assumes the
    // bus leaves this second.
    const v = viewAt(e);
    expect(fmtMin(v.range!.lowSec)).toBe("3 min");
  });

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

describe("standWait — when NOT to draw a range", () => {
  const kerb = { sec: 20, remaining: true as const, soonSec: 5, lateSec: 60, typicalSec: 25 };

  it("leaves an ordinary kerb stop alone — its spread says nothing", () => {
    const v = standWaitView({ elapsedSec: 10, stand: kerb, etaSec: 300, atBoardStop: false })!;
    expect(kerb.lateSec - kerb.soonSec).toBeLessThan(RANGE_MIN_SPREAD_SEC);
    expect(v.range).toBeNull();
    // Still an honest ceiling, just a short one — and no range beside it.
    // Was "<1-1 min" until 2026-09-10, when the operator read that on a
    // live Blue Day card ("reads a little funny") — the two tokens differ only
    // by the "<", so it is two spellings of about a minute rather than a range.
    expect(v.leftText).toBe("leaves in ~1 min");
  });

  it("leaves the board stop alone — the bus is there, the rider should board", () => {
    expect(standWaitView({ elapsedSec: 540, stand: standAt(540), etaSec: 0, atBoardStop: true })!.range).toBeNull();
  });

  it("has no range without a countdown to bound", () => {
    const v = standWaitView({ elapsedSec: 540, stand: standAt(540), etaSec: null, atBoardStop: false })!;
    expect(v.range).toBeNull();
    expect(v.departNowSec).toBeNull();
    expect(v.leftText).toBe("leaves in <1-4 min");
  });

  it("writes the tooltip as a sentence, not the chip's shorthand", () => {
    // Reusing `leftText` here once produced "About leaving any moment to go".
    const kerbView = standWaitView({ elapsedSec: 10, stand: kerb, etaSec: 300, atBoardStop: false })!;
    expect(kerbView.chipTitle).toBe("Standing 0:10 (usually ~0:25 here). It can pull out at any moment, and about 1 min more at the outside.");
    const late = viewAt(540);
    expect(late.chipTitle).toContain("already past the ~4:43 it usually holds");
    const early = standWaitView({ elapsedSec: 0, stand: standAt(0), etaSec: etaAt(0), atBoardStop: false })!;
    expect(early.chipTitle).toContain("About 1-9 min still to go, and it can pull out sooner.");
  });

  it("says nothing for a stand that is not a remainder", () => {
    expect(standWaitView({ elapsedSec: 0, stand: { sec: 300, remaining: false }, etaSec: 400, atBoardStop: false })).toBeNull();
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
    const v = standWaitFor({ stopId: 11, standingSec: 540 }, ROUTE, undefined, 400, 27)!;
    expect(v.remainingSec).toBeCloseTo(stand.sec, 6);
    expect(v.departNowSec).toBeCloseTo(400 - stand.sec, 6);
  });

  it("is silent where there is no bus standing, and where the stop has no table", () => {
    expect(standWaitFor(null, ROUTE, undefined, 400, 27)).toBeNull();
    expect(standWaitFor({ stopId: 99, standingSec: 60 }, ROUTE, undefined, 400, 27)).toBeNull();
  });
});

describe("the map chip and the card agree", () => {
  // 2026-09-10, operator: "its a little weird showing a definitive answer in
  // map and a range in the stop list". The chip had been observed going
  // 5 -> 1 -> 2 min on a bus that was standing still the whole time.
  const view = (low: number, high: number) =>
    ({ range: { lowSec: low, highSec: high } }) as unknown as StandWaitView;

  it("prints the range the card prints, without the head word", () => {
    // 30 s is inside the `<1` bucket; 60 s is already "1 min" — the boundary
    // that made a drive floor of exactly 60 s print as "1", not "<1".
    expect(chipCountdownText(view(30, 540), 200)).toBe("<1-9 min");
    expect(chipCountdownText(view(60, 540), 200)).toBe("1-9 min");
    expect(chipCountdownText(view(180, 420), 300)).toBe("3-7 min");
  });

  it("falls back to the point number when the bus is not standing", () => {
    expect(chipCountdownText(null, 240)).toBe("4 min");
    expect(chipCountdownText(null, 30)).toBe("<1 min");
    expect(chipCountdownText(null, 5)).toBe("now");   // fmtMin, as the chip always spelled it
  });

  it("says nothing when there is nothing to say", () => {
    expect(chipCountdownText(null, null)).toBeNull();
  });

  it("prefers the range over the point, so the two surfaces cannot differ", () => {
    // The point is what the map used to show on its own; with a range in hand
    // it must never win.
    expect(chipCountdownText(view(30, 540), 60)).toBe("<1-9 min");
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

describe("the detailed wait leg", () => {
  const view = { range: { lowSec: 120, highSec: 600 } } as StandWaitView;
  it("keeps the pickup range when the rider is already at the stop", () => {
    expect(waitLegText(view, 0, 300)).toBe("2-10 min");
  });
  it("subtracts the walk from both bounds instead of counting it twice", () => {
    expect(waitLegText(view, 120, 180)).toBe("now-8 min");
    expect(waitLegText(view, 90, 210)).toBe("<1-8 min");
    expect(waitLegText(view, 600, 0)).toBeNull();
  });
  it("shows uncertainty even when the point wait is under a minute", () => {
    expect(waitLegText(view, 0, 0)).toBe("2-10 min");
  });
  it("preserves moving-bus point waits and hides negligible waits", () => {
    expect(waitLegText(null, 120, 300)).toBe("5 min");
    expect(waitLegText(null, 0, 20)).toBeNull();
  });
});

describe("the drive floor is measured, not reconstructed (operator, 2026-09-10)", () => {
  /**
   * `Red  in <1-8, then 14 min`, off the operator's own card. The bus was
   * standing at 344 Winchester (stop 11), three hops and ~500 m from the board
   * stop Division / Prospect (48). "<1 min" is not a number a bus can make.
   *
   * The mechanism, isolated: `departNowSec` was `etaSec - remainingSec`, and
   * those are not two readings of one quantity. `etaSec` is decayed by wall
   * clock, carries the route and horizon corrections and is held DOWN by
   * #119's clamp; `remainingSec` is `shownStandSec`'s fresh pass at the
   * current elapsed clock with none of that. On a stand that has run past its
   * table the second overtakes the first, `Math.max(0, ...)` floors the
   * difference at zero, and the low end becomes `soonSec` alone — a stand
   * quantile with no drive in it, which late in a long stand is itself ~0.
   */
  const DEGENERATE = {
    elapsedSec: 540,
    // A remainder that EXCEEDS the countdown beside it. This is the input the
    // regression must never survive again, pinned directly rather than
    // conjured out of a clock.
    stand: { sec: 300, remaining: true as const, soonSec: 20, lateSec: 420, typicalSec: 283 },
    etaSec: 200,
    atBoardStop: false,
  };
  /** The model's own `departNow` for that chain (eta/arrival.ts). */
  const FLOOR = 83;

  it("collapsed to a bare stand quantile — the drive term went missing", () => {
    const v = standWaitView(DEGENERATE)!;
    expect(v.departNowSec).toBe(0);           // 200 - 300, floored
    expect(v.range!.lowSec).toBe(20);         // soonSec alone
    expect(fmtBusRange(v.range!.lowSec, v.range!.highSec)).toBe("in <1-7 min");
  });

  it("takes the model's own drive instead, and prints a minute the bus can make", () => {
    const v = standWaitView({ ...DEGENERATE, driveFloorSec: FLOOR })!;
    expect(v.departNowSec).toBe(FLOOR);
    expect(v.range!.lowSec).toBe(FLOOR + 20);
    expect(fmtBusRange(v.range!.lowSec, v.range!.highSec)).toBe("in 1-8 min");
  });

  it("never prints a low end below the drive, at any second of a long stand", () => {
    for (let e = 0; e <= 1200; e += 5) {
      const v = standWaitView({ elapsedSec: e, stand: standAt(e), etaSec: etaAt(e) - 120, atBoardStop: false, driveFloorSec: FLOOR })!;
      expect(v.departNowSec).toBeGreaterThanOrEqual(FLOOR);
      if (v.range) expect(v.range.lowSec).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("only ever RAISES: where the subtraction was already larger it wins", () => {
    // A bus 10 minutes out with 60 s of stand left — the drive really is 540 s
    // and the model's floor for the same chain would be about that. The
    // reconstruction is the honest bound here and must not be thrown away.
    const far = { elapsedSec: 30, stand: { sec: 60, remaining: true as const, soonSec: 10, lateSec: 400, typicalSec: 90 }, etaSec: 600, atBoardStop: false };
    expect(standWaitView({ ...far, driveFloorSec: 83 })!.departNowSec).toBe(540);
    expect(standWaitView(far)!.departNowSec).toBe(540);
  });

  it("is byte-identical to the old arithmetic when no floor is served", () => {
    // An un-plumbed caller — a test, a hypothetical, an option with no pinned
    // arrival row — prices exactly as before, so nothing degrades silently.
    for (let e = 0; e <= 900; e += 15) {
      const a = standWaitView({ elapsedSec: e, stand: standAt(e), etaSec: etaAt(e), atBoardStop: false });
      const b = standWaitView({ elapsedSec: e, stand: standAt(e), etaSec: etaAt(e), atBoardStop: false, driveFloorSec: undefined });
      expect(b).toEqual(a);
      expect(a!.departNowSec).toBeCloseTo(DRIVE_SEC, 6);
    }
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
  const view = () => standWaitFor(
    rest, CASE.dwells, undefined, CASE.etaSec, CASE.boardStopId, CASE.departNowSec,
  )!;

  it("reproduces the row, the bubble and the chip the operator read", () => {
    const v = view();
    expect(fmtBusRange(v.range!.lowSec, v.range!.highSec)).toBe(CASE.shown.row);
    expect(chipCountdownText(v, CASE.etaSec)).toBe(CASE.shown.bubble);
    expect(standChipFor(rest, CASE.dwells, undefined)!.clock).toBe("3:10");
    // The words the chip carries NOW. The reported string was "<1-8 min left".
    expect(standChipFor(rest, CASE.dwells, undefined)!.text).toBe(CASE.shown.chip);
    // What the operator actually read, kept so the report is legible from here.
    expect(CASE.shown.reportedChip).toBe("<1-8 min left");
  });

  it("ties the two quantities: stand remaining + the drive floor = the arrival band", () => {
    const v = view();
    expect(Math.round(v.soonSec)).toBe(56);
    expect(Math.round(v.remainingSec)).toBe(241);
    expect(Math.round(v.lateSec)).toBe(487);
    expect(Math.round(v.departNowSec!)).toBe(CASE.departNowSec);
    // Exactly, not approximately — the range IS the remainder shifted by the
    // drive. A rider who reads "leaves in <1-8" and adds a minute gets 2-9.
    expect(v.range!.lowSec).toBeCloseTo(v.departNowSec! + v.soonSec, 6);
    expect(v.range!.highSec).toBeCloseTo(Math.max(v.departNowSec! + v.lateSec, CASE.etaSec), 6);
  });

  it("says DEPARTURE for the chip and ARRIVAL for everything else", () => {
    const chip = standChipFor(rest, CASE.dwells, undefined)!;
    // The one word that separates them. "left" was read as "left until it gets
    // here", which is the row's quantity, not this one.
    expect(chip.text).toMatch(/^(leaves in |leaving )/);
    expect(chip.text).not.toMatch(/left$/);
    // ...and no surface that means ARRIVAL borrows the departure's words.
    for (const s of [
      fmtBusRange(view().range!.lowSec, view().range!.highSec),
      chipCountdownText(view(), CASE.etaSec)!,
      waitLegText(view(), 180, 0)!,
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
    const withEta = standWaitFor(rest, CASE.dwells, undefined, CASE.etaSec, CASE.boardStopId, CASE.departNowSec)!;
    expect(trip.text).toBe(withEta.leftText);
    expect(trip.overdue).toBe(withEta.overdue);
    expect(trip.title).toBe(withEta.chipTitle);
  });

  it("gives the Map tab's own row for the board stop the row's answer, not a point", () => {
    // `fmtMin(117 s)` is "1 min" — what that surface printed while the trip card
    // and its minimap both said "2-9 min" off the same `UpcomingArrival`, and
    // BELOW the model's own drive floor of 72 s + 56 s of stand.
    expect(fmtMin(CASE.etaSec)).toBe("1 min");
    expect(stopEtaText(
      rest, { eta: CASE.etaSec, departNow: CASE.departNowSec },
      CASE.boardStopId, CASE.dwells, undefined,
    )).toBe(CASE.shown.bubble);
  });

  it("leaves a stop with no standing bus exactly as it was — a bare point", () => {
    // The fall-through has to be byte-identical or every row of every card moves.
    for (const eta of [0, 9, 45, 117, 300, 1804]) {
      expect(stopEtaText(null, { eta }, 48, CASE.dwells, undefined)).toBe(fmtMin(eta));
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
    expect(src).toContain('import { chipCountdownText, standChipFor, standWaitFor, stopEtaText, waitLegText } from "./standWait";');
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
