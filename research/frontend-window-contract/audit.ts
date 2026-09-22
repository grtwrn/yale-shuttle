import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { UpcomingArrival } from '../../services/shuttle-v2/web/src/arrivals';
import type { BusData } from '../../services/shuttle-v2/web/src/map-data';
import { rideBoardArrivals, boardingVisitAllowed, pickLiveArrival, topVisibleOptions, type TripOption } from '../../services/shuttle-v2/web/src/planner';
import { forecastPickupSelection } from '../../services/shuttle-v2/web/src/livePickupSelection';
import { atStopJourneyBoard, journeyArrival } from '../../services/shuttle-v2/web/src/journeyArrival';
import { preferredTripOrder, stableTripOrder } from '../../services/shuttle-v2/web/src/tripRanking';
import { computeLeaveAlert, findReminderOption, liveReminderInput, NO_PINGS_FIRED, secUntilLeave } from '../../services/shuttle-v2/web/src/leaveAlert';
import { attachServerEta, ETA_MAX_AGE_MS } from '../../services/shuttle-v2/web/src/etaSource';

const at = Date.UTC(2026, 8, 22, 5);
const result: Record<string, unknown> = { production: '05a988194af3c376e5aa5da16682c29f797db2b2', plan: 'a275232', scope: 'Synthetic contract sensitivity; no historical frequencies or rider outcome estimates.' };
const row = (busName: string, stopId: number, stopsAhead: number, eta: number, low = Math.max(0, eta - 180), high = eta + 600, routeLabel = 'Red'): UpcomingArrival =>
  ({ busName, stopId, stopsAhead, eta, low, high, departNow: eta, lowFloor: 0, routeLabel, color: '#000', estimated: false });
const protect = (r: UpcomingArrival, candidateLow: number, candidateHigh: number) =>
  ({ ...r, low: Math.min(r.low, candidateLow, r.eta), high: Math.max(r.eta, candidateHigh) });
const identity = (r: UpcomingArrival | undefined) => r && [r.routeLabel, r.busName, r.stopId, r.stopsAhead, r.eta];
function selected(rows: UpcomingArrival[], pin: string, walk: number) {
  const live = rideBoardArrivals(rows, 48, 121);
  const p = pickLiveArrival(live, pin, walk);
  const evidence = forecastPickupSelection(p, at);
  return { live: live.map(identity), match: identity(p?.match), board: identity(p?.boardable),
    departed: p?.departed, missedBus: p?.missedBus, relation: evidence?.relation,
    rawA: identity(atStopJourneyBoard(rows, 'Red', 'A', 48, 121)),
    allowedA: boardingVisitAllowed('A', 48, 121, rows) };
}

let selectionCases = 0;
const points = [0, 59, 60, 89, 90, 150, 299, 300, 301, 600, 1200];
for (const a of points) for (const b of points) for (const walk of [0, 59, 60, 180, 300, 600])
  for (const pin of ['', 'A', '#A', 'B']) for (const repeatBeforeDestination of [false, true]) {
    const rows = [row('A', 48, 1, a), row('A', 121, repeatBeforeDestination ? 24 : 4, a + 900),
      row('A', 48, 20, a + 600), row('B', 48, 2, b), row('B', 121, 5, b + 900)]
      .sort((x, y) => x.eta - y.eta);
    const baseline = selected(rows, pin, walk);
    for (const transformed of [rows.map(r => ({ ...r })), rows.map(r => protect(r, r.low, 0)), rows.map(r => protect(r, 0, r.eta + 60))]) {
      assert.deepEqual(selected(transformed, pin, walk), baseline);
      selectionCases++;
    }
  }
result.selectionCases = selectionCases;

let reminderCases = 0, earlierThresholds = 0;
for (const eta of [0, 1, 59, 60, 61, 119, 120, 121, 300, 600, 1200])
  for (const low of [0, eta / 2, eta]) for (const high of [eta, eta + 60, eta + 600])
    for (const candidateLow of [0, low]) for (const candidateHigh of [0, eta + 60])
      for (const walk of [59, 60, 180, 300, 600]) for (const age of [0, 5, 15, 30, 44, 45]) {
        const r = row('A', 48, 1, eta, low, high), h = protect(r, candidateLow, candidateHigh);
        const before = { busEtaSec: eta, busLowSec: low, busHighSec: high, computedAtMs: at, nowMs: at + age * 1000, walkToSec: walk };
        const after = { ...before, busLowSec: h.low, busHighSec: h.high };
        const l0 = secUntilLeave(before), l1 = secUntilLeave(after);
        assert.ok(l1 <= l0, JSON.stringify({ before, after, l0, l1 }));
        if (computeLeaveAlert(before, NO_PINGS_FIRED) === 'leave_now') assert.equal(computeLeaveAlert(after, NO_PINGS_FIRED), 'leave_now');
        if (walk < 60) assert.equal(computeLeaveAlert(after, NO_PINGS_FIRED), null);
        earlierThresholds += Number(l1 < l0); reminderCases++;
      }
