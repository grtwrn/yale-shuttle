import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCheckpoint, restoreCheckpoint, saveCheckpoint } from './checkpoint.mjs';
let dir;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = undefined; });
test('checkpoint preserves the ride and restores browser state once, without resurrecting it on a new journey', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-resume-'));
  const run = { id: '123', phase: 'riding', busName: '#48', line: { label: 'Blue Day', busRouteIds: [1] },
    trip: { origin: { label: 'Origin', lat: 41, lon: -72 }, destination: { display_name: 'Destination', lat: 42, lon: -72 } } };
  await saveCheckpoint(dir, { evaluate: async () => ({ local: { 'shuttle-boarded-ride': 'saved ride' }, session: {} }) }, run, { latitude: 41, longitude: -72 });
  const saved = await loadCheckpoint(dir); expect(saved.run).toEqual(run);
  expect(await loadCheckpoint(dir, saved.savedAt + 6 * 60000)).toBeNull();
  let script, args, geo;
  await restoreCheckpoint({ setGeolocation: async p => { geo = p; }, addInitScript: async (fn, a) => { script = fn; args = a; } }, saved,
    { buses: [{ bus_name: '#48', route_id: 1, lat: 41.2, lon: -72.1 }] });
  expect(geo).toEqual({ latitude: 41.2, longitude: -72.1 });
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) });
  const priorLocal = globalThis.localStorage, priorSession = globalThis.sessionStorage;
  globalThis.localStorage = storage(local); globalThis.sessionStorage = storage(session);
  try {
    script(args); expect(local.get('shuttle-boarded-ride')).toBe('saved ride');
    local.delete('shuttle-boarded-ride'); session.clear(); script(args);
    expect(local.has('shuttle-boarded-ride')).toBe(false); expect(session.has('shuttle-trip-draft')).toBe(false);
  } finally { globalThis.localStorage = priorLocal; globalThis.sessionStorage = priorSession; }
});
