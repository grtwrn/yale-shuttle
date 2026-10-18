import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';
import { decodeWitness, validatePage, validHead, initialChain, derivedLegLeads } from './protocol.mjs';
import { anchorProgressLeads } from './progress.mjs';

const MiB = 1024 * 1024, DAY = 86400000;
// Vite 5 predates this Node builtin; load it with Node's native resolver.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
export const DEFAULT_POLICY = { maxBytes: 256 * MiB, maxAgeMs: 7 * DAY, minFreeBytes: 128 * MiB };
export class StorageHold extends Error {}
const facts = p => ({ epoch: p.epoch, build: p.build, frames: p.frames, evaluations: p.evaluations ?? [] });
export const chunkKey = p => witnessSHA(witnessJSON(facts(p)));
const same = (a, b) => witnessJSON(a) === witnessJSON(b);
const header = ({ json, ...rest }) => rest;

function evaluationRefs(context) {
  const found = [], seen = new Set();
  function visit(v, depth) {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    if (depth > 16) throw Error('Report context depth exceeds capture bound');
    seen.add(v);
    const e = v.evaluation;
    if (e !== undefined && e !== null) {
      if (!e || typeof e.epoch !== 'string' || !e.epoch || !Number.isSafeInteger(e.cursor) || e.cursor < 1
        || !Number.isSafeInteger(e.at) || !/^[a-f0-9]{64}$/.test(e.sha256 ?? '')) throw Error('Invalid report model reference');
      found.push({ epoch: e.epoch, cursor: e.cursor, at: e.at, sha256: e.sha256 });
    }
    for (const x of Object.values(v)) visit(x, depth + 1);
  }
  visit(context, 0);
  if (found.length > 64) throw Error('Report model reference bound exceeded');
  return found;
}

/** Operator-local, single writer. Payload and cursor share one FULL-synchronous
 * commit. DELETE journal + FULL auto-vacuum avoid an accumulating WAL. Only a
 * third of the physical budget is available to the database; the rest reserves
 * its rollback journal and status files. Busy/protected storage holds capture. */
