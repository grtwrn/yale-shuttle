import { describe, expect, it } from "vitest";
import { bandTitle, chipCountdownText, displayBand, RANGE_MAX_SHOWN_MIN, RANGE_MIN_SHOWN_MIN, shownMinutes, standingLowFloor, waitLegText } from "./etaBand";
import { fmtBusLine } from "./bunching";

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
