import { CANARY_LINES } from '../canary-metrics.mjs';

const bare = name => String(name).replace(/^#/, '');
const routes = new Map(CANARY_LINES.map(line => [line.label, line.busRouteIds]));
const finite = Number.isFinite;
const elapsedClock = /\bWaiting(?: nearby)? \d+:[0-5]\d\b/;
const visibleClock = /\bStopped(?: nearby)? \d+:[0-5]\d\b/;

/** One browser evaluation reads the markers and their permanent pause labels.
 * Hidden/collapsed maps and labels outside their map do not establish coverage. */
export async function readPauseMaps(page) {
  return page.locator('.trip-map-wrap').evaluateAll(maps => maps.flatMap(map => {
    const canvas = map.querySelector('.leaflet-container');
    if (!canvas) return [];
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return [];
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element.closest('.leaflet-tooltip') ?? element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && Number(style.opacity) > 0.9 && rect.right > bounds.left && rect.left < bounds.right
        && rect.bottom > bounds.top && rect.top < bounds.bottom;
    };
    return [{ markers: [...map.querySelectorAll('.bus-pin-sm')].filter(visible)
      .map(marker => ({ name: marker.getAttribute('aria-label') })),
    labels: [...map.querySelectorAll('.bus-wait-label')]
      .map(label => ({ text: label.textContent, visible: visible(label) })) }];
  }));
}

/** Independent of the app's label/hold helpers. This tests an observed clock,
 * never the correctness of a departure forecast or a physical bus stop. */
export function auditPauseMaps(maps, feed, receivedAt, now, stable = true) {
  const result = { checked: 0, skipped: 0, findings: [], reason: null };
  const skip = reason => ({ ...result, reason });
  if (!stable) return skip('feed-replaced-during-read');
  if (![now, receivedAt].every(finite) || now < receivedAt || now - receivedAt > 30_000)
    return skip('stale-or-invalid-receipt');
  if (now - receivedAt < 1000) return skip('render-settling');
  const wire = feed?.server_eta;
  if (wire?.v !== 2 || ![wire.at, wire.servedAt].every(finite) || wire.servedAt < wire.at
    || !Array.isArray(wire.buses) || wire.buses.length > 200 || !Array.isArray(wire.rows)
    || wire.rows.length > 30_000) return skip('unavailable-wire');
  const ageMs = wire.servedAt - wire.at + now - receivedAt;
  if (ageMs >= 45_000) return skip('stale-forecast');
  // A malformed entry invalidates the app's whole snapshot, not just that bus.
  if (wire.buses.some(b => !Array.isArray(b) || b.length !== 4 || typeof b[0] !== 'string'
    || !routes.has(b[1]) || !Number.isInteger(b[2]) || b[2] < -1
    || (b[3] !== null && (!b[3] || !Number.isInteger(b[3].stopId)
      || !finite(b[3].standingSec) || b[3].standingSec < 0 || typeof b[3].approach !== 'boolean')))
    || wire.rows.some(r => !Array.isArray(r) || r.length !== 9 || !r.every(finite)
      || !Number.isInteger(r[0]) || r[0] < 0 || r[0] >= wire.buses.length
      || !Number.isInteger(r[1]) || !Number.isInteger(r[5]) || r[5] < 0
      || (r[6] !== 0 && r[6] !== 1) || r[2] < 0 || r[4] < r[3] || r[7] < 0))
    return skip('invalid-wire');
  for (const [map, snapshot] of (maps ?? []).entries()) {
    const names = snapshot.markers.map(marker => marker.name);
    const identities = names.map(name => typeof name === 'string' && !name.includes('just passed')
      ? name.match(/^(.+?) #([^\s.]+)(?:\.|$)/)?.slice(1) : null);
    for (const [markerIndex, name] of names.entries()) {
      const identity = identities[markerIndex];
      if (!identity || identities.filter(other => other?.[0] === identity[0] && other?.[1] === identity[1]).length !== 1) {
        result.skipped++; continue;
      }
      const [label, busName] = identity;
      const tracks = wire.buses.map((bus, index) => ({ bus, index }))
        .filter(({ bus }) => bus[1] === label && bare(bus[0]) === busName);
      const buses = (feed.buses ?? []).filter(bus => routes.get(label)?.includes(bus.route_id)
        && bare(bus.bus_name) === busName);
      if (tracks.length !== 1 || buses.length !== 1) { result.skipped++; continue; }
      const { bus: track, index } = tracks[0], bus = buses[0], stand = track[3];
      const row = wire.rows.find(r => r[0] === index);
      const observationAge = wire.servedAt - bus.observed_at + now - receivedAt;
      if (!row || !stand || stand.standingSec + ageMs / 1000 < 180
        || !finite(observationAge) || observationAge < -5000 || observationAge > 30_000) {
        result.skipped++; continue;
      }
      result.checked++;
      const prefix = `${label} #${busName} `;
      const visible = snapshot.labels.some(l => l.visible && l.text?.startsWith(prefix) && visibleClock.test(l.text));
      const missing = [...(!elapsedClock.test(name) ? ['accessible-clock'] : []), ...(!visible ? ['visible-clock'] : [])];
      if (missing.length) result.findings.push({ map, label, bus: busName, stopId: stand.stopId, missing,
        modelAt: wire.at, observedAt: bus.observed_at, receivedAt, sampledAt: now,
        source: { wireBus: track, forecastRow: row, at: wire.at, servedAt: wire.servedAt },
        standingSec: stand.standingSec + ageMs / 1000, marker: name, labels: snapshot.labels });
    }
  }
  if (!result.checked) result.reason = (maps ?? []).length ? 'no-eligible-long-pause' : 'no-visible-overview-map';
  return result;
}

/** A run owns its episodes. Distinct producer and vehicle observations must
 * both advance; recovery, races, staleness and gaps reset confirmation. */
export function confirmPauseMaps(previous, findings, now) {
  const state = {}, alerts = [];
  if (!finite(now)) return { state, alerts };
  for (const finding of findings) {
    const key = JSON.stringify([finding.map, finding.label, finding.bus, finding.stopId, finding.missing]);
    const old = previous?.[key];
    const same = old && now >= old.lastAt && now - old.lastAt <= 30_000
      && finding.modelAt >= old.lastModelAt && finding.observedAt >= old.lastObservation;
    const next = same ? { ...old, lastAt: now, lastModelAt: finding.modelAt, lastObservation: finding.observedAt }
      : { firstAt: now, lastAt: now, firstModelAt: finding.modelAt, lastModelAt: finding.modelAt,
        firstObservation: finding.observedAt, lastObservation: finding.observedAt, firstWitness: finding, reported: false };
    if (!next.reported && now - next.firstAt >= 5000
      && finding.modelAt - next.firstModelAt >= 5000 && finding.observedAt - next.firstObservation >= 5000) {
      next.reported = true;
      alerts.push({ ...finding, firstWitness: next.firstWitness, firstSeenAt: next.firstAt, confirmedAt: now,
        scope: 'Sustained sampled map/served-standing contradiction; review required. No departure accuracy or physical-service verdict.' });
    }
    state[key] = next;
  }
  return { state, alerts };
}
