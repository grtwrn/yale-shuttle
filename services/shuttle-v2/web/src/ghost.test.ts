import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fmtSignalLost, fmtWasDue } from "./format";
import {
  GHOST_GRACE_MS, PROMISE_SLACK_SEC, ghostGraceMs, ghostStillShown,
  promiseKey, recallPromise, rememberPromise,
} from "./ghost";
import { STOP_DWELL_SEC } from "./planner";

/**
 * Read the SERVER's ghost bound straight out of its source, the way
 * `walk.test.ts` reads the walk model. The server's constant is the one that
 * decides whether the payload still carries the bus at all; this module's only
 * decides whether the row is still drawn. If the server's were the shorter of
 * the two the row would go blank before the client thought it should, and
 * nothing else in the suite would notice.
 */
function serverGhostTtlMs(): number {
  const path = fileURLToPath(new URL("../../src/collector/collector.ts", import.meta.url));
  const src = readFileSync(path, "utf8");
  const m = /const GHOST_BUS_TTL_MS = ([0-9_ *]+);/.exec(src);
  if (!m) throw new Error("could not find GHOST_BUS_TTL_MS in the collector's source");
  // eslint-disable-next-line no-eval
  return eval(m[1]!.replace(/_/g, "")) as number;
}

describe("how long a bus that has gone quiet is remembered", () => {
  it("mirrors the collector's own bound", () => {
    expect(GHOST_GRACE_MS).toBe(serverGhostTtlMs());
  });

  // Ten minutes is the knee of a measured curve, not a round number. Over 90
  // days of `arrivals` (3,136 vanish events), a bus that goes quiet while its
  // route is still running is back within 5 min 13.4% of the time, 10 min
  // 32.8%, 15 min 41.2%, 20 min 44.5% — and never within the hour 50.3% of the
  // time. Returns arrive at ~3.8 percentage points a minute out to ten and
  // then 1.7, 0.65, 0.22. Past ten minutes a longer memory buys a stale row
  // rather than a reunion.
  it("is ten minutes", () => {
    expect(GHOST_GRACE_MS).toBe(10 * 60_000);
  });

  // The grace is the EARLIER of the cap and the promise running out, so a bus
  // that was nearly here is forgotten quickly and one that was half an hour
  // out does not linger for half an hour.
  it("ends when the promise it remembers is spent", () => {
    // Due in 3 min: held 3 min plus a dwell's grace, not the full ten.
    expect(ghostGraceMs(180)).toBe((180 + PROMISE_SLACK_SEC) * 1000);
    // Due in 40 min: capped.
    expect(ghostGraceMs(40 * 60)).toBe(GHOST_GRACE_MS);
  });

  // The slack is `STOP_DWELL_SEC` by construction and for its reason: for
  // about a minute past its due time a bus that arrived unseen would still be
  // standing there to be boarded.
  it("allows exactly one dwell of slack past the due time", () => {
    expect(PROMISE_SLACK_SEC).toBe(STOP_DWELL_SEC);
  });

  it("shows the row inside the grace and not outside it", () => {
    const lost = 1_000_000;
    expect(ghostStillShown(lost, 15 * 60, lost + 60_000)).toBe(true);
    expect(ghostStillShown(lost, 15 * 60, lost + 9 * 60_000)).toBe(true);
    expect(ghostStillShown(lost, 15 * 60, lost + 10 * 60_000)).toBe(false);
    // A short promise expires on its own terms, well inside the cap.
    expect(ghostStillShown(lost, 120, lost + 3 * 60_000 + 1)).toBe(false);
  });
});

describe("the promise memory", () => {
  const p = (etaSec: number) => ({ etaSec, stopsAhead: 3, estimated: false });
  /** Inside the grace of every promise filed below, so age never decides these. */
  const NOW_T = 20_000;

  it("has no memory at all without a store", () => {
    // Every hypothetical, replay and pure test passes no store, and must price
    // byte-identically to a tree without this file in it.
    rememberPromise(undefined, "k", p(600), 0);
    expect(recallPromise(undefined, "k", 0)).toBeNull();
  });

  it("hands back the last thing the rider was told", () => {
    const store = {};
    rememberPromise(store, "k", p(900), 1_000);
    expect(recallPromise(store, "k", NOW_T)).toEqual({
      etaSec: 900, stopsAhead: 3, estimated: false, atMs: 1_000,
    });
    rememberPromise(store, "k", p(840), 6_000);
    expect(recallPromise(store, "k", NOW_T)!.etaSec).toBe(840);
  });

  // `computeUpcomingArrivals` walks the loop twice, so one poll can offer the
  // same vehicle for the same stop twice — this lap and the next. The promise
  // a rider was watching is the first one.
  it("keeps the soonest of two entries made in one poll", () => {
    const store = {};
    rememberPromise(store, "k", p(480), 5_000);
    rememberPromise(store, "k", p(2_400), 5_000); // the lap
    expect(recallPromise(store, "k", NOW_T)!.etaSec).toBe(480);
  });

  // A later poll is news, even when the number went up.
  it("does not treat a later poll as the same poll", () => {
    const store = {};
    rememberPromise(store, "k", p(480), 5_000);
    rememberPromise(store, "k", p(600), 10_000);
    expect(recallPromise(store, "k", NOW_T)!.etaSec).toBe(600);
  });

  it("files one promise per vehicle per stop", () => {
    expect(promiseKey("Red|#304", 48)).not.toBe(promiseKey("Red|#304", 11));
    expect(promiseKey("Red|#304", 48)).not.toBe(promiseKey("Red|#310", 48));
  });

  // Red #304 came back eighteen minutes after it went quiet. If it had gone
  // quiet AGAIN before its board stop was re-priced, the promise from before
  // the gap would still be here and the fresh `offline_since` would have made
  // it look newly minted. A promise is only as good as the last time we said it.
  it("refuses a promise older than the grace", () => {
    const store = {};
    rememberPromise(store, "k", p(900), 1_000);
    expect(recallPromise(store, "k", 1_000 + GHOST_GRACE_MS - 1)).toBeTruthy();
    expect(recallPromise(store, "k", 1_000 + GHOST_GRACE_MS)).toBeNull();
    expect(recallPromise(store, "k", 1_000 + 18 * 60_000)).toBeNull();
  });

  it("keeps each caller's memory to itself", () => {
    const a = {}, b = {};
    rememberPromise(a, "k", p(300), 0);
    expect(recallPromise(b, "k", NOW_T)).toBeNull();
  });
});

describe("the words on a ghost row", () => {
  // PAST TENSE. "in 15 min" is a claim about the future and there is no
  // evidence for one; "was due in 15 min" is a statement about what this app
  // told this rider, which stays true whatever the bus turns out to be doing.
  it("says what the app promised, not what will happen", () => {
    expect(fmtWasDue(900)).toBe("was due in 15 min");
    expect(fmtWasDue(65)).toBe("was due in 1 min");
    expect(fmtWasDue(5)).toBe("was due now");
  });

  // Minutes are spelled `min`, never `m` — and an elapsed time has nothing
  // imminent about it, so it does not borrow `fmtMin`'s "<1 min" spelling.
  it("says how long ago the signal went", () => {
    expect(fmtSignalLost(0)).toBe("signal lost just now");
    expect(fmtSignalLost(59)).toBe("signal lost just now");
    expect(fmtSignalLost(180)).toBe("signal lost 3 min ago");
    expect(fmtSignalLost(3_600)).toBe("signal lost 60 min ago");
  });
});
