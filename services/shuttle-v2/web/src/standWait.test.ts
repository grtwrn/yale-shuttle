import { describe, it, expect } from "vitest";
import { fromQuantiles, residual, residualMedian } from "./eta/dist";
import { fmtBusPair, fmtBusRange, fmtMin } from "./format";
import { standLeftText, standWaitFor, standWaitView, RANGE_MIN_SPREAD_SEC, chipCountdownText, waitLegText, type StandWaitView} from "./standWait";
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
    { elapsed: 0,   chip: "1-9 min left",     range: "in 4-12 min", truth: "12 min", overdue: false },
    { elapsed: 201, chip: "<1-6 min left", range: "in 3-9 min",  truth: "8 min",  overdue: false },
    { elapsed: 300, chip: "<1-5 min left", range: "in 3-8 min",  truth: "7 min",  overdue: true },
    { elapsed: 480, chip: "<1-4 min left", range: "in 3-7 min",  truth: "4 min",  overdue: true },
    { elapsed: 540, chip: "<1-4 min left", range: "in 3-7 min",  truth: "3 min",  overdue: true },
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
    // Was "<1-1 min left" until 2026-09-10, when the operator read that on a
    // live Blue Day card ("reads a little funny") — the two tokens differ only
    // by the "<", so it is two spellings of about a minute rather than a range.
    expect(v.leftText).toBe("~1 min left");
  });

  it("leaves the board stop alone — the bus is there, the rider should board", () => {
    expect(standWaitView({ elapsedSec: 540, stand: standAt(540), etaSec: 0, atBoardStop: true })!.range).toBeNull();
  });

  it("has no range without a countdown to bound", () => {
    const v = standWaitView({ elapsedSec: 540, stand: standAt(540), etaSec: null, atBoardStop: false })!;
    expect(v.range).toBeNull();
    expect(v.departNowSec).toBeNull();
    expect(v.leftText).toBe("<1-4 min left");
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
    expect(standLeftText(90, 400)).toBe("1-6 min left");
  });
  it("quotes both ends, including a low end inside a minute", () => {
    expect(standLeftText(13, 293)).toBe("<1-4 min left");
  });
  it("collapses to one figure when the ends round together", () => {
    expect(standLeftText(130, 170)).toBe("~2 min left");
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
    expect(standLeftText(20, 75)).toBe("~1 min left");
    expect(standLeftText(59, 119)).toBe("~1 min left");
  });

  it("leaves every other neighbouring pair alone", () => {
    expect(standLeftText(180, 240)).toBe("3-4 min left");
    expect(standLeftText(30, 150)).toBe("<1-2 min left");
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
