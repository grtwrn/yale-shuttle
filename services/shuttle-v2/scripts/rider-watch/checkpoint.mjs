import path from 'node:path';
import { atomicJson, readJson } from '../retention/storage.mjs';

export async function saveCheckpoint(root, page, run, lastPosition, now = Date.now()) {
  let browserState;
  try {
    browserState = await page.evaluate(() => ({
      local: Object.fromEntries(Object.entries(localStorage).filter(([key]) =>
        key === 'listView' || key === 'shuttle-anon-id' || key === 'shuttle-boarded-ride' || key === 'shuttle-transfer-handoff' || key.startsWith('shuttle-ride'))),
      session: { 'shuttle-trip-draft': sessionStorage.getItem('shuttle-trip-draft'),
        'shuttle-transfer-selection': sessionStorage.getItem('shuttle-transfer-selection') },
    }));
  } catch { /* The run can still be closed or restored if its browser failed. */ }
  if (!browserState?.local || !browserState?.session) {
    const previous = await readJson(path.join(root, 'resume.json'), null);
    browserState = run?.id && previous?.run?.id === run.id ? previous.browserState : undefined;
  }
  await atomicJson(path.join(root, 'resume.json'), { version: 1, savedAt: now, run, lastPosition, browserState });
}
export async function loadCheckpoint(root, now = Date.now()) {
  const saved = await readJson(path.join(root, 'resume.json'), null);
  if (!saved?.run || saved.version !== 1 || !Number.isFinite(saved.savedAt) || now - saved.savedAt > 5 * 60000 || saved.savedAt > now) return null;
  return saved;
}
export async function restoreCheckpoint(ctx, saved, feed, now = Date.now()) {
  const run = saved.run;
  const bus = run.phase === 'riding' && feed.buses.find(b => b.bus_name.replace(/^#/, '') === String(run.busName).replace(/^#/, '')
    && run.line.busRouteIds.includes(b.route_id));
  const at = bus ? { latitude: bus.lat, longitude: bus.lon } : saved.lastPosition
    ?? { latitude: run.trip.origin.lat, longitude: run.trip.origin.lon };
  await ctx.setGeolocation(at);
  await ctx.addInitScript(({ saved, now }) => {
    if (typeof window !== 'undefined' && window.top !== window) return;
    const marker = String(saved.savedAt);
    if (localStorage.getItem('shuttle-monitor-restored') === marker) return;
    for (const [key, value] of Object.entries(saved.browserState?.local ?? {})) if (typeof value === 'string') localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(saved.browserState?.session ?? {})) if (typeof value === 'string') sessionStorage.setItem(key, value);
    if (!sessionStorage.getItem('shuttle-trip-draft')) {
      const trip = saved.run.transfer?.originalTrip ?? saved.run.trip;
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: trip.origin.label,
        fromLL: { lat: trip.origin.lat, lon: trip.origin.lon }, toText: trip.destination.display_name,
        toLL: { lat: trip.destination.lat, lon: trip.destination.lon }, tripTime: '', expandedKey: saved.run.line.label, savedAt: now }));
    }
    localStorage.setItem('shuttle-monitor-restored', marker);
  }, { saved, now });
}