result.reminderGrid = { cases: reminderCases, earlierThresholds, laterThresholds: 0, caveat: 'Ages here exercise pure formatting; live adapter separately rejects feeds at 45 seconds.' };

const buses: BusData[] = [307, 309].map(id => ({ bus_id: id, bus_name: `#${id}`, route_id: 3, lat: 41.3, lon: -72.9, heading: 0, last_stop_id: 48 }));
assert.equal(attachServerEta(buses, { v: 2, at, servedAt: at, buses: [['307', 'Red', 0, null], ['309', 'Red', 0, null]],
  rows: [[0, 48, 20, 0, 100, 2, 0, 20, 0], [1, 48, 300, 280, 380, 4, 0, 300, 0]] }, at), true);
let adapterCases = 0;
for (const boarding of [row('309', 48, 4, 300, 280, 380), row('307', 48, 30, 1200, 1100, 1400)]) {
  const countdown = row('307', 48, 2, 20, 0, 100);
  const option = (b: UpcomingArrival) => ({ mode: 'shuttle', routeLabel: 'Red', busEtaSec: 20, boardStopId: 48, alightStopId: 121,
    walkToSec: 100, computedAtMs: at, livePickupSelection: forecastPickupSelection({ match: countdown, boardable: b, departed: false }, at) });
  const other = { ...option(boarding), routeLabel: 'Other' };
  const base = option(boarding), h = option(protect(boarding, 120, boarding.eta));
  for (const age of [0, 5, 15, 30, 44, 45]) {
    const ctx = { buses, busUpdateFailed: false, nowMs: at + age * 1000, boardStopId: 48, alightStopId: 121 };
    const b = liveReminderInput([base, other], 'Red', ctx), c = liveReminderInput([other, h], 'Red', ctx);
    assert.equal(findReminderOption([other, h], 'Red'), h);
    assert.deepEqual(liveReminderInput([h, other], 'Red', ctx), c);
    if (age * 1000 >= ETA_MAX_AGE_MS) { assert.equal(b, null); assert.equal(c, null); }
    else { assert.ok(b && c); assert.equal(c.busName, b.busName); assert.equal(c.busEtaSec, b.busEtaSec); assert.equal(c.laterVisit, b.laterVisit); assert.ok(secUntilLeave(c) <= secUntilLeave(b)); }
    adapterCases++;
  }
}
result.liveAdapterCases = adapterCases;

function option(label: string, ride: number, point: number, low: number, high: number, pickupLow = 180, pickupPoint = 300, includeDestination = true): TripOption {
  const board = row('1', 48, 1, pickupPoint, pickupLow, pickupPoint + 600, label);
  const destination = row('1', 121, 4, point, low, high, label);
  const journey = journeyArrival(board, includeDestination ? [board, destination] : [board], 121, 120, 60, at);
  return { mode: 'shuttle', routeLabel: label, color: '#000', boardStopId: 48, alightStopId: 121,
    walkToSec: 120, walkFromSec: 60, waitSec: Math.max(0, pickupPoint - 120), rideSec: ride, plannedRideSec: ride,
    totalSec: journey ? (journey.pointMs - at) / 1000 : pickupPoint + ride + 60, busName: '1', directWalkSec: 3600,
    computedAtMs: at, busEtaSec: pickupPoint, busLowSec: pickupLow, busHighSec: pickupPoint + 600, journeyArrival: journey };
}
const labels = (os: readonly TripOption[]) => os.map(o => o.routeLabel);
const counters: Record<string, unknown> = {};
const A = option('A', 300, 1800, 1500, 2100);
const B = option('B', 600, 1200, 900, 2000);
const Bh = option('B', 600, 1200, 900, 1200);
assert.equal(B.totalSec, Bh.totalSec);
assert.deepEqual(labels(preferredTripOrder([A, B])), ['A', 'B']);
assert.deepEqual(labels(preferredTripOrder([A, Bh])), ['B', 'A']);
counters.upperTightening = { before: labels(preferredTripOrder([A, B])), after: labels(preferredTripOrder([A, Bh])), fixedPointSeconds: [A.totalSec, B.totalSec] };

