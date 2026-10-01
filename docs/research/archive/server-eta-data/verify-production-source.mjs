import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = 'https://yale-shuttle.fly.dev';
const expected = process.env.EXPECTED_BUILD;
const out = '/home/gwarren/projects/yale-shuttle-watcher/server-eta-data';
const records = [];
for (let i = 0; i < 6; i++) {
  const start = Date.now();
  const [health, payload] = await Promise.all(['/healthz', '/api/buses'].map(async path => {
    const r = await fetch(base + path); assert.equal(r.status, 200); return r.json();
  }));
  if (expected) assert(health.build.startsWith(expected), `Expected build ${expected}, got ${health.build}`);
  const s = health.serverEta, wire = payload.server_eta;
  assert(s && s.steps > 0 && s.failures === 0, 'Engine not healthy');
  assert(wire && wire.v === 2 && wire.rows.length > 0, 'No v2 arrivals');
  assert(wire.servedAt - wire.at < 15_000, 'Server forecast is not fresh');
  assert(Date.now() - wire.at < 20_000, 'Old response');
  assert(payload.buses.every(b => Number.isFinite(b.observed_at)), 'Missing GPS observation timestamp');
  assert(wire.rows.every(r => r.length === 9 && r.every(Number.isFinite)), 'Invalid row');
  assert(wire.buses.every(b => b.length === 4 && b[2] >= 0), 'Missing tracking metadata');
  const record = { at: new Date().toISOString(), requestMs: Date.now() - start, build: health.build,
    collectorLagMs: health.collectorLagMs, engine: s, wireAgeMs: Date.now() - wire.at,
    forecastBuses: wire.buses.length, routes: [...new Set(wire.buses.map(b => b[1]))], rows: wire.rows.length };
  records.push(record);
  if (i === 0) await fs.writeFile(out + '/production-payload.json', JSON.stringify(payload));
  if (i < 5) await new Promise(resolve => setTimeout(resolve, 5000));
}
assert(records.at(-1).engine.steps > records[0].engine.steps, 'Engine stopped advancing');
assert(records.at(-1).engine.checkpointAt > 0, 'Checkpoint not saved');
await fs.writeFile(out + '/production-source-verification.json', JSON.stringify(records, null, 2));
console.log(JSON.stringify(records, null, 2));
