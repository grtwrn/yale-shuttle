import { describe, expect, it } from "vitest";
import { arriveByClock, bandTitle, boardArrivalText, chipCountdownText, displayBand, RANGE_MAX_SHOWN_MIN, RANGE_MIN_SHOWN_MIN, shownMinutes, standingLowFloor, waitLegText } from "./etaBand";
import { fmtBusLine } from "./bunching";
import { readFileSync } from "node:fs";
import { fmtClock } from "./format";

const M = (m: number) => m * 60;

describe("displayBand — when the estimator's band is worth printing", () => {
  it("prints a band whose ends are at least RANGE_MIN_SHOWN_MIN printed minutes apart", () => {
    expect(RANGE_MIN_SHOWN_MIN).toBe(3);
    expect(displayBand(M(2), M(9), undefined, 0)).toEqual({ lowSec: M(2), highSec: M(9) });
    expect(displayBand(M(6) + 20, M(18) + 40, undefined, 0)).toEqual({ lowSec: M(6) + 20, highSec: M(18) + 40 });
  });

  it("leaves a narrow band as the point it is — 2 printed minutes covered the arrival only 58-79% of the time", () => {
    expect(displayBand(M(4), M(6) + 59, undefined, 0)).toBeNull(); // 4 and 6: two minutes apart
    expect(displayBand(M(4), M(7), undefined, 0)).not.toBeNull();   // 4 and 7: three
    expect(displayBand(M(3) + 50, M(4) + 10, undefined, 0)).toBeNull();
  });

  it("caps a band too wide to be useful — the Green 9-52 min case (RANGE_MAX_SHOWN_MIN)", () => {
    expect(RANGE_MAX_SHOWN_MIN).toBe(15);
    // "(G) 9-52 min" — a 43-minute span, useless to a rider. Prints as the
    // point (null band) instead.
    expect(displayBand(M(9), M(52), undefined, 0)).toBeNull();
    // Exactly at the cap still prints: shownMinutes(15+3) - shownMinutes(3) = 15.
    expect(displayBand(M(3), M(18), undefined, 0)).toEqual({ lowSec: M(3), highSec: M(18) });
    // One printed minute past the cap is capped.
    expect(displayBand(M(3), M(19), undefined, 0)).toBeNull();
    // A normal band well inside both bounds is unaffected.
    expect(displayBand(M(2), M(9), undefined, 0)).toEqual({ lowSec: M(2), highSec: M(9) });
  });

  it("is nothing for a bus at the board stop (0-0) or with no band at all", () => {
    expect(displayBand(0, 0, undefined, 0)).toBeNull();
    expect(displayBand(undefined, undefined, undefined, 0)).toBeNull();
    expect(displayBand(NaN, M(9), undefined, 0)).toBeNull();
  });

  it("ticks both ends down with the wall clock, exactly as the point does (report #48)", () => {
    const at = 1_000_000;
    const b = displayBand(M(2), M(9), at, at + 30_000)!;
    expect(b.lowSec).toBe(M(2) - 30);
    expect(b.highSec).toBe(M(9) - 30);
    // A low end that has ticked to zero stays a band while the high end is far.
    const late = displayBand(M(2), M(9), at, at + 200_000)!;
    expect(late.lowSec).toBe(0);
    expect(late.highSec).toBe(M(9) - 200);
  });

  it("floors a STANDING bus's low end at departNow + the shortest stand left — a low end no bus can beat", () => {
    // The 344 Winchester screenshot: band now-10 for a bus standing three
    // hops out, drive 2 min, at least 20 s of stand still to run.
    const floor = standingLowFloor(120, 20);
    expect(floor).toBe(140);
    expect(displayBand(0, M(10), undefined, 0, floor)).toEqual({ lowSec: 140, highSec: M(10) });
    // A moving bus passes no floor and keeps the band as measured.
    expect(displayBand(0, M(10), undefined, 0, undefined)).toEqual({ lowSec: 0, highSec: M(10) });
    expect(standingLowFloor(undefined, 20)).toBeUndefined();
    // The floor is not decayed: it is drive still to come, none of it served.
    const at = 1_000_000;
    expect(displayBand(0, M(10), at, at + 30_000, 140)).toEqual({ lowSec: 140, highSec: M(10) - 30 });
    // A floor at or above the high end leaves no band to print.
    expect(displayBand(M(2), M(4), undefined, 0, M(4))).toBeNull();
  });

  it("counts printed minutes on fmtMin's own buckets", () => {
    expect(shownMinutes(5)).toBe(0);
    expect(shownMinutes(45)).toBe(0.5);
    expect(shownMinutes(179)).toBe(2);
  });
});