const Alow = option('A', 300, 1800, 600, 2100);
assert.equal(A.totalSec, Alow.totalSec);
assert.deepEqual(labels(preferredTripOrder([Alow, Bh])), ['A', 'B']);
counters.earlierDestinationLow = { before: ['B', 'A'], after: labels(preferredTripOrder([Alow, Bh])) };
const unknown = option('A', 300, 2400, 2000, 2800, 1500, 1800, false);
const unknownEarlier = option('A', 300, 2400, 2000, 2800, 200, 1800, false);
assert.equal(unknown.journeyArrival, undefined);
assert.deepEqual(labels(preferredTripOrder([unknown, Bh])), ['B', 'A']);
assert.deepEqual(labels(preferredTripOrder([unknownEarlier, Bh])), ['A', 'B']);
counters.missingDestination = { before: ['B', 'A'], after: ['A', 'B'], fixedPickupPoint: 1800 };

const board = row('1', 48, 1, 600, 300, 900), destination = row('1', 121, 4, 1200, 900, 1500);
const j0 = journeyArrival(board, [board, destination], 121, 240, 60, at)!;
const j1 = journeyArrival(protect(board, 120, 600), [board, destination], 121, 240, 60, at)!;
assert.equal(j0.catchRisk, false); assert.equal(j1.catchRisk, true); assert.equal(j0.pointMs, j1.pointMs);
counters.catchRisk = { before: j0.catchRisk, after: j1.catchRisk, samePoint: true };
for (const [high, expected] of [[1410, 'A'], [1409, 'B']] as const)
  assert.equal(preferredTripOrder([A, option('B', 600, 1200, 900, high)])[0]!.routeLabel, expected);

const start = stableTripOrder([A, B], null, at);
const pending = stableTripOrder([A, Bh], start.state, at + 5000);
assert.deepEqual(labels(pending.options), ['A', 'B']);
assert.deepEqual(labels(stableTripOrder([A, Bh], pending.state, at + 34_999).options), ['A', 'B']);
assert.deepEqual(labels(stableTripOrder([A, Bh], pending.state, at + 35_000).options), ['B', 'A']);
const recovered = stableTripOrder([A, B], pending.state, at + 10_000);
assert.equal(recovered.state.pending, undefined);
assert.deepEqual(labels(stableTripOrder([A, Bh], null, at).options), ['B', 'A']);
assert.deepEqual(labels(preferredTripOrder([Bh, A])), ['B', 'A']);
counters.stability = { initialPlan: ['B', 'A'], changedLivePlanHoldMs: 30_000, blipDiscarded: true, separationStrictlyGreaterThanSeconds: 90 };

// A fourth option becomes clearly earlier. Keep each synthetic destination
// point consistent with pickup+planned ride; only upper bound changes.
const va = option('A', 300, 3000, 2700, 3400);
const vb = option('B', 600, 2700, 2400, 3400);
const vc = option('C', 720, 2500, 2100, 3400);
const vd = option('D', 1200, 1500, 1200, 3400);
const vdh = option('D', 1200, 1500, 1200, 1500);
const v0 = topVisibleOptions(preferredTripOrder([va, vb, vc, vd]));
const v1 = topVisibleOptions(preferredTripOrder([va, vb, vc, vdh]));
assert.deepEqual(labels(v0), ['A', 'B', 'C']);
assert.deepEqual(labels(v1), ['D', 'A', 'B']);
counters.collapsedVisibility = { before: labels(v0), after: labels(v1), allRoutePointsUnchanged: true };
result.counterexamples = counters;

const files = ['planner.ts', 'livePickupSelection.ts', 'journeyArrival.ts', 'tripRanking.ts', 'leaveAlert.ts', 'etaSource.ts', 'arrivalDetails.ts', 'TransitMap.tsx'];
result.productionFileHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(`services/shuttle-v2/web/src/${file}`)).digest('hex')]));
result.status = 'passed';
mkdirSync('research/frontend-window-contract/results', { recursive: true });
writeFileSync('research/frontend-window-contract/results/summary.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