export class WitnessStore {
  constructor(root, { policy = {} } = {}) {
    this.root = root; this.policy = { ...DEFAULT_POLICY, ...policy };
    for (const [k, v] of Object.entries(this.policy)) if (!Number.isSafeInteger(v) || v < (k === 'minFreeBytes' ? 0 : 1)) throw Error('Invalid witness storage policy');
    if (this.policy.maxBytes < 3 * MiB) throw Error('Witness physical budget is too small');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('Invalid witness directory');
    this.file = path.join(root, 'witnesses.sqlite');
    if (fs.existsSync(this.file) && (!fs.lstatSync(this.file).isFile() || fs.lstatSync(this.file).isSymbolicLink())) throw Error('Invalid witness database');
    this.db = new DatabaseSync(this.file);
    try {
      fs.chmodSync(this.file, 0o600);
      this.db.exec('PRAGMA busy_timeout=500; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA journal_mode=DELETE');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const existing = this.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n;
      if (version !== 1 && (version !== 0 || existing)) throw Error('Unrecognized witness schema');
      if (!existing) this.db.exec(`PRAGMA auto_vacuum=FULL;
        CREATE TABLE meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE topologies (sha TEXT PRIMARY KEY, bytes INTEGER NOT NULL, payload BLOB NOT NULL);
        CREATE TABLE chunks (key TEXT PRIMARY KEY, epoch TEXT NOT NULL, build TEXT NOT NULL,
          first INTEGER NOT NULL, last INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
          raw_sha TEXT NOT NULL, payload BLOB NOT NULL);
        CREATE INDEX chunk_time ON chunks(end_at,start_at);
        CREATE TABLE chunk_topologies (chunk TEXT REFERENCES chunks(key) ON DELETE CASCADE,
          topology TEXT REFERENCES topologies(sha), PRIMARY KEY(chunk,topology));
        CREATE TABLE frames (epoch TEXT, seq INTEGER, header TEXT NOT NULL, PRIMARY KEY(epoch,seq));
        CREATE TABLE chunk_frames (chunk TEXT REFERENCES chunks(key) ON DELETE CASCADE,
          epoch TEXT, seq INTEGER, PRIMARY KEY(chunk,epoch,seq), FOREIGN KEY(epoch,seq) REFERENCES frames(epoch,seq));
        CREATE TABLE model_refs (epoch TEXT, cursor INTEGER, sha TEXT, collector_epoch TEXT, collector_seq INTEGER,
          collector_sha TEXT, at INTEGER NOT NULL, chunk TEXT REFERENCES chunks(key) ON DELETE CASCADE,
          PRIMARY KEY(epoch,cursor,sha));
        CREATE TABLE incidents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE incident_chunks (incident TEXT REFERENCES incidents(id), chunk TEXT REFERENCES chunks(key), PRIMARY KEY(incident,chunk));
        CREATE TABLE report_chunks (report INTEGER, chunk TEXT REFERENCES chunks(key) ON DELETE CASCADE, PRIMARY KEY(report,chunk));
        CREATE TABLE boundaries (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
        PRAGMA user_version=1;`);
      if (this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 1) throw Error('Witness auto-vacuum unavailable');
      const page = this.db.prepare('PRAGMA page_size').get().page_size;
      this.databaseLimit = Math.floor(this.policy.maxBytes / 3 / page) * page;
      this.db.exec(`PRAGMA max_page_count=${this.databaseLimit / page}`);
      if (this.usedBytes() > this.databaseLimit) throw new StorageHold('Existing witness database exceeds budget');
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Witness integrity check failed');
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  get(key, fallback = null) { const r = this.db.prepare('SELECT json FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.json) : fallback; }
  put(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  checkpoint() { return this.get('checkpoint'); }
  acknowledgeHead(head) {
    const cp = this.checkpoint();
    if (!validHead(head) || head.epoch !== cp?.epoch || head.build !== cp.build || head.latest < cp.after) throw Error('Collector head regressed');
    this.put('checkpoint', { ...cp, evaluationEpoch: head.evaluationEpoch, evaluationCursor: head.evaluationCursor });
  }
  usedBytes() { return this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size; }
  disk() {
    let bytes = 0, unknown = false;
    for (const name of fs.readdirSync(this.root)) {
      const s = fs.lstatSync(path.join(this.root, name)); bytes += Math.max(s.size, (s.blocks ?? 0) * 512);
      if (!s.isFile() || s.isSymbolicLink() || !['witnesses.sqlite','witnesses.sqlite-journal','storage.lock','status.json','retention.json','watcher.log'].includes(name)
        && !/^watcher\.log\.\d+\.gz$/.test(name)) unknown = true;
    }
    const f = fs.statfsSync(this.root);
    return { bytes, freeBytes: f.bavail * f.bsize, unknown };
  }
  assertRoom(reserve = 0) {
    const d = this.disk();
    if (d.unknown) throw new StorageHold('Unknown witness files require review');
    if (this.usedBytes() + reserve > this.databaseLimit || d.bytes + this.databaseLimit + reserve > this.policy.maxBytes
      || d.freeBytes < this.policy.minFreeBytes + this.databaseLimit + reserve) throw new StorageHold('Witness storage reserve exhausted; protected evidence retained');
  }
  beginEpoch(head, reason, now = Date.now()) {
    if (!validHead(head)) throw Error('Invalid collector head');
    const previous = this.checkpoint(), after = head.oldest - 1;
    const cp = { epoch: head.epoch, build: head.build, after, at: -1, beganAt: now,
      chain: after === 0 ? initialChain(head.epoch) : null, lastFrame: null, evaluationEpoch: null, evaluationCursor: null };
    this.assertRoom(65536);
    this.transaction(() => {
      this.db.prepare('INSERT INTO boundaries(at,json) VALUES (?,?)').run(now, JSON.stringify({ reason, previous, head, clippedPrefix: after > 0 }));
      this.db.exec('DELETE FROM boundaries WHERE id NOT IN (SELECT id FROM boundaries ORDER BY id DESC LIMIT 256)');
      if (reason === 'source-prefix-expired' && previous) {
        const gap = { kind: 'collector-witness-gap', at: now, epoch: head.epoch,
          previous: { epoch: previous.epoch, after: previous.after, chain: previous.chain },
          firstAvailable: head.oldest, missingFrom: previous.after + 1, missingThrough: head.oldest - 1 };
        const id = witnessSHA(witnessJSON(gap));
        this.db.prepare('INSERT OR IGNORE INTO incidents VALUES (?,?)').run(id, JSON.stringify(gap));
        const active = this.get('activeChunk');
        if (active) this.db.prepare('INSERT OR IGNORE INTO incident_chunks VALUES (?,?)').run(id, active);
      }
      this.put('capture-run', null);
      this.put('anchor-progress', null);
      this.put('checkpoint', cp);
    });
    return cp;
  }
  topology(sha) {
    const r = this.db.prepare('SELECT * FROM topologies WHERE sha=?').get(sha);
    if (!r) return null;
    const json = gunzipSync(r.payload, { maxOutputLength: 2 * MiB }).toString();
    if (witnessSHA(json) !== sha || Buffer.byteLength(json) !== r.bytes) throw Error('Stored topology differs');
    return { sha256: sha, json, bytes: r.bytes };
  }
  knownTopologies() {
    return new Map(this.db.prepare('SELECT topology FROM chunk_topologies t JOIN chunks c ON c.key=t.chunk GROUP BY topology ORDER BY max(end_at) DESC LIMIT 16').all()
      .map(r => [r.topology, this.topology(r.topology)]));
  }
  readChunk(key) {
    const r = this.db.prepare('SELECT * FROM chunks WHERE key=?').get(key);
    if (!r) throw Error('Witness chunk unavailable');
    const raw = gunzipSync(r.payload, { maxOutputLength: 20 * MiB }).toString();
    if (witnessSHA(raw) !== r.raw_sha) throw Error('Stored witness bytes differ');
    const value = JSON.parse(raw);
    if (chunkKey(value) !== key || value.epoch !== r.epoch || value.frames[0]?.seq !== r.first || value.frames.at(-1)?.seq !== r.last) throw Error('Stored witness identity differs');
    return value;
  }
  commitPage(page, { transport = {}, seenHead, revisit = false, now = Date.now() } = {}) {
    const saved = this.checkpoint();
    if (!saved || !validHead(seenHead) || seenHead.epoch !== saved.epoch || seenHead.build !== saved.build) throw Error('Collector epoch requires an explicit boundary');
    const key = chunkKey(page);
    if (this.db.prepare('SELECT 1 FROM chunks WHERE key=?').get(key)) {
      if (!same(facts(this.readChunk(key)), facts(page))) throw Error('Conflicting chunk retry');
      if (revisit) this.acknowledgeHead(seenHead);
      return { key, duplicate: true, checkpoint: this.checkpoint(), leads: [] };
    }
    const before = revisit ? { ...saved, after: saved.after - 1, at: saved.lastFrame?.at - 1, chain: saved.lastFrame?.previousChain } : saved;
    if (revisit && (!saved.lastFrame || page.frames?.length !== 1 || !same(header(page.frames[0]), saved.lastFrame))) throw Error('Invalid last-frame revisit');
    const verified = validatePage(page, before, this.knownTopologies());
    if (!verified.frames.length) throw Error('Cannot commit an empty witness page');
    const progress = revisit ? { context: this.get('anchor-progress'), leads: [] }
      : anchorProgressLeads(verified.frames, this.get('anchor-progress'), page.epoch);
    const keepChunks = new Set();
    // Retain the actual earlier observation, even under rolling pressure.
    // If it was already retired, report unknown coverage rather than a lead.
    const progressLeads = progress.leads.filter(lead => {
      const prior = lead.previousFrame;
      if (verified.frames.some(r => r.frame.seq === prior.seq && r.frame.sha256 === prior.frameSHA256)) return true;
      const chunks = this.db.prepare(`SELECT c.chunk,f.header FROM chunk_frames c JOIN frames f
        ON f.epoch=c.epoch AND f.seq=c.seq WHERE c.epoch=? AND c.seq=?`).all(page.epoch, prior.seq)
        .filter(r => decodeWitness(r.header).sha256 === prior.frameSHA256);
      for (const row of chunks) keepChunks.add(row.chunk);
      if (chunks.length) return true;
      progress.context.lastUnknown = { seq: lead.seq, reason: 'prior-frame-not-retained' };
      const events = progress.context.coverage.withholdEvents;
      events['prior-frame-not-retained'] = (events['prior-frame-not-retained'] ?? 0) + 1; return false;
    });
    const leads = [...derivedLegLeads(verified.frames), ...progressLeads], value = { ...facts(page), transport: { ...transport,
      retained: 'Exact embedded frame JSON and topology bytes; outer HTTP body hash only.' } }, raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 20 * MiB) throw Error('Durable witness page exceeds bound');
    const payload = gzipSync(raw);
    const suppliedTopologies = [...new Map([...this.knownTopologies(), ...page.topologies.map(t => [t.sha256,t])])].map(([,t])=>t);
    // Include the full dictionary in the reservation: rolling cleanup below
    // can remove a previously known topology before this transaction starts.
    const compressedTopologies = suppliedTopologies.map(t => ({ ...t, payload: gzipSync(t.json) }));
    const reserve = 131072 + 3 * (payload.length + compressedTopologies.reduce((s, t) => s + t.payload.length, 0)
      + Buffer.byteLength(JSON.stringify(leads)));
    this.maintain({ now, reserveBytes: reserve, keepChunks }); this.assertRoom(reserve);
    const newTopologies = compressedTopologies.filter(t => !this.db.prepare('SELECT 1 FROM topologies WHERE sha=?').get(t.sha256));
    const cp = { ...verified.checkpoint, lastFrame: header(page.frames.at(-1)), evaluationEpoch: seenHead.evaluationEpoch, evaluationCursor: seenHead.evaluationCursor };
    this.transaction(() => {
      for (const t of newTopologies) this.db.prepare('INSERT INTO topologies VALUES (?,?,?)').run(t.sha256, t.bytes, t.payload);
      const a = page.frames[0], b = page.frames.at(-1);
      this.db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)').run(key, page.epoch, page.build, a.seq, b.seq, a.at, b.at, witnessSHA(raw), payload);
      for (const { frame: f } of verified.frames) {
        const old = this.db.prepare('SELECT header FROM frames WHERE epoch=? AND seq=?').get(page.epoch, f.seq), json = witnessJSON(header(f));
        if (old && old.header !== json) throw Error('Conflicting immutable collector frame');
        this.db.prepare('INSERT OR IGNORE INTO frames VALUES (?,?,?)').run(page.epoch, f.seq, json);
        this.db.prepare('INSERT INTO chunk_frames VALUES (?,?,?)').run(key, page.epoch, f.seq);
        if (f.topologySha256) this.db.prepare('INSERT OR IGNORE INTO chunk_topologies VALUES (?,?)').run(key, f.topologySha256);
      }
      for (const r of verified.evaluations) {
        const e = r.evaluation, prior = this.db.prepare('SELECT * FROM model_refs WHERE epoch=? AND cursor=?').get(e.epoch, e.cursor);
        if (prior && (prior.sha !== e.sha256 || prior.collector_epoch !== r.collectorEpoch || prior.collector_seq !== r.collectorSeq || prior.collector_sha !== r.collectorSHA256)) throw Error('Conflicting model/collector association');
        this.db.prepare('INSERT INTO model_refs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(epoch,cursor,sha) DO UPDATE SET chunk=excluded.chunk')
          .run(e.epoch, e.cursor, e.sha256, r.collectorEpoch, r.collectorSeq, r.collectorSHA256, e.at, key);
      }
      for (const lead of leads) {
        const id = witnessSHA(witnessJSON([page.epoch, lead.kind, lead.seq, lead.evidenceSHA256 ?? lead.rowSHA256]));
        this.db.prepare('INSERT OR IGNORE INTO incidents VALUES (?,?)').run(id, JSON.stringify({ ...lead, epoch: page.epoch }));
        this.db.prepare('INSERT OR IGNORE INTO incident_chunks VALUES (?,?)').run(id, key);
      }
      // A transient failed capture can be followed by a good poll before the
      // watcher reads the head. Its actual frame must still reach review.
      // Group consecutive failures of one kind; retain every affected page.
      let run = this.get('capture-run');
      for (const { frame, input } of verified.frames) {
        const reason = frame.status === 'unavailable' ? 'frame-unavailable'
          : input.pollResult === 'failed' ? 'poll-failed'
          : input.sourceWriteEvidence !== 'recorded' ? 'source-writes-unavailable' : null;
        if (!reason) { run = null; continue; }
        if (!run || run.epoch !== page.epoch || run.reason !== reason || ![frame.seq,frame.seq-1].includes(run.lastSeq)) {
          const id = witnessSHA(witnessJSON([page.epoch, 'collector-capture-unavailable', frame.seq, frame.sha256, reason]));
          const incident = { kind: 'collector-capture-unavailable', at: frame.at, epoch: page.epoch, seq: frame.seq,
            reason, frameSHA256: frame.sha256, scope: 'Captured poll provenance is incomplete; no row eligibility or service verdict.' };
          this.db.prepare('INSERT OR IGNORE INTO incidents VALUES (?,?)').run(id, JSON.stringify(incident));
          run = { id, epoch: page.epoch, reason, lastSeq: frame.seq };
        }
        run.lastSeq = frame.seq;
        this.db.prepare('INSERT OR IGNORE INTO incident_chunks VALUES (?,?)').run(run.id, key);
      }
      this.put('capture-run', run);
      // Keep available causal context, including later pages within five
      // minutes of a lead. Delivery/processing never silently releases pins.
      this.db.exec(`INSERT OR IGNORE INTO incident_chunks SELECT i.id,c.key FROM incidents i JOIN chunks c
        ON c.start_at<=json_extract(i.json,'$.at')+300000 AND c.end_at>=json_extract(i.json,'$.at')-1800000`);
      if (!revisit) this.put('anchor-progress', progress.context);
      this.put('activeChunk', key); this.put('checkpoint', cp); this.refreshProtections();
    });
    return { key, duplicate: false, checkpoint: cp, leads };
  }
  updateReports(reports, { complete = reports.length < 200, now = Date.now() } = {}) {
    let normalized;
    try {
      if (!complete || !Array.isArray(reports) || reports.length >= 200) throw Error('Incomplete report queue');
      normalized = reports.filter(r => r.status === 'open').map(r => {
        const at = Date.parse(r.createdAt);
        if (!Number.isSafeInteger(r.id) || r.id < 1 || !Number.isFinite(at)) throw Error('Invalid report identity/time');
        const context = typeof r.context === 'string' ? JSON.parse(r.context || '{}') : r.context ?? {};
        return { id: r.id, at, refs: evaluationRefs(context) };
      });
      if (Buffer.byteLength(JSON.stringify(normalized)) > MiB) throw Error('Report reference index exceeds bound');
    } catch { this.put('reportsUncertain', true); return { uncertain: true }; }
    this.transaction(() => {
      this.put('reports', normalized); this.put('reportsAt', now); this.put('reportsUncertain', false); this.refreshProtections();
    });
    return { uncertain: false, ...this.get('reportProtection') };
  }
  refreshProtections() {
    if (this.get('reportsUncertain', true)) return;
    const findings = []; this.db.exec('DELETE FROM report_chunks');
    for (const r of this.get('reports', [])) {
      const matched = r.refs.flatMap(e => { const row = this.db.prepare('SELECT chunk,at FROM model_refs WHERE epoch=? AND cursor=? AND sha=?').get(e.epoch, e.cursor, e.sha256); return row ? [row] : []; });
      const times = matched.length ? matched.map(x => x.at) : r.refs.length ? r.refs.map(x => x.at) : [r.at];
      for (const at of times) this.db.prepare('INSERT OR IGNORE INTO report_chunks SELECT ?,key FROM chunks WHERE start_at<=? AND end_at>=?').run(r.id, at + 300000, at - 1800000);
      for (const m of matched) this.db.prepare('INSERT OR IGNORE INTO report_chunks VALUES (?,?)').run(r.id, m.chunk);
      findings.push({ reportId: r.id, protection: matched.length ? 'model-reference-and-time-window' : 'time-window-only', availableChunks: this.db.prepare('SELECT count(*) n FROM report_chunks WHERE report=?').get(r.id).n });
    }
    this.put('reportProtection', { findings });
  }
  maintain({ now = Date.now(), reserveBytes = 0, keepChunks = new Set() } = {}) {
    const uncertain = this.disk().unknown || this.get('reportsUncertain', true) || now - this.get('reportsAt', 0) > 300000;
    let deleted = 0;
    if (!uncertain) for (const c of this.db.prepare(`SELECT key,epoch,first,last,end_at FROM chunks WHERE key<>?
      AND key NOT IN (SELECT chunk FROM report_chunks) AND key NOT IN (SELECT chunk FROM incident_chunks) ORDER BY end_at,key`).all(this.get('activeChunk', ''))) {
      if (keepChunks.has(c.key)) continue;
      if (now - c.end_at <= this.policy.maxAgeMs && this.usedBytes() + reserveBytes <= this.databaseLimit) continue;
      this.transaction(() => {
        this.db.prepare('DELETE FROM chunks WHERE key=?').run(c.key);
        // Only this chunk's frames can have become orphaned. Searching their
        // primary-key range avoids rescanning every retained frame for each
        // expired page; overlapping late-association chunks still retain them.
        this.db.prepare(`DELETE FROM frames WHERE epoch=? AND seq BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM chunk_frames c WHERE c.epoch=frames.epoch AND c.seq=frames.seq)`)
          .run(c.epoch, c.first, c.last);
        this.db.exec('DELETE FROM topologies WHERE sha NOT IN (SELECT topology FROM chunk_topologies)');
      }); deleted++;
    }
    return { at: new Date(now).toISOString(), ...this.disk(), databaseBytes: this.usedBytes(), databaseLimitBytes: this.databaseLimit,
      maxBytes: this.policy.maxBytes, maxAgeMs: this.policy.maxAgeMs, deleted, cleanupUncertain: uncertain,
      heldByProtectedEvidence: this.usedBytes() + reserveBytes > this.databaseLimit,
      chunks: this.db.prepare('SELECT count(*) n FROM chunks').get().n, incidents: this.db.prepare('SELECT count(*) n FROM incidents').get().n,
      reportProtection: this.get('reportProtection', { findings: [] }).findings };
  }
}