describe("one belief, one screen — the row, the chip and the wait leg print the same band", () => {
  const band = { lowSec: M(2), highSec: M(9) };

  it("the row prints the band, the chip the same without its head word", () => {
    expect(fmtBusLine({ leadSec: M(5), leadBand: band, nextSec: M(17) })).toBe("in 2-9, then 17 min");
    expect(chipCountdownText(band, M(5))).toBe("2-9 min");
  });

  it("the chip without a band is fmtMin's own spelling, byte-identical to before", () => {
    expect(chipCountdownText(null, M(4))).toBe("4 min");
    expect(chipCountdownText(null, 5)).toBe("now");
    expect(chipCountdownText(null, null)).toBeNull();
  });

  it("the wait leg is the same band less the walk to the stop", () => {
    expect(waitLegText(band, M(5), 60, M(4))).toBe("1-8 min");
    expect(waitLegText(band, M(5), M(8), 0)).toBe("now-1 min");
    // Nothing left to wait for once the whole band is inside the walk.
    expect(waitLegText(band, M(5), M(9), 0)).toBeNull();
    // No band: the leg's own wait, as before.
    expect(waitLegText(null, M(5), 60, M(4))).toBe("4 min");
    expect(waitLegText(null, M(5), 60, 30)).toBeNull();
  });

  it("the tooltip says what the three numbers are", () => {
    expect(bandTitle(band, M(5))).toBe("Most likely about 5 min. Four arrivals in five fall between 2 min and 9 min; the bus may leave a stop early or hold longer.");
  });
});

describe("boardArrivalText — the arrival on the BOARD row, named as one", () => {
  it("is the map chip's words behind the verb that says ARRIVAL", () => {
    const band = { lowSec: M(2), highSec: M(9) };
    expect(boardArrivalText(band, M(5))).toBe(`arrives in ${chipCountdownText(band, M(5))}`);
    // A median under the band's low end prints the band alone, with or without #237.
    expect(boardArrivalText(band, M(1))).toBe("arrives in 2-9 min");
    expect(boardArrivalText(null, M(4))).toBe("arrives in 4 min");
    expect(boardArrivalText(null, 45)).toBe("arrives in <1 min");
  });

  it("prints the row's own numbers, spelling a 'now' low end as the duration it is", () => {
    // #240 stopped flooring a standing bus's low end, so a band that reaches
    // "now" is the ordinary case again. The row leads with "now" because it is
    // an ARRIVAL word there; after "arrives in" the same quantity is a
    // DURATION, and standLeftText spells that "<1" for the same reason. Same
    // statement, same high end, one number each way.
    const band = { lowSec: 5, highSec: M(10) };
    expect(fmtBusLine({ leadSec: M(4), leadBand: band, nextSec: M(17) })).toBe("now-10, then 17 min");
    expect(chipCountdownText(band, M(4))).toBe("now-10 min");
    expect(boardArrivalText(band, M(4))).toBe("arrives in <1-10 min");
  });

  it("never says 'arrives in now'", () => {
    expect(boardArrivalText(null, 5)).toBe("arriving now");
    // A band whose low end is inside ten seconds: "now" is an arrival's word,
    // and as the low end of a range it is spelled as a duration.
    expect(boardArrivalText({ lowSec: 5, highSec: M(6) }, 15)).toBe("arrives in <1-6 min");
    const withMedian = boardArrivalText({ lowSec: 5, highSec: M(6) }, M(3))!;
    expect(withMedian).not.toContain("now");
    expect(withMedian).toMatch(/^arrives in .*<1-6\)? min$/);
  });

  it("is nothing when there is no arrival", () => {
    expect(boardArrivalText(null, null)).toBeNull();
    expect(boardArrivalText({ lowSec: M(2), highSec: M(9) }, null)).toBeNull();
  });

  it("does not borrow the departure's verb", () => {
    for (const eta of [5, 45, M(4), M(12)]) expect(boardArrivalText(null, eta)).not.toMatch(/leav/);
  });
});

