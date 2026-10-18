#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { witnessSHA } from '../../src/collector/witnessCodec.ts';
import { atomicJson, withStorageLock } from '../retention/storage.mjs';
import { rotateOutput } from '../retention/maintain.mjs';
import { WitnessStore, StorageHold } from './storage.mjs';
import { validHead, initialChain } from './protocol.mjs';
import { dispatchIncidents } from './incidents.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MiB = 1024 * 1024;

/** Only the configured app receives credentials. Redirects, oversized bodies,
 * HTML fallbacks and unbounded error text never enter the evidence store. */
export async function getJSON(url, token, fetcher = fetch, maxBytes = 20 * MiB) {
  const response = await fetcher(url, { headers: { 'x-admin-token': token }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Witness endpoint HTTP ${response.status}`);
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length') ?? 0) > maxBytes) throw Error('Invalid witness response type/size');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing witness response');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw Error('Witness response exceeded byte bound');
      chunks.push(Buffer.from(next.value));
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
  return { value: JSON.parse(raw), transport: { receivedAt: Date.now(), httpBodySHA256: witnessSHA(body), httpBytes: bytes } };
}

/** Read-only production requests. No fitting, source-row edits, publication,
 * report replies or service-status inference. Gaps are explicit boundaries. */
export async function pollWitnesses({ store, base = 'https://yale-shuttle.fly.dev', token, fetcher = fetch, now = Date.now(), maxPages = 8 } = {}) {
  const origin = new URL(base);
  if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))) throw Error('Invalid witness app origin');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 16 || typeof token !== 'string' || !token) throw Error('Invalid witness poll configuration');
  const endpoint = '/api/evaluation/collector-witnesses';
  let reportsOK = !store.get('reportsUncertain', true), reportError = null;
  if (now - store.get('reportsAt', 0) >= 60000 || !reportsOK) {
    try {
      const { value } = await getJSON(new URL('/api/reports?status=open&limit=200', origin), token, fetcher, 2 * MiB);
      if (!Array.isArray(value?.reports)) throw Error('Invalid report queue');
      reportsOK = !store.updateReports(value.reports, { complete: value.reports.length < 200, now }).uncertain;
    } catch { store.updateReports([], { complete: false, now }); reportsOK = false; reportError = 'Report protection refresh failed; prior evidence pins preserved'; }
  }
  const { value: head } = await getJSON(new URL(endpoint, origin), token, fetcher, 128 * 1024);
  if (!validHead(head)) throw Error('Malformed collector witness head');
  if (head.latest === 0 && head.chain !== initialChain(head.epoch)) throw Error('Collector genesis differs');
  let cp = store.checkpoint(), boundary = null;
  if (!cp || cp.epoch !== head.epoch || cp.build !== head.build || cp.after < head.oldest - 1) {
    boundary = !cp ? 'initial-capture' : cp.epoch !== head.epoch || cp.build !== head.build ? 'producer-context-changed' : 'source-prefix-expired';
    cp = store.beginEpoch(head, boundary, now);
  }
  if (cp.after > head.latest) throw Error('Collector witness sequence regressed');
  let pages = 0, frames = 0, leads = 0;
  const changedModel = cp.evaluationEpoch !== head.evaluationEpoch || cp.evaluationCursor !== head.evaluationCursor;
  const revisit = cp.after === head.latest && !!cp.lastFrame && changedModel;
  while (pages < maxPages && (cp.after < head.latest || revisit && pages === 0)) {
    const url = new URL(endpoint, origin), known = [...store.knownTopologies().keys()];
    url.searchParams.set('epoch', cp.epoch); url.searchParams.set('after', String(revisit ? cp.after - 1 : cp.after));
    url.searchParams.set('limit', revisit ? '1' : '16');
    if (known.length) url.searchParams.set('knownTopologies', known.join(','));
    const { value: page, transport } = await getJSON(url, token, fetcher);
    const committedHead = page.frames?.find(frame => frame.seq === head.latest);
    if (committedHead && committedHead.chain !== head.chain) throw Error('Collector head commitment differs');
    const committed = store.commitPage(page, { transport, seenHead: head, revisit, now });
    cp = committed.checkpoint; pages++;
    if (!revisit && !committed.duplicate) frames += page.frames.length;
    leads += committed.leads.length;
    if (!page.hasMore || revisit) break;
  }
  if (cp.after === 0 && head.latest === 0) store.acknowledgeHead(head);
  const retention = store.maintain({ now });
  // Empty successful polls also produce witnesses. A fresh HTTP head alone
  // cannot hide a stalled collector or upstream failure before capture begins.
  const lastSourceAt = cp.at >= 0 ? cp.at : cp.beganAt ?? 0;
  const sourceStale = now - lastSourceAt > 120000 || lastSourceAt - now > 5000;
  const sourceCaptureUnavailable = store.get('capture-run') !== null;
  return { checkedAt: new Date(now).toISOString(), ok: reportsOK && head.unavailable === null && !sourceStale && !sourceCaptureUnavailable && !retention.cleanupUncertain,
    epoch: cp.epoch, build: cp.build, cursor: cp.after, latest: head.latest, pages, frames, leads, boundary,
    sourceUnavailable: head.unavailable !== null, sourceStale, sourceCaptureUnavailable, lastSourceAt, reportsOK, reportError, retention,
    scope: 'Diagnostic input capture only. Empty service and captured data are not ETA accuracy or physical arrival proof.' };
}

export async function runOnce({ dir = process.env.COLLECTOR_WITNESS_DIR ?? path.join(service, 'scripts/.bot-artifacts/collector-witness-watch'),
  base = process.env.COLLECTOR_WITNESS_BASE_URL ?? 'https://yale-shuttle.fly.dev',
  tokenFile = process.env.SHUTTLE_ADMIN_TOKEN_FILE ?? path.join(os.homedir(), '.config/yale-shuttle/admin-token'),
  incidents = process.env.COLLECTOR_WITNESS_INCIDENTS ?? path.join(os.homedir(), 'projects/yale-shuttle-guardian-bot/state/pending'),
  fetcher = fetch, now = Date.now() } = {}) {
  return withStorageLock(dir, async () => {
    let store, result;
    try {
      await rotateOutput(path.join(dir, 'watcher.log'), { maxBytes: MiB, maxBackups: 1 });
      const token = (await fs.readFile(tokenFile, 'utf8')).trim();
      store = new WitnessStore(dir);
      result = await pollWitnesses({ store, base, token, fetcher, now });
    } catch (error) {
      // Fixed text: network exception messages can contain URLs or headers.
      let cursor = null;
      try { cursor = store?.checkpoint()?.after ?? null; } catch {}
      result = { checkedAt: new Date(now).toISOString(), ok: false, cursor,
        errorCode: error instanceof StorageHold ? 'storage_held' : 'capture_rejected',
        error: error instanceof StorageHold ? error.message : 'Collector evidence check failed. Previously committed evidence and cursor were preserved.' };
    }
    try {
      if (store) {
        try {
          result.incidentDelivery = await dispatchIncidents({ store, directory: incidents, now });
          if (!result.incidentDelivery.ok) { result.ok = false; result.incidentError = 'Collector incident delivery failed; retained incidents will retry.'; }
        } catch { result.ok = false; result.incidentError = 'Collector incident delivery could not be checked; retained incidents are preserved.'; }
      }
      if (result.retention) await atomicJson(path.join(dir, 'retention.json'), result.retention);
      await atomicJson(path.join(dir, 'status.json'), result);
      return result;
    } finally { store?.close(); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runOnce();
  process.exitCode = result.ok ? 0 : 1;
}
