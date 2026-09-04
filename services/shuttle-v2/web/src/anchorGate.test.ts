import { describe, expect, it } from "vitest";

import {
  ANCHOR_CORROBORATION_M,
  ANCHOR_FEED_MOVE_M,
  ANCHOR_MAX_HOLD_MS,
  ANCHOR_M_PER_HOP,
  ANCHOR_STALE_MS,
  gateAnchor,
  noteFix,
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

  // The largest defect class left after the gate shipped (9 h replay,
  // production layover clock: 1,500 one-stop-backward flips, 1,091 on this
  // signal). The feed's last_stop_id lags a stop, so the instant the at-stop
  // flag clears the stateless scan answers with the chord INTO the stop the
  // bus has just left, and that stop flips from a lap away to "now".
  it("does not retreat to the chord into the stop the bus has just left", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: 40, last_stop_id: 39 }, 1000, N);
    // Departure poll: 80 m out, flag cleared, raw scan says 6 (the leg into 40).
    const r = gateAnchor(s, "k", 6, { ...at(80), at_stop_id: null, last_stop_id: 39 }, 6000, N);
    expect(r.index).toBe(7);
    expect(r.released).toBeNull();
    // Still says 6 a poll later (the feed has not caught up): still 7.
    const r2 = gateAnchor(s, "k", 6, { ...at(120), at_stop_id: null, last_stop_id: 39 }, 11000, N);
    expect(r2.index).toBe(7);
    // The feed catches up and the scan agrees: no jump at all along the way.
    const r3 = gateAnchor(s, "k", 7, { ...at(160), at_stop_id: null, last_stop_id: 40 }, 16000, N);
    expect(r3).toEqual({ index: 7, released: "agrees" });
  });

  it("still lets a departure through when the scan reads forward", () => {
    // "it can go 5->1 if it leaves early": only the one backward answer is
    // declined. Forward (or unchanged) on the departure poll passes as before.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: 40, last_stop_id: 39 }, 1000, N);
    const r = gateAnchor(s, "k", 8, { ...at(80), at_stop_id: null, last_stop_id: 40 }, 6000, N);
    expect(r).toEqual({ index: 8, released: "at-stop" });
  });

  it("still lets a departure through when the scan relocates elsewhere", () => {
    // A fold-back flip on the departure poll is the flag change's to vouch
    // for, exactly as it was — this is not a new hold, only a declined -1.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: 40, last_stop_id: 39 }, 1000, N);
    const r = gateAnchor(s, "k", 3, { ...at(80), at_stop_id: null, last_stop_id: 39 }, 6000, N);
    expect(r).toEqual({ index: 3, released: "at-stop" });
  });

  it("records the departure, so a later flip cannot ride the stale flag", () => {
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: 40, last_stop_id: 39 }, 1000, N);
    gateAnchor(s, "k", 6, { ...at(80), at_stop_id: null, last_stop_id: 39 }, 6000, N);
    expect(s.get("k")!.atStopId).toBeNull();
    // Minutes later, a 9-stop relocation under a frozen fix: corroboration
    // is still required, because the flag has NOT changed since the departure.
    const r = gateAnchor(s, "k", 16, { ...at(80), at_stop_id: null, last_stop_id: 39 }, 60_000, N);
    expect(r.index).toBe(7);
    expect(r.released).toBeNull();
  });

  it("does not confuse an arrival with a departure", () => {
    // Flag SET while the scan reads one back (the shared-endpoint lag report
    // #27 fixed): the arrival releases as before.
    const s = store();
    gateAnchor(s, "k", 7, { ...at(0), at_stop_id: null, last_stop_id: 1 }, 1000, N);
    const r = gateAnchor(s, "k", 6, { ...at(5), at_stop_id: 44, last_stop_id: 1 }, 6000, N);
    expect(r).toEqual({ index: 6, released: "at-stop" });
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

describe("noteFix: the last two DISTINCT fixes", () => {
  it("has no direction to offer on first sight", () => {
    const s = store();
    expect(noteFix(s, "k", at(0), 1000)).toBeNull();
  });

  it("hands back the previous fix once the bus has moved", () => {
    const s = store();
    noteFix(s, "k", at(0), 1000);
    expect(noteFix(s, "k", at(40), 6000)).toEqual({ lat: at(0).lat, lon: at(0).lon });
  });

  it("is idempotent within a poll — the map, the cards and the trip card share one store", () => {
    const s = store();
    noteFix(s, "k", at(0), 1000);
    noteFix(s, "k", at(40), 6000);
    // Three more calls at the same coordinate must not walk the memory forward.
    for (let i = 0; i < 3; i++) {
      expect(noteFix(s, "k", at(40), 6000)).toEqual({ lat: at(0).lat, lon: at(0).lon });
    }
  });

  it("keeps the last real step while the fix repeats", () => {
    // 53.6% of consecutive samples are byte-identical. A standing bus must
    // keep the heading that brought it in, not lose it to its own stillness.
    const s = store();
    noteFix(s, "k", at(0), 1000);
    noteFix(s, "k", at(40), 6000);
    for (let t = 11_000; t < 60_000; t += 5000) {
      expect(noteFix(s, "k", at(40), t)).toEqual({ lat: at(0).lat, lon: at(0).lon });
    }
  });

  it("forgets a bus that has been away — where it used to be says nothing", () => {
    const s = store();
    noteFix(s, "k", at(0), 1000);
    noteFix(s, "k", at(40), 6000);
    expect(noteFix(s, "k", at(80), 6000 + ANCHOR_STALE_MS + 1)).toBeNull();
  });

  it("says nothing about a bus with no GPS", () => {
    const s = store();
    expect(noteFix(s, "k", { lat: undefined, lon: undefined }, 1000)).toBeNull();
    expect(s.size).toBe(0);
  });

  it("leaves the gate to accept a bus it has only opened the memory for", () => {
    const s = store();
    noteFix(s, "k", at(0), 1000);
    expect(gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N))
      .toEqual({ index: 7, released: "first" });
  });

  it("survives every write the gate makes", () => {
    // The gate rewrites its entry on accept, on agreement and on a hold; the
    // fix memory rides on the same entry and must not be reset by any of them,
    // or the bus loses its heading every time the anchor moves.
    const s = store();
    noteFix(s, "k", at(0), 1000);
    gateAnchor(s, "k", 7, { ...at(0), last_stop_id: 1 }, 1000, N);        // accept
    expect(noteFix(s, "k", at(40), 6000)).toEqual({ lat: at(0).lat, lon: at(0).lon });
    gateAnchor(s, "k", 7, { ...at(40), last_stop_id: 1 }, 6000, N);       // agrees
    expect(noteFix(s, "k", at(80), 11_000)).toEqual({ lat: at(40).lat, lon: at(40).lon });
    gateAnchor(s, "k", 20, { ...at(80), last_stop_id: 1 }, 11_000, N);    // held
    // Same poll, second caller: the heading is still there after the hold.
    expect(noteFix(s, "k", at(80), 11_000)).toEqual({ lat: at(40).lat, lon: at(40).lon });
  });
});

describe("the timeout never releases a backwards jump", () => {
  // The route is a ring served in order, so position only advances. A raw
  // anchor proposing more than half the loop forward is proposing a backwards
  // move, and waiting does not make it true. Operator's case, 2026-09-04:
  // Red #316 stood eleven minutes at 344 Winchester while the stateless scan
  // wanted the chord INTO the stop; after five minutes the timeout accepted it
  // and the board went 3 min -> 11 min.
  const N = 31;
  const AT = { lat: 41.324661, lon: -72.928677 }; // 344 Winchester

  function parked(atStopId: number | null) {
    return { lat: AT.lat, lon: AT.lon, at_stop_id: atStopId, last_stop_id: 75 };
  }

  it("holds a one-stop retreat however long the bus stands there", () => {
    const store: AnchorStore = new Map();
    const t0 = 1_700_000_000_000;
    // Anchor accepted at index 10 (344 Winchester).
    expect(gateAnchor(store, "k", 10, parked(11), t0, N).index).toBe(10);
    // The scan now wants index 9 — the chord INTO the stop — and keeps wanting
    // it. Twenty minutes of a motionless bus must not talk the gate into it.
    for (let m = 1; m <= 20; m++) {
      const r = gateAnchor(store, "k", 9, parked(11), t0 + m * 60_000, N);
      expect(r.index, `minute ${m}`).toBe(10);
      expect(r.released, `minute ${m}`).not.toBe("timeout");
    }
  });

  it("still times out a disputed FORWARD move, which is what the valve is for", () => {
    const store: AnchorStore = new Map();
    const t0 = 1_700_000_000_000;
    expect(gateAnchor(store, "k", 10, parked(11), t0, N).index).toBe(10);
    // Wants to advance several stops with no distance to justify it; held at
    // first, then released once the hold has run its course.
    // Poll steadily: a gap over ANCHOR_STALE_MS would reset the bus instead.
    let out = gateAnchor(store, "k", 14, parked(11), t0 + 60_000, N);
    expect(out.index).toBe(10);
    for (let t = 120_000; t <= ANCHOR_MAX_HOLD_MS + 60_000; t += 60_000) {
      out = gateAnchor(store, "k", 14, parked(11), t0 + t, N);
    }
    expect(out.index).toBe(14);
    expect(out.released).toBe("timeout");
  });
});