/**
 * "by 2:23p" — the promised arrival clock (operator, 2026-09-12: "do we need
 * ranges on the arrival time too? or just put latest time?").
 *
 * A fixed LOCAL wall time, built without a `Z` so the expectations hold in any
 * timezone the suite runs in — the same idiom as `format.test.ts`'s clock
 * block. 2:00p, so a 23-minute promise reads as the operator's own example.
 */
const TWO_PM = new Date("2026-09-12T14:00:00").getTime();
const MIN = 60;

describe("arriveByClock — one latest time, not a range", () => {
  const base = { walkFromSec: 0, totalSec: 19 * MIN, computedAtMs: TWO_PM };

  it("prints the alight q90 as an absolute clock, with the word", () => {
    const by = arriveByClock({ ...base, alightHighSec: 23 * MIN }, TWO_PM);
    expect(by?.text).toBe("by 2:23p");
    // The spelling the canary's ARRIVAL_CLOCK_RE must accept — pinned there
    // too (canary-metrics.test.mjs), because a card it cannot recognise is a
    // blind harness, which is how #111 and #123 each cost real watching time.
    expect(by!.text).toMatch(/^by \d{1,2}:\d{2}[ap]$/);
    expect(by?.sec).toBe(23 * MIN);
  });

  it("adds the trailing walk, because the q90 is the BUS at the alight stop", () => {
    expect(arriveByClock({ ...base, alightHighSec: 20 * MIN, walkFromSec: 3 * MIN }, TWO_PM)?.text)
      .toBe("by 2:23p");
  });

  it("is a FIXED instant — it does not slide forward between polls", () => {
    // Same payload, read a minute later: the countdown beside it has ticked
    // down by 60 s and the promise has not moved at all.
    const first = arriveByClock({ ...base, alightHighSec: 23 * MIN }, TWO_PM);
    const later = arriveByClock({ ...base, alightHighSec: 23 * MIN }, TWO_PM + 60_000);
    expect(first?.text).toBe("by 2:23p");
    expect(later?.text).toBe("by 2:23p");
    expect(later?.sec).toBe(22 * MIN);
  });

  it("declines with no forecast — the column prints its median clock as before", () => {
    expect(arriveByClock({ ...base, alightHighSec: undefined }, TWO_PM)).toBeNull();
    expect(arriveByClock({ ...base, alightHighSec: NaN }, TWO_PM)).toBeNull();
  });

  it("declines a ceiling EARLIER than the median total — that is not a ceiling", () => {
    // The estimator's chain to the alight stop and the planner's
    // segment-average sum are different arithmetics; when they disagree this
    // way the promise would undercut the number printed beside it.
    expect(arriveByClock({ ...base, alightHighSec: 10 * MIN }, TWO_PM)).toBeNull();
  });

  it("retires a promise that has already elapsed", () => {
    // `remainingSec` clamps at zero, so a passed instant sinks below totalSec
    // and falls out through the coherence guard rather than printing a time in
    // the past.
    expect(arriveByClock({ ...base, alightHighSec: 23 * MIN }, TWO_PM + 40 * 60_000)).toBeNull();
  });

  it("declines past RANGE_MAX_SHOWN_MIN beyond the median, as the band itself does", () => {
    // Exactly at the cap still promises...
    expect(arriveByClock({ ...base, alightHighSec: 34 * MIN }, TWO_PM)?.text).toBe("by 2:34p");
    // ...one printed minute past it does not: Green's undecided out-and-back
    // branch is a 43-minute span, and a preposition does not make it usable.
    expect(arriveByClock({ ...base, alightHighSec: 35 * MIN }, TWO_PM)).toBeNull();
    expect(arriveByClock({ ...base, alightHighSec: 60 * MIN }, TWO_PM)).toBeNull();
  });

  it("drops the word when it would print the median's own minute", () => {
    // "by 2:19p" over a median of 2:19p promises nothing the bare number did.
    expect(arriveByClock({ ...base, alightHighSec: 19 * MIN + 20 }, TWO_PM)).toBeNull();
  });

  /**
   * WIDTH, at 390 px — MEASURED, not counted. Counting characters is how a
   * wrapping line shipped once (2026-09-03), so the rendered span was probed
   * in headless chromium at 390x844 against a staged build of this branch
   * (2026-09-12, Blue Weekend and Green cards, live buses):
   *
   *     "by 12:58p"   60.1 px   ← the widest form, 9 characters
   *     "by 12:15p"   57.4 px
   *     "12:29p"      41.6 px   ← the fallback, for comparison
   *
   * Every one a single 16 px line with `white-space: nowrap`, right edge at
   * 337 px, and `scrollWidth === clientWidth` at the span's column, at the
   * option row and at the document (390 === 390) — nothing overflows and the
   * page does not scroll sideways. The row it sits in is 304 px wide, so the
   * promise spends a fifth of it.
   *
   * The bound below is kept as the CHEAP regression test, since a unit test
   * cannot open a browser: the column has always fitted future mode's
   * two-clock range, and the promise is one clock and a two-letter word.
   */
  it("is narrower than the range this column already fits", () => {
    const noon = new Date("2026-09-12T12:00:00").getTime();
    // The widest the promise gets: a two-digit hour, both digits of the minute.
    const widest = arriveByClock(
      { walkFromSec: 0, totalSec: 32 * MIN, alightHighSec: 44 * MIN, computedAtMs: noon }, noon,
    );
    expect(widest?.text).toBe("by 12:44p");
    // What future mode prints in the same column today, at its widest.
    const futureRange = `${fmtClock(0, new Date(noon))} \u2013 ${fmtClock(38 * MIN, new Date(noon))}`;
    expect(futureRange).toBe("12:00p \u2013 12:38p");
    expect(widest!.text.length).toBeLessThan(futureRange.length);
  });

  it("says what it is in the tooltip, without claiming a frequency it has not measured", () => {
    const by = arriveByClock({ ...base, alightHighSec: 23 * MIN }, TWO_PM);
    expect(by?.title).toContain("90th percentile");
    expect(by?.title).toContain("2:19p"); // the median, for contrast
  });
});

