import { describe, expect, it } from "vitest";

import {
  ANCHOR_CORROBORATION_M,
  ANCHOR_FEED_MOVE_M,
  ANCHOR_MAX_HOLD_MS,
  ANCHOR_M_PER_HOP,
  gateAnchor,
  pruneAnchors,
  type AnchorStore,
} from "./anchorGate";

// A degree of latitude is ~111 km; this keeps the fixtures readable in metres.
const M = 1 / 111_320;
const at = (northM: number) => ({ lat: 41.3 + northM * M, lon: -72.93 });
const N = 30; // stops on the pretend loop

function store(): AnchorStore {
  return new Map();
}

describe("gateAnchor", () => {
  it("accepts on first sight", () => {
    const s = store();
    const r = gateAnchor(s, "k", 7, { ...at(0), at_stop_id: null, last_stop_id: 1 }, 1000, N);
    expect(r).toEqual({ index: 7, released: "first" });
  });

  it("keeps the anchor while the raw one agrees", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 7, { ...at(10), last_stop_id: 1 }, 6000, N);
    expect(r).toEqual({ index: 7, released: "agrees" });
  });

  // The whole point: Green's two Orange/Pearl platforms are 35 m apart and 9
  // stops apart, so a twitch smaller than a bus must not move the bus a third
  // of a lap.
  it("holds a 9-stop jump produced by a 38 m twitch", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 16, { ...at(38), last_stop_id: 1 }, 6000, N);
    expect(r.index).toBe(7);
    expect(r.released).toBeNull();
  });

  it("holds a one-stop advance when the fix did not move at all", () => {
    // The eventless population: last_stop_id advances under a byte-identical
    // fix and the promise jumps a lap on zero new evidence.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 8, { ...at(0), last_stop_id: 2 }, 6000, N);
    expect(r.index).toBe(7);
    expect(r.released).toBeNull();
  });

  it("allows a one-stop advance once the bus has actually moved", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 8, { ...at(ANCHOR_FEED_MOVE_M + 5), last_stop_id: 1 }, 6000, N);
    expect(r).toEqual({ index: 8, released: "forward-consistent" });
  });

  it("scales the allowance with distance travelled", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    // Three hops needs roughly two hop-lengths of travel plus the first step.
    const far = ANCHOR_M_PER_HOP * 2 + 10;
    expect(gateAnchor(s, "k", 10, { ...at(far), last_stop_id: 1 }, 6000, N).index).toBe(10);
  });

  // The operator's constraint: "it can go 5->1 if it leaves early."
  it("releases in the SAME poll when the bus departs a stop", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: 40, last_stop_id: 40 }, 1000, N);
    // at_stop_id -> null is the collector saying it pulled out. Even with the
    // bus barely moved and the anchor jumping several stops, this must pass.
    const r = gateAnchor(s, "k", 12, { ...at(5), at_stop_id: null, last_stop_id: 40 }, 6000, N);
    expect(r).toEqual({ index: 12, released: "at-stop" });
  });

  it("releases in the same poll when the bus arrives at a stop", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: null, last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 8, { ...at(5), at_stop_id: 44, last_stop_id: 1 }, 6000, N);
    expect(r.released).toBe("at-stop");
  });

  it("never holds a disputed anchor beyond the timeout", () => {
    // Polled every 5 s throughout: the timeout only governs a bus that keeps
    // REPORTING. A bus that goes off the feed for longer than ANCHOR_STALE_MS
    // is reset by the staleness path instead, which is why this has to be
    // driven at the real poll cadence rather than by one big clock jump.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 0, N);
    let r = gateAnchor(s, "k", 16, { ...at(20), last_stop_id: 1 }, 5000, N);
    expect(r.index).toBe(7);
    let t = 5000;
    while (t < 5000 + ANCHOR_MAX_HOLD_MS) {
      t += 5000;
      r = gateAnchor(s, "k", 16, { ...at(20), last_stop_id: 1 }, t, N);
    }
    expect(r).toEqual({ index: 16, released: "timeout" });
  });

  it("does not let a backwards jump through on distance alone", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    // 25 stops forward on a 30-stop loop is 5 stops backwards.
    const r = gateAnchor(s, "k", 2, { ...at(ANCHOR_CORROBORATION_M * 3), last_stop_id: 1 }, 6000, N);
    expect(r.index).toBe(7);
    expect(r.released).toBeNull();
  });

  it("starts fresh for a bus that has been off the feed", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 20, { ...at(0), last_stop_id: 1 }, 1000 + 200_000, N);
    expect(r).toEqual({ index: 20, released: "stale" });
  });

  it("measures displacement from where the anchor was set, not from last poll", () => {
    // A bus creeping 30 m per poll must accumulate evidence; if displacement
    // reset every poll it could never corroborate anything.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 0, N);
    for (let i = 1; i <= 4; i++) {
      gateAnchor(s, "k", 7, { ...at(i * 30), last_stop_id: 1 }, i * 5000, N);
    }
    // 120 m from the origin now justifies two hops.
    const r = gateAnchor(s, "k", 9, { ...at(125), last_stop_id: 1 }, 25_000, N);
    expect(r).toEqual({ index: 9, released: "forward-consistent" });
  });

  it("does not let a twitching bus accumulate a false allowance", () => {
    // Path length grows without bound while NET displacement does not; the
    // gate must use the latter or it opens on exactly the wrong population.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 0, N);
    for (let i = 1; i <= 20; i++) {
      gateAnchor(s, "k", 7, { ...at(i % 2 ? 38 : 0), last_stop_id: 1 }, i * 5000, N);
    }
    const r = gateAnchor(s, "k", 16, { ...at(38), last_stop_id: 1 }, 105_000, N);
    expect(r.index).toBe(7);
  });

  it("prunes buses that have gone away", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);
    pruneAnchors(s, 1000);
    expect(s.size).toBe(1);
    pruneAnchors(s, 1000 + 200_000);
    expect(s.size).toBe(0);
  });
});
