import { haversineM } from '../canary-metrics.mjs';

const bare = name => String(name).replace(/^#/, '');
const normalized = name => String(name).replace(/\s/g, '').toLowerCase();
const coordinate = point => Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
  && Number.isFinite(point?.lon) && Math.abs(point.lon) <= 180;

/** Independent review of the sampled instruction, rather than the app's
 * anchor or ETA helper. This yields a candidate, not physical arrival truth. */
export function offPoleExitInstruction(text, feed, run, now, feedAgeMs) {
  if (run?.phase !== 'riding' || typeof run.id !== 'string' || !run.id
    || typeof run.busName !== 'string' || !bare(run.busName)
    || !Number.isInteger(run.exitStopId) || !Number.isInteger(run.boardStopId)
    || !Number.isFinite(now) || !Number.isFinite(feedAgeMs) || feedAgeMs < 0 || feedAgeMs > 30_000) return null;
  let stored;
  try { stored = JSON.parse(run.boardedStorage?.['shuttle-boarded-ride']); } catch { return null; }
  if (!stored || bare(stored.busName) !== bare(run.busName) || stored.routeLabel !== run.line?.label
    || stored.alightStopId !== run.exitStopId || stored.boardStopId !== run.boardStopId) return null;
  const exit = feed.stop_coords?.[run.exitStopId], exitName = feed.stop_names?.[run.exitStopId];
  if (!coordinate(exit) || typeof exitName !== 'string') return null;
  const here = /(?:^|\n)Get off here(?:\n|$)/.test(String(text));
  const arriving = [...String(text).matchAll(/(?:^|\n)Arriving at ([^\n]+)(?=\n|$)/g)]
    .some(m => normalized(m[1]) === normalized(exitName));
  if (!here && !arriving) return null;
  // Popup and banner can repeat the same caption. Distinct captions are
  // ambiguous, and a caption for another ride must not borrow this bus's GPS.
  const captions = [...String(text).matchAll(/(?:^|\n)(?:🚌\s*)?([^\n]+?)\s+#([\w-]+)\s*→\s*([^\n]+)(?=\n|$)/g)]
    .map(m => [normalized(m[1]), bare(m[2]), normalized(m[3])]);
  if (!captions.length || captions.some(c => c[0] !== normalized(run.line.label)
    || c[1] !== bare(run.busName) || c[2] !== normalized(exitName))) return null;
  const matches = (feed.buses ?? []).filter(b => bare(b.bus_name) === bare(run.busName)
    && run.line.busRouteIds?.includes(b.route_id));
  if (matches.length !== 1) return null;
  const bus = matches[0];
  if (!coordinate(bus) || !Number.isFinite(bus.observed_at)
    || now - bus.observed_at > 30_000 || bus.observed_at > now + 5000) return null;
  const distanceM = haversineM(bus, exit);
  if (distanceM <= 75) return null;
  return { runId: run.id, bus: bus.bus_name, routeId: bus.route_id,
    exitStopId: run.exitStopId, exitName, distanceM, observedAt: bus.observed_at,
    position: { lat: bus.lat, lon: bus.lon }, exitCoords: { ...exit },
    instruction: here ? 'Get off here' : `Arriving at ${exitName}` };
}

/** Two fresh observations at least five seconds apart suppress one-frame
 * render/feed races. Moving GPS may change the distance without changing the
 * conflicting ride. An interruption or recovery requires fresh confirmation. */
export function confirmExitInstruction(previous, conflict, now) {
  if (!conflict) return { state: null, alert: null };
  const key = JSON.stringify([conflict.runId, bare(conflict.bus), conflict.routeId, conflict.exitStopId]);
  const same = previous?.key === key && now >= previous.lastAt && now - previous.lastAt <= 30_000
    && conflict.observedAt >= previous.lastObservation;
  const state = same
    ? { ...previous, lastAt: now, lastObservation: conflict.observedAt }
    : { key, firstAt: now, lastAt: now, firstObservation: conflict.observedAt,
      lastObservation: conflict.observedAt, firstWitness: conflict, reported: false };
  const confirmed = !state.reported && now - state.firstAt >= 5000
    && conflict.observedAt - state.firstObservation >= 5000;
  if (confirmed) state.reported = true;
  return { state, alert: confirmed ? { ...conflict, firstWitness: state.firstWitness,
    firstSeenAt: state.firstAt, confirmedAt: now,
    scope: 'Sustained sampled UI/GPS contradiction; review required. No independent physical arrival or ETA accuracy verdict.' } : null };
}
