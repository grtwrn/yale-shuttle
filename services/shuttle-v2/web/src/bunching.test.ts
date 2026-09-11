import { describe, expect, it } from "vitest";
import { bunchDecision, BUNCHED_SUFFIX, fmtBusLine } from "./bunching";

const M = (m: number) => m * 60;

describe("bunchDecision — are these two buses one statement or two?", () => {
  it("calls slot 2 inside slot 1's printed interval bunched — the 22:19 Orange Night card", () => {
    // "in 23-36, then 35 min": #49 standing 14:37 at 100 Church Street South,
    // #51 nine stops behind it, its median landing six minutes inside #49's
    // own band. The truth was 14 minutes apart.
    const d = bunchDecision({
      leadSec: M(29), leadBand: { lowSec: M(23), highSec: M(36) }, nextSec: M(35),
    });
    expect(d).toEqual({ bunched: true, reason: "inside-band" });
  });

  it("calls two points that print the same minute bunched — the 22:28 card", () => {
    const d = bunchDecision({ leadSec: M(25) + 10, nextSec: M(25) + 50 });
    expect(d).toEqual({ bunched: true, reason: "same-minute" });
  });

  it("leaves clearly separate buses alone, banded or not", () => {
    expect(bunchDecision({ leadSec: M(12), nextSec: M(21) }))
      .toEqual({ bunched: false, reason: null });
    expect(bunchDecision({
      leadSec: M(5), leadBand: { lowSec: M(3), highSec: M(7) }, nextSec: M(21),
    })).toEqual({ bunched: false, reason: null });
  });

  it("has no second bus to bunch with", () => {
    expect(bunchDecision({ leadSec: M(4) })).toEqual({ bunched: false, reason: null });
    expect(bunchDecision({ leadSec: M(4), nextSec: null })).toEqual({ bunched: false, reason: null });
    expect(bunchDecision({ leadSec: M(4), nextSec: NaN })).toEqual({ bunched: false, reason: null });
  });

  it("reads slot 2's OWN band, which is the half the pinned-bus context could not see", () => {
    // #51 moving and pinned at 25 min; #49 standing behind it, so its arrival
    // is anywhere from 25 to 40. Same uncertainty as 22:19, hidden by slot
    // order until `nextStandCtx` existed.
    expect(bunchDecision({
      leadSec: M(25), nextSec: M(31), nextBand: { lowSec: M(25), highSec: M(40) },
    })).toEqual({ bunched: true, reason: "next-band-overlap" });
    // A band that stays clear of slot 1's number is still two buses.
    expect(bunchDecision({
      leadSec: M(25), nextSec: M(31), nextBand: { lowSec: M(28), highSec: M(40) },
    })).toEqual({ bunched: false, reason: null });
  });

  it("takes the band's upper edge as INSIDE it — the printed interval names that minute", () => {
    const band = { lowSec: M(23), highSec: M(36) };
    expect(bunchDecision({ leadSec: M(29), leadBand: band, nextSec: M(36) }).reason)
      .toBe("inside-band");
    // 36:59 still prints "36 min", so it is the same edge.
    expect(bunchDecision({ leadSec: M(29), leadBand: band, nextSec: M(36) + 59 }).reason)
      .toBe("inside-band");
    // The first minute clear of it is two buses again.
    expect(bunchDecision({ leadSec: M(29), leadBand: band, nextSec: M(37) }).bunched)
      .toBe(false);
  });

  it("compares DISPLAYED minutes, not seconds", () => {
    // The band's high end is 36:40, printed "36 min"; slot 2 at 36:10 is
    // inside the printed interval even though it is under the raw high end,
    // and at 36:50 it is inside even though it is over it.
    const band = { lowSec: M(23), highSec: M(36) + 40 };
    expect(bunchDecision({ leadSec: M(30), leadBand: band, nextSec: M(36) + 10 }).bunched).toBe(true);
    expect(bunchDecision({ leadSec: M(30), leadBand: band, nextSec: M(36) + 50 }).bunched).toBe(true);
  });

  it("follows fmtBusRange's own collapse: a band that prints as one number is a point", () => {
    // Both ends inside the same minute — the line prints "in 4 min", so slot 2
    // is judged against that minute, not against a 40-second interval.
    const band = { lowSec: M(4) + 5, highSec: M(4) + 45 };
    expect(bunchDecision({ leadSec: M(4) + 30, leadBand: band, nextSec: M(4) + 50 }))
      .toEqual({ bunched: true, reason: "same-minute" });
    expect(bunchDecision({ leadSec: M(4) + 30, leadBand: band, nextSec: M(5) }).bunched)
      .toBe(false);
  });

  it("handles the sub-minute tokens as the display spells them", () => {
    // "now" and "<1" are distinct printed values, so they are not one minute.
    expect(bunchDecision({ leadSec: 5, nextSec: 30 }).bunched).toBe(false);
    expect(bunchDecision({ leadSec: 20, nextSec: 50 }))
      .toEqual({ bunched: true, reason: "same-minute" });
  });
});

