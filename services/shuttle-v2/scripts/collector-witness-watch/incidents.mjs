import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { witnessSHA } from '../../src/collector/witnessCodec.ts';

const validID = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
async function syncDirectory(folder) {
  const dir = await fs.open(folder, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
function sameOriginal(previous, incident) {
  const original = Object.fromEntries(Object.keys(incident).map(key => [key, previous[key]]));
  return witnessSHA(JSON.stringify(original)) === witnessSHA(JSON.stringify(incident));
}

/** Publish without overwriting another receipt. Sync the file and directory
 * before recording delivery in SQLite. A lost acknowledgement retries the
 * same identity, including after the guardian moves it to processed. */
export async function persistIncident(directory, name, incident) {
  if (path.basename(name) !== name || !/^[a-z0-9-]+\.json$/.test(name)) throw Error('Invalid incident filename');
  const expected = witnessSHA(JSON.stringify(incident));
  for (const folder of [directory, path.join(path.dirname(directory), 'processed')]) {
    try {
      const previous = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
      if (previous.id !== incident.id || previous.sourceIncidentID !== incident.sourceIncidentID
        || !sameOriginal(previous, incident)) throw Error('Collector incident identity conflict');
      await syncDirectory(folder);
      return { file: path.join(folder, name), sha256: expected };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name), temp = path.join(directory, '.' + name + '.' + randomUUID() + '.partial');
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(incident, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temp, file); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const previous = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!sameOriginal(previous, incident)) throw Error('Collector incident identity conflict');
    }
    await syncDirectory(directory);
  } finally { await fs.unlink(temp).catch(() => {}); }
  return { file, sha256: expected };
}

/** The collector cursor already commits with the diagnostic incident. Queue
 * delivery is separate: its failure cannot erase the incident or its source
 * pins, and each later invocation retries undelivered records independently
 * of whether the production endpoint is available or any new frame arrived. */
export async function dispatchIncidents({ store, directory, now = Date.now(), limit = 16, persist = persistIncident }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('Invalid collector incident delivery limit');
  const rows = store.db.prepare(`SELECT i.id,i.json FROM incidents i LEFT JOIN meta m
    ON m.key='incident-delivery:'||i.id WHERE m.key IS NULL ORDER BY i.id LIMIT ?`).all(limit);
  const delivered = []; let failures = 0;
  for (const row of rows) {
    try {
      if (!validID(row.id)) throw Error('Invalid source incident identity');
      const lead = JSON.parse(row.json);
      if (!Number.isSafeInteger(lead.at) || lead.at < 0 || typeof lead.epoch !== 'string'
        || !['derived-leg-speed-review', 'unchanged-fix-anchor-progress-review', 'collector-witness-gap', 'collector-capture-unavailable'].includes(lead.kind)) throw Error('Invalid collector review lead');
      // Stable contents on retry. New context remains pinned in the database;
      // it must not mutate an already published incident after delivery.
      const id = row.id.slice(0, 20), gap = lead.kind === 'collector-witness-gap', unavailable = lead.kind === 'collector-capture-unavailable';
      const progress = lead.kind === 'unchanged-fix-anchor-progress-review';
      const incident = { id, sourceIncidentID: row.id, source: 'collector-witness-watch',
        kind: lead.kind, severity: 'medium', detectedAt: new Date(lead.at).toISOString(),
        summary: gap ? 'Collector evidence continuity was lost; the retained boundary needs review.'
          : unavailable ? 'A collector poll has incomplete capture or source-write evidence; review its retained diagnostic frames.'
          : progress ? 'A route anchor advanced at an unchanged GPS fix despite a competitive prior stop; review the captured state and geometry.'
          : lead.reviewClass === 'multi-hop-proxy' ? 'A multi-hop collector proxy has a short endpoint-clock duration; its row is excluded from one-hop calibration. Review the captured input.'
          : 'A committed derived leg has an unusually short duration for its stop endpoints; review the captured input.',
        detail: lead, evidence: { database: store.file, incidentID: row.id,
          sourcePins: 'incident_chunks retains the source page and available surrounding history/topology; query by incidentID.' },
        note: 'Diagnostic review only. Not independent physical service, ETA accuracy, an eligibility correction, or instructions.' };
      const receipt = await persist(directory, 'collector-' + (gap ? 'gap-' : unavailable ? 'capture-' : progress ? 'progress-' : 'leg-') + id + '.json', incident);
      store.put('incident-delivery:' + row.id, { at: now, ...receipt });
      delivered.push(id);
    } catch { failures++; }
  }
  const pending = store.db.prepare(`SELECT count(*) n FROM incidents i LEFT JOIN meta m
    ON m.key='incident-delivery:'||i.id WHERE m.key IS NULL`).get().n;
  return { ok: failures === 0, delivered, pending, failures };
}
