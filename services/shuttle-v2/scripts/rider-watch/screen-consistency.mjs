import { labeledStopId, observedAtStop } from './inputs.mjs';

// Independent of the app's anchor/counting helpers. A confirmed curb stand
// on a route with one call per stop gives an unambiguous forward count.
export function pickupCountConflict(text, feed, routeIds, now) {
  const quotes = [...String(text).matchAll(/🚌\s*(#[\w-]+)\s*·\s*(\d+) stops? away/g)];
  if (quotes.length !== 1) return null;
  const board = labeledStopId(text, 'BOARD', feed.stop_names ?? {});
  if (board === null) return null;
  const bare = name => String(name).replace(/^#/, '');
  const matches = (feed.buses ?? []).filter(b => routeIds.includes(b.route_id)
    && bare(b.bus_name) === bare(quotes[0][1]));
  if (matches.length !== 1) return null;
  const bus = matches[0], seq = feed.routes?.[bus.route_id];
  const wire = feed.server_eta;
  const stands = wire?.v === 2 && Number.isFinite(wire.at) && Number.isFinite(wire.servedAt)
    && wire.servedAt >= wire.at && wire.servedAt - wire.at < 30_000
    ? (wire.buses ?? []).filter(b => bare(b[0]) === bare(bus.bus_name)) : [];
  // Raw at_stop_id is a zone flag and can already name the next stop while
  // the bus approaches it. Require the model to confirm this curb too.
  const standing = stands.length === 1 ? stands[0][3] : null;
  if (!Array.isArray(seq) || new Set(seq).size !== seq.length || !seq.includes(board)
    || !seq.includes(bus.at_stop_id) || !Number.isFinite(bus.observed_at)
    || now - bus.observed_at >= 30_000 || bus.observed_at > now + 5000
    || !standing || standing.approach || standing.stopId !== bus.at_stop_id
    || !observedAtStop(bus, bus.at_stop_id, feed.stop_coords)) return null;
  const i = wire.buses.indexOf(stands[0]), travel = wire.travel?.[i];
  // A unique published list can still have repaired extra passes. The served
  // travel slot identifies one; its physical marker belongs elsewhere in the
  // published list and must not wrap this independent pickup check either.
  const addedPass = Number.isInteger(travel) && travel >= 0 && travel < seq.length
    && travel !== stands[0][2];
  const origin = addedPass ? travel : seq.indexOf(bus.at_stop_id);
  const expected = (seq.indexOf(board) - origin + seq.length) % seq.length;
  const actual = Number(quotes[0][2]);
  return expected === actual ? null : { bus: bus.bus_name, boardStop: board, standingStop: bus.at_stop_id,
    expected, actual, observedAt: bus.observed_at };
}

// A served travel slot can describe a pass absent from a unique published
// list. Check the on-bus count against that explicit slot, independently of
// the app's anchor helpers. This is screen/source consistency, not physical
// arrival, service or ETA accuracy evidence.
export function rideCountConflict(text, feed, run, now) {
  const bare = name => String(name).replace(/^#/, '');
  const norm = value => String(value).replace(/\s/g, '').toLowerCase();
  if (run?.phase !== 'riding' || typeof run.id !== 'string' || !run.id
    || run.line?.busRouteIds?.length !== 1 || typeof run.busName !== 'string') return null;
  let stored;
  try { stored = JSON.parse(run.boardedStorage?.['shuttle-boarded-ride']); } catch { return null; }
  if (!stored || bare(stored.busName) !== bare(run.busName) || stored.routeLabel !== run.line.label
    || stored.boardStopId !== run.boardStopId || stored.alightStopId !== run.exitStopId) return null;
  const buses = (feed.buses ?? []).filter(b => bare(b.bus_name) === bare(run.busName)
    && b.route_id === run.line.busRouteIds[0]);
  if (buses.length !== 1) return null;
  const bus = buses[0], seq = feed.routes?.[bus.route_id], wire = feed.server_eta;
  if (!Array.isArray(seq) || !seq.length || new Set(seq).size !== seq.length
    || !seq.includes(run.exitStopId) || !Number.isFinite(bus.observed_at)
    || !Number.isFinite(now) || now - bus.observed_at >= 30_000 || bus.observed_at > now + 5000
    || wire?.v !== 2 || !Number.isFinite(wire.at) || !Number.isFinite(wire.servedAt)
    || wire.servedAt < wire.at || wire.servedAt - wire.at >= 30_000
    || !Array.isArray(wire.buses) || !Array.isArray(wire.travel) || wire.travel.length !== wire.buses.length) return null;
  const indices = wire.buses.flatMap((b, i) => Array.isArray(b) && bare(b[0]) === bare(run.busName)
    && b[1] === run.line.label ? [i] : []);
  if (indices.length !== 1) return null;
  const i = indices[0], index = wire.buses[i][2], travel = wire.travel[i];
  if (![index, travel].every(n => Number.isInteger(n) && n >= 0 && n < seq.length) || index === travel) return null;
  const exitName = feed.stop_names?.[run.exitStopId];
  if (typeof exitName !== 'string') return null;
  const captions = [...String(text).matchAll(/(?:^|\n)(?:🚌\s*)?([^\n]+?)\s+#([\w-]+)\s*→\s*([^\n]+)(?=\n|$)/g)];
  if (!captions.length || captions.some(m => norm(m[1]) !== norm(run.line.label)
    || bare(m[2]) !== bare(run.busName) || norm(m[3]) !== norm(exitName))) return null;
  const counts = new Set();
  for (const match of String(text).matchAll(/(?:^|\n)(?:Your stop is )?(\d+) stops(?: away|\s*·[^\n]*)?(?=\n|$)/g)) counts.add(Number(match[1]));
  if (/(?:^|\n)Get off (?:at the next stop|NEXT stop!)(?:[^\n]*)(?=\n|$)/.test(String(text))) counts.add(1);
  if (/(?:^|\n)Get off in 2 stops!/.test(String(text))) counts.add(2);
  if (/(?:^|\n)Get off here(?:\n|$)/.test(String(text))) counts.add(0);
  if (counts.size !== 1) return null;
  const actual = [...counts][0], expected = (seq.indexOf(run.exitStopId) - travel + seq.length) % seq.length;
  return actual === expected ? null : {runId: run.id, bus: bus.bus_name, routeId: bus.route_id,
    exitStopId: run.exitStopId, travelIndex: travel, expected, actual, observedAt: bus.observed_at};
}

// Distinct observations must agree; cached polls, feed/UI races and a
// one-poll glitch are not sustained contradictions. State belongs to a run.
export function confirmConflict(previous, conflict, now) {
  if (!conflict) return { state: null, alert: null };
  const { observedAt, ...identity } = conflict;
  const key = JSON.stringify(identity);
  const same = previous?.key === key && now - previous.lastAt <= 30_000;
  const state = same ? { ...previous, lastAt: now } : { key, firstAt: now, lastAt: now, firstObservation: observedAt, reported: false };
  const confirmed = !state.reported && now - state.firstAt >= 5000 && observedAt - state.firstObservation >= 5000;
  if (confirmed) state.reported = true;
  return { state, alert: confirmed ? conflict : null };
}