/**
 * WHERE IT IS DRAWN, pinned at the source. `TransitMap.tsx` cannot be rendered
 * by this repo's harness, so the call sites are asserted as text — the accepted
 * substitute here, and the only way to state that the placement is a DECISION
 * rather than an omission.
 *
 * The promise replaces the trip card's right-column clock and goes NOWHERE
 * ELSE. Two surfaces also print a clock and are deliberately untouched:
 *
 *   * the overview map's 🏁 chip, because a chip label that grows merges with
 *     its neighbours and stacks — the operator's "this is an eye sore", and
 *     `chipCluster.ts` records that the standing range's wider labels are what
 *     made it worse. Three characters there cost more than they buy.
 *   * the Map tab's stop rows, whose 10 px grey clock is the arrival of a BUS
 *     at that stop rather than the end of anyone's trip, and whose countdown
 *     already carries the band.
 */
describe("the promised clock is drawn in exactly one place", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");

  it("is the trip card's right-hand column, falling back to the median clock", () => {
    expect(src).toContain("(arriveBy?.text ?? fmtClock(o.totalSec))");
  });

  it("is priced from the alight stop's q90 on the pinned bus, never from the ride average", () => {
    expect(src).toContain("alightHighSec: o.busAlightHighSec");
    expect(src).toContain("busAlightHighSec: alightHighFor(match.busName, match.stopsAhead)");
  });

  it("is called ONCE — a new surface has to come back and read the note above", () => {
    expect(src.match(/arriveByClock\(/g)?.length).toBe(1);
  });

  it("leaves the overview map chip and the Map tab's stop rows on their median clocks", () => {
    expect(src).toContain("arriveAt: o.departed ? null : fmtClock(o.totalSec - o.walkFromSec");
    expect(src).toContain("{fmtClock(e.eta)}");
  });

  it("leaves future mode's departure range alone — there is no live bus to promise from", () => {
    expect(src).toContain("`${fmtClock(0, targetDate!)} – ${fmtClock(o.totalSec, targetDate!)}`");
  });
});