describe("fmtBusLine — the countdown line, all four forms", () => {
  it("leaves every unbunched form byte-identical to fmtBusPair/fmtBusRange", () => {
    expect(fmtBusLine({ leadSec: M(12), nextSec: M(21) })).toBe("in 12, 21 min");
    expect(fmtBusLine({ leadSec: M(22), nextSec: null })).toBe("in 22 min");
    expect(fmtBusLine({ leadSec: 5 })).toBe("arriving now");
    expect(fmtBusLine({ leadSec: 5, nextSec: M(11) })).toBe("now, then 11 min");
    expect(fmtBusLine({ leadSec: 45, nextSec: M(11) })).toBe("in <1, 11 min");
    expect(fmtBusLine({
      leadSec: M(5), leadBand: { lowSec: M(3), highSec: M(7) }, nextSec: M(21),
    })).toBe("in 3-7, then 21 min");
    expect(fmtBusLine({ leadSec: M(5), leadBand: { lowSec: M(3), highSec: M(7) } }))
      .toBe("in 3-7 min");
  });

  it("says the interval once plus the cause when the two have bunched", () => {
    expect(fmtBusLine({
      leadSec: M(29), leadBand: { lowSec: M(23), highSec: M(36) }, nextSec: M(35),
    })).toBe("23-36 min · 2 buses");
    expect(fmtBusLine({ leadSec: M(25) + 10, nextSec: M(25) + 50 }))
      .toBe("25 min · 2 buses");
    expect(fmtBusLine({
      leadSec: M(25), nextSec: M(31), nextBand: { lowSec: M(25), highSec: M(40) },
    })).toBe("25 min · 2 buses");
  });

  it("keeps the words where there is no \"in\" to drop", () => {
    // "arriving now" and "now-6 min" open with a word, not a preposition.
    expect(fmtBusLine({ leadSec: 5, nextSec: 8 })).toBe("arriving now · 2 buses");
    expect(fmtBusLine({
      leadSec: M(3), leadBand: { lowSec: 5, highSec: M(6) }, nextSec: M(4),
    })).toBe("now-6 min · 2 buses");
    // "<1 min" keeps its "<" and loses the "in" like any other number.
    expect(fmtBusLine({ leadSec: 20, nextSec: 50 })).toBe("<1 min · 2 buses");
  });

  it("keeps the cause out of the line whenever the two numbers stand apart", () => {
    const line = fmtBusLine({ leadSec: M(12), nextSec: M(21) });
    expect(line).not.toContain(BUNCHED_SUFFIX);
  });

  it("never prints a second interval — slot 2's band is evidence, not text", () => {
    // Even unbunched, a standing slot-2 bus gets its point and nothing else:
    // "in 3-7, then 30-44 min" is four numbers on a line that holds two.
    const line = fmtBusLine({
      leadSec: M(5), leadBand: { lowSec: M(3), highSec: M(7) },
      nextSec: M(30), nextBand: { lowSec: M(30), highSec: M(44) },
    });
    // (That band overlaps nothing here — 30 > 7 — so the pair survives.)
    expect(line).toBe("in 3-7, then 30 min");
    expect(line.match(/-/g)).toHaveLength(1);
  });
});
