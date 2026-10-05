/**
 * THE TIME-OF-DAY STAND TABLE (`qh`, src/calibrator/hourStand.ts), client side.
 *
 * Incident layoverhourstands20261005 (from cedarhold20261004): Blue Weekend
 * holds at 333 Cedar for a median 530-700 s at 07-09 h ET and 40-70 s in the
 * afternoon, and the countdown priced every hold from the 30-day pooled table
 * (median ~220 s), so it ran 3-8 min short through the morning holds. The
 * server now serves, at a gated layover cell only, the table for this time of
 * day beside `q`. The client prices the STAND from it; what the stop IS — its
 * class, its layover flag, the route's class pools, P(stop) — stays on `q`, so
 * a cell without `qh` and every other cell are priced exactly as before.
 */
import { describe, expect, it } from "vitest";

import { computeUpcomingArrivals, shownStandSec, type DwellStat, type DwellTimes, type SegmentTimes } from "../arrivals";
import { at, dwellTimes, makeBus, routeStops, segmentTimes, STOP, stopCoords } from "../__fixtures__/payload";
import { cdf, fromQuantiles, quantile, residualMedian, shrinkToward } from "./dist";
import { globalPoolsFor } from "./index";
import { classPools, poolsWithFallback, stopModel, LAYOVER_MIN_SEC, STAND_SHRINK_K } from "./tables";

// 333 Cedar on Blue Weekend: the pooled table as served live on 2026-10-04
// (23:56Z), and the hour tables the calibrator serves at 08:30 and 16:30 ET
// over the same 30 days (scripts/eta-replay/hour-stand-patch.ts, 10-04).
const Q = [30, 40, 55, 75, 111, 326, 393, 450, 566, 748];
const QH_MORNING = [192, 259, 317, 328, 364, 495, 602, 631, 703, 777];
const QH_AFTERNOON = [29, 33, 41, 52, 71, 149, 179, 208, 374, 711];

const CEDAR: DwellStat = { med: 420.1, sd: 366.6, n: 0, q: Q, qn: 102, pstop: 0.969 };
const KERB: DwellStat = { med: 30, sd: 20, n: 40, q: [0, 12, 15, 18, 22, 26, 31, 40, 55, 90], qn: 40 };
const route = (cedar: DwellStat): Record<string, DwellStat> => ({ "10": cedar, "13": KERB });
const pools = poolsWithFallback(classPools(route(CEDAR)), undefined);
const median = (d: ReturnType<typeof fromQuantiles>) => quantile(d, 0.5);

describe("stopModel reads the time-of-day table for the stand only", () => {
  it("prices the stand from `qh`, under the same prior and weight as `q`", () => {
    const m = stopModel({ ...CEDAR, qh: QH_MORNING, qhn: 16 }, pools);
    const expected = shrinkToward(fromQuantiles(QH_MORNING), pools.layover!, 102, STAND_SHRINK_K);
    expect(median(m.stand)).toBeCloseTo(median(expected), 9);
    // The incident: the morning hold the pooled table cannot say.
    expect(median(m.stand)).toBeGreaterThan(median(stopModel(CEDAR, pools).stand) + 150);
  });

  it("keeps the stop's class, layover flag and P(stop) on `q`", () => {
    // An afternoon table whose median is under the layover line: 333 Cedar is
    // still a layover, so the ring's layover rules do not flip by the hour.
    const afternoon = stopModel({ ...CEDAR, qh: QH_AFTERNOON, qhn: 18 }, pools);
    expect(median(fromQuantiles(QH_AFTERNOON))).toBeLessThan(LAYOVER_MIN_SEC);
    expect(afternoon.layover).toBe(true);
    expect(afternoon.layover).toBe(stopModel(CEDAR, pools).layover);
    expect(afternoon.pStop).toBe(0.969);
    // Without a served share, P(stop) is still the pooled table's.
    const noShare = { ...CEDAR, pstop: undefined };
    expect(stopModel({ ...noShare, qh: QH_AFTERNOON }, pools).pStop).toBe(stopModel(noShare, pools).pStop);
    expect(stopModel(noShare, pools).pStop).toBeCloseTo(1 - cdf(shrinkToward(fromQuantiles(Q), pools.layover!, 102, STAND_SHRINK_K), 0), 12);
  });

  it("prices a cell without `qh` exactly as before, and ignores a malformed one", () => {
    const before = stopModel(CEDAR, pools);
    expect(before.stand).toEqual(shrinkToward(fromQuantiles(Q), pools.layover!, 102, STAND_SHRINK_K));
    expect(stopModel({ ...CEDAR, qh: [500, 100] }, pools)).toEqual(before);
    expect(stopModel({ ...CEDAR, qh: undefined, qhn: undefined }, pools)).toEqual(before);
  });

  it("never lets `qh` into the route's or the network's class pools", () => {
    const withQh = route({ ...CEDAR, qh: QH_AFTERNOON, qhn: 18 });
    expect(classPools(withQh)).toEqual(classPools(route(CEDAR)));
  });
});

