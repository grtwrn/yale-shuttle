import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = 'https://yale-shuttle.fly.dev';
const expected = process.env.EXPECTED_BUILD;
assert(expected, 'EXPECTED_BUILD required');
const evidence = { expected, at: new Date().toISOString(), polls: [], history: [] };
async function json(path) {
  const start = performance.now();
  const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200, path);
  return { body: await r.json(), ms: performance.now() - start };
}
for (let i = 0; i < 5; i++) {
  const [{ body: health }, { body: feed, ms }] = await Promise.all([json('/healthz'), json('/api/buses')]);
  assert.equal(health.build, expected);
  assert.equal(health.ok, true);
  assert.equal(health.serverEta.failures, 0);
  const wire = feed.server_eta;
  assert(wire?.rows.length > 0 && wire.buses.length > 0);
  assert(wire.servedAt - wire.at < 45000);
  assert.equal(wire.distributions.length, wire.rows.length);
  for (const dots of wire.distributions) assert(dots.length === 50 && dots.every((v, j) => Number.isFinite(v) && v >= 0 && (!j || v >= dots[j - 1])));
  evidence.polls.push({ health, feedMs: ms, routes: [...new Set(wire.buses.map(b => b[1]))] });
  if (i === 0) {
    const rows = wire.rows.filter(r => ['Red', 'Blue Day'].includes(wire.buses[r[0]][1]) && r[1] === (wire.buses[r[0]][1] === 'Red' ? 48 : 72) && r[2] > 0).sort((a, b) => a[2] - b[2]).slice(0, 6);
    for (const row of rows) {
      const bus = wire.buses[row[0]];
      const query = new URLSearchParams({ route: bus[1], bus: bus[0], stop: String(row[1]), eta: String(Math.max(0, Math.round(row[2] - (Date.now() - wire.at) / 1000))) });
      const { body, ms } = await json('/api/journey-history?' + query);
      assert(body.asOf <= Date.now() + 5000 && body.recent.length <= 3);
      const j = body.journey;
      if (j) {
        assert(j.trips.length <= 24 && ['standing', 'departure'].includes(j.mode));
        const seen = new Set();
        for (const t of j.trips) {
          assert(t.startedAt <= t.departedAt && t.departedAt < t.arrivedAt && t.arrivedAt <= body.asOf);
          assert(Math.abs(t.actualSec - (t.arrivedAt - t.startedAt) / 1000) < 0.001);
          assert(!seen.has(t.busName + '|' + t.arrivedAt)); seen.add(t.busName + '|' + t.arrivedAt);
        }
      }
      const larger = await json('/api/journey-history?' + query + '&limit=100');
      const expanded = larger.body.journey;
      if (expanded) {
        assert(expanded.trips.length <= 100);
        const seen = new Set();
        for (const t of expanded.trips) {
          assert(t.startedAt <= t.departedAt && t.departedAt < t.arrivedAt && t.arrivedAt <= larger.body.asOf);
          assert(Math.abs(t.actualSec - (t.arrivedAt - t.startedAt) / 1000) < 0.001);
          assert(!seen.has(t.busName + '|' + t.arrivedAt)); seen.add(t.busName + '|' + t.arrivedAt);
        }
        if (j && j.fromName === expanded.fromName && j.toName === expanded.toName && j.mode === expanded.mode && j.elapsedSec === expanded.elapsedSec && Math.floor(body.asOf / 60000) === Math.floor(larger.body.asOf / 60000)) {
          assert.deepEqual(expanded.trips.slice(0, j.trips.length), j.trips, 'larger sample keeps the same matching rules');
        }
      }
      evidence.history.push({ query: Object.fromEntries(query), ms, result: body, expandedMs: larger.ms, expanded: larger.body });
    }
  }
  if (i < 4) await new Promise(r => setTimeout(r, 5000));
}
assert(evidence.polls.at(-1).health.serverEta.steps > evidence.polls[0].health.serverEta.steps, 'continuous tracker must advance');
await fs.writeFile(new URL('./production-verification.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ build: expected, polls: evidence.polls.length, histories: evidence.history.map(h => ({ ...h.query, ms: Math.round(h.ms), mode: h.result.journey?.mode, trips: h.result.journey?.trips.length, dates: h.result.journey?.serviceDates, expandedTrips: h.expanded.journey?.trips.length, expandedDates: h.expanded.journey?.serviceDates, expandedMs: Math.round(h.expandedMs) })), health: evidence.polls.at(-1).health }, null, 2));
