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
  const expected = (seq.indexOf(board) - seq.indexOf(bus.at_stop_id) + seq.length) % seq.length;
  const actual = Number(quotes[0][2]);
  return expected === actual ? null : { bus: bus.bus_name, boardStop: board, standingStop: bus.at_stop_id,
    expected, actual, observedAt: bus.observed_at };
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