describe("the hold the chip shows is the hold the countdown bills", () => {
  it("reads `qh` through the same model", () => {
    const stat = { ...CEDAR, qh: QH_MORNING, qhn: 16 };
    const shown = shownStandSec(stat, 0, route(stat))!;
    expect(shown.typicalSec!).toBeCloseTo(residualMedian(stopModel(stat, pools).stand, 0), 9);
    expect(shown.typicalSec!).toBeGreaterThan(shownStandSec(CEDAR, 0, route(CEDAR))!.typicalSec! + 150);
  });
});

describe("a bus standing at 333 Cedar in the morning", () => {
  const NOW = Date.parse("2026-10-04T12:30:00Z"); // 08:30 ET
  // Twenty seconds into the hold: the moment the incident's riders were quoted
  // (~6 min for an 11-min hold). Later in the hold the price conditions on the
  // time already stood, which drops the pooled table's short stands as well.
  const since = new Date(NOW - 20_000).toISOString().replace(/Z$/, "");
  const bus = makeBus({
    ...at(STOP.cedar333), route_id: 1, bus_name: "#44", last_stop_id: STOP.cedar333,
    stationary: true, at_stop_id: STOP.cedar333, at_stop_since: since, stationary_since: since,
  });
  const withCedar = (cedar: DwellStat): DwellTimes => ({ ...dwellTimes, "1": { ...dwellTimes["1"], "10": cedar } });
  // The fixture's hops are v1 arrival-to-arrival rows, which already hold the
  // stand at A, so no stand would be priced at all; the all-routes pooled pace
  // (the `__pace` carrier the server sends) makes every hop a drive and every
  // stop a stand, as on the live payload.
  const POOLED_SPM = [0.0769, 0.0971, 0.1117, 0.1259, 0.1363, 0.1535, 0.1713, 0.1979, 0.2459, 0.3357];
  const SEGS: SegmentTimes = { ...segmentTimes, "1": { ...segmentTimes["1"], __pace: { avg: 0, sd: 0, n: 0, spm: POOLED_SPM, spmN: 9077, spmPooled: true } } };
  const etaTo = (dw: DwellTimes, stop: number) =>
    computeUpcomingArrivals([stop], [bus], routeStops, stopCoords, SEGS, NOW, dw).find((a) => a.stopId === stop)!.eta;

  it("is counted down with the morning's hold — and the cached tables notice when only `qh` changed", () => {
    // The SAME segment table object for every call: the estimator caches its
    // tables per (segments object, dwell content), so a fingerprint that
    // missed `qh` would hand the second call the first call's tables.
    const pooled = etaTo(withCedar(CEDAR), STOP.york129);
    const morning = etaTo(withCedar({ ...CEDAR, qh: QH_MORNING, qhn: 16 }), STOP.york129);
    const afternoon = etaTo(withCedar({ ...CEDAR, qh: QH_AFTERNOON, qhn: 18 }), STOP.york129);
    expect(morning).toBeGreaterThan(pooled + 120);
    expect(afternoon).toBeLessThan(pooled);
    // And back: the pooled payload after a `qh` one prices as it did first.
    expect(etaTo(withCedar(CEDAR), STOP.york129)).toBe(pooled);
  });

  it("changes nothing before the bus reaches 333 Cedar's stand", () => {
    // Phelps Gate is idx 19, LEPH / 60 College (72) idx 22, 333 Cedar idx 24:
    // the first-lap row to 72 carries no Cedar stand, the second-lap row does.
    const upstream = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: STOP.phelpsGate });
    const rows = (dw: DwellTimes) =>
      computeUpcomingArrivals([72], [upstream], routeStops, stopCoords, SEGS, NOW, dw).filter((a) => a.stopId === 72).map((a) => a.eta);
    const [firstPooled, nextPooled] = rows(withCedar(CEDAR));
    const [firstMorning, nextMorning] = rows(withCedar({ ...CEDAR, qh: QH_MORNING, qhn: 16 }));
    expect(firstMorning).toBe(firstPooled);
    expect(nextMorning!).toBeGreaterThan(nextPooled!);
  });

  it("fingerprints `qh` into the network pool key", () => {
    const a = globalPoolsFor({ "1": { "10": CEDAR } }).key;
    const b = globalPoolsFor({ "1": { "10": { ...CEDAR, qh: QH_MORNING, qhn: 16 } } }).key;
    expect(b).not.toBe(a);
  });
});
