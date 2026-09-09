#!/usr/bin/env node
/** Local-runner helper, uploaded temporarily; never included in the runtime image.
 * Run with the target installation's tsx CLI. No credentials are read or printed.
 */
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const canonical = value => JSON.stringify(value, function (_key, v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const writeReceipt = (path, receipt) => {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
};

export function validateEnvelope(value, identity, dayStart, now) {
  assert(value?.algorithm === identity.algorithm, 'Algorithm mismatch');
  assert(canonical(value.policy) === canonical(identity.policy), 'Policy mismatch');
  if (value.offloadProvenance) {
    assert(canonical(value.offloadProvenance.sourceHashes) === canonical(identity.sourceHashes), 'Offloaded fit/live source mismatch');
    assert(canonical(value.offloadProvenance.dependencies) === canonical(identity.dependencies), 'Offloaded fit/live dependency mismatch');
  }
  const { fit, request, diagnostics } = value;
  assert(fit?.version === 'analytic-phase-stack-v2' && fit.options?.weightObjective === 'remaining', 'Wrong model family/objective');
  assert(Number.isFinite(fit.fittedAt) && fit.fittedAt <= now && now - fit.fittedAt < identity.policy.maximumFitAgeMs, 'Future or stale fit');
  assert(request?.cutoff === fit.fittedAt && diagnostics?.cutoff === fit.fittedAt, 'Cutoff provenance mismatch');
  assert(request.serviceDayCutoff === dayStart && diagnostics.serviceDayCutoff === dayStart, 'Wrong ET service date');
  assert(fit.fittedAt >= dayStart && request.observedAt === fit.fittedAt && Number.isFinite(request.from) && request.from < dayStart, 'Invalid observation/training cutoff');
  for (const key of ['maximumRows', 'lookbackDays', 'serviceDaysPerRoute']) {
    assert(request[key] === identity.policy[key], `Request policy mismatch: ${key}`);
  }
  assert(Number.isInteger(diagnostics.trainingRows) && diagnostics.trainingRows > 0 && diagnostics.trainingRows <= identity.policy.maximumRows, 'Invalid training row count');
  assert(Array.isArray(diagnostics.trainingDates) && diagnostics.trainingDates.length > 0, 'Missing selected training dates');
  const dates = new Map();
  for (const d of diagnostics.trainingDates) {
    assert(Number.isFinite(d.from) && Number.isFinite(d.until) && d.from < d.until && d.until <= dayStart && d.from >= request.from, 'Invalid training date bounds');
    const seen = dates.get(d.routeId) ?? new Set();
    assert(!seen.has(d.day), 'Duplicate route training date'); seen.add(d.day); dates.set(d.routeId, seen);
    assert(seen.size <= identity.policy.serviceDaysPerRoute, 'Too many service dates for route');
  }
  assert(fit.cells && Object.keys(fit.cells).length > 0, 'Empty fitted model');
}

export function assertNotDowngrade(previous, value) {
  assert(!previous || previous.fitted_at <= value.fit.fittedAt, 'Refusing to downgrade a newer cached fit');
  if (previous?.fitted_at === value.fit.fittedAt) {
    assert(previous.algorithm === value.algorithm && canonical(JSON.parse(previous.model)) === canonical(value.fit), 'Conflicting fit at identical cutoff');
  }
}

function validateWithProductionLoader(Database, StandingForecastModel, row) {
  const test = new Database(':memory:');
  try {
    test.exec('CREATE TABLE standing_forecast_models(id INTEGER PRIMARY KEY,algorithm TEXT,fitted_at INTEGER,created_at INTEGER,model TEXT,diagnostics TEXT)');
    test.prepare('INSERT INTO standing_forecast_models VALUES(1,@algorithm,@fitted_at,@created_at,@model,@diagnostics)').run(row);
    const model = new StandingForecastModel(test, { autoFit: false });
    assert(model.status().fittedAt === row.fitted_at, 'Production cache loader rejected fit'); model.stop();
  } finally { test.close(); }
}

function sourceHashes(root) {
  const files = [];
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk('src/calibrator');
  files.push('src/network/TransitNetwork.ts', 'src/network/alignStops.ts', 'src/network/geo.ts',
    'src/network/legs.ts', 'src/schema/api.ts', 'package.json', 'package-lock.json');
  return Object.fromEntries(files.sort().map(f => [f, hash(readFileSync(join(root, f)))]));
}

async function main() {
  process.umask(0o077);
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string', default: '/app' }, db: { type: 'string', default: '/data/shuttle-v2.db' },
    input: { type: 'string' }, sha: { type: 'string' }, receipt: { type: 'string' }, output: { type: 'string' },
  } });
  const action = positionals[0];
  assert(['identity', 'backup', 'validate', 'install', 'restore'].includes(action), 'identity|backup|validate|install|restore required');
  const root = resolve(a.root), require = createRequire(join(root, 'package.json'));
  const Database = require('better-sqlite3');
  const { STANDING_ALGORITHM, STANDING_FIT_POLICY, StandingForecastModel } = await import(pathToFileURL(join(root, 'src/calibrator/standingForecast.ts')));
  const { standingDayBounds } = await import(pathToFileURL(join(root, 'src/calibrator/standingForecastData.ts')));
  const now = Date.now(), [day] = standingDayBounds(now);
  const identity = { algorithm: STANDING_ALGORITHM, policy: STANDING_FIT_POLICY, sourceHashes: sourceHashes(root),
    dependencies: Object.fromEntries(['better-sqlite3','kdbush','drizzle-orm','tsx','zod'].map(name =>
      [name, JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'))).version])),
    helperSha256: hash(readFileSync(new URL(import.meta.url))),
    build: process.env.SHUTTLE_BUILD_SHA ?? null, machineId: process.env.FLY_MACHINE_ID ?? null,
    autoFitDisabled: process.env.SHUTTLE_STANDING_FORECAST === '0', now, dayStart: day,
    node: process.version, sqlite: require('better-sqlite3/package.json').version };
  if (action === 'identity') { console.log(JSON.stringify(identity)); return; }
  if (action === 'backup') {
    assert(a.output, '--output required');
    const db = new Database(a.db, { readonly: true, fileMustExist: true });
    try {
      await db.backup(a.output, { progress: () => 100 });
      chmodSync(a.output, 0o600);
      console.log(JSON.stringify({ ...identity, snapshotCutoff: now, snapshotSha256: hash(readFileSync(a.output)), output: a.output }));
    } finally { db.close(); }
    return;
  }
  assert(a.input && a.sha && (action === 'validate' || a.receipt), '--input, --sha, and --receipt (for mutations) required');
  const bytes = readFileSync(a.input); assert(hash(bytes) === a.sha, 'Input SHA256 mismatch');
  const value = JSON.parse(bytes.toString());
  let row;
  if (action !== 'restore') {
    validateEnvelope(value, identity, day, now);
    row = { algorithm: value.algorithm, fitted_at: value.fit.fittedAt, created_at: now,
      model: JSON.stringify(value.fit), diagnostics: JSON.stringify(value.diagnostics) };
    validateWithProductionLoader(Database, StandingForecastModel, row);
    if (action === 'validate') {
      console.log(JSON.stringify({ valid: true, databaseOpened: ':memory:', algorithm: identity.algorithm,
        fittedAt: row.fitted_at, inputSha256: a.sha, serviceDayCutoff: day })); return;
    }
  }
  const db = new Database(a.db, { fileMustExist: true }); db.pragma('busy_timeout = 5000');
  const select = sql => sql.prepare('SELECT id,algorithm,fitted_at,created_at,model,diagnostics FROM standing_forecast_models WHERE id=1').get();
  const put = (sql, row) => sql.prepare(`INSERT INTO standing_forecast_models (id,algorithm,fitted_at,created_at,model,diagnostics)
    VALUES (1,@algorithm,@fitted_at,@created_at,@model,@diagnostics) ON CONFLICT(id) DO UPDATE SET
    algorithm=excluded.algorithm,fitted_at=excluded.fitted_at,created_at=excluded.created_at,model=excluded.model,diagnostics=excluded.diagnostics`).run(row);
  try {
    if (action === 'restore') {
      assert(value.action === 'installed' && value.installedModelSha256, 'Invalid rollback receipt');
      db.transaction(() => {
        const current = select(db);
        assert(current && hash(current.model) === value.installedModelSha256 && current.algorithm === value.algorithm, 'Cache changed since install; rollback refused');
        if (value.previous) put(db, value.previous);
        else db.prepare('DELETE FROM standing_forecast_models WHERE id=1').run();
      })();
      const receipt = { action: 'restored', at: Date.now(), inputSha256: a.sha };
      writeReceipt(a.receipt, receipt);
      console.log(JSON.stringify(receipt)); return;
    }
    let receipt;
    db.transaction(() => {
      const previous = select(db); assertNotDowngrade(previous, value);
      receipt = { action: 'installed', at: now, algorithm: identity.algorithm, fittedAt: row.fitted_at,
        serviceDayCutoff: day, inputSha256: a.sha, installedModelSha256: hash(row.model), previous: previous ?? null,
        build: identity.build, machineId: identity.machineId, sourceHashes: identity.sourceHashes };
      // Durable rollback data precedes the atomic mutation; an existing receipt is never overwritten.
      writeReceipt(a.receipt, receipt);
      put(db, row);
    })();
    console.log(JSON.stringify({ ...receipt, previous: receipt.previous ? { algorithm: receipt.previous.algorithm, fittedAt: receipt.previous.fitted_at } : null }));
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
