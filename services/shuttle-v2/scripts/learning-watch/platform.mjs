import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const WINDOW_SECONDS = 300;
export const THROTTLE_SECONDS = 20;
const MAX_RESPONSE = 32 * 1024;
const MAX_SNAPSHOT = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

export function validatePolicy(value) {
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean'
    || typeof value.org !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.org)
    || value.app !== 'yale-shuttle') throw Error('Invalid platform monitoring policy');
  return { version: 1, enabled: value.enabled, org: value.org, app: value.app };
}

export function authorizationFor(token) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 32768 || /[\r\n]/.test(token)) throw Error('Invalid platform credential');
  if (token.startsWith('FlyV1 ')) return token;
  if (/^fm[12]_/.test(token)) return 'FlyV1 ' + token;
  return 'Bearer ' + token;
}

async function getToken() {
  const { stdout } = await exec(process.env.FLYCTL ?? '/opt/homebrew/bin/flyctl', ['auth', 'token', '-q'], { timeout: 10000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

async function boundedJSON(response) {
  if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw Error('Platform metrics request failed');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing platform metrics body');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE) throw Error('Platform metrics response exceeds bound');
      chunks.push(Buffer.from(next.value));
    }
  // Cancellation can wait for another consumer of a tee'd stream. Cleanup
  // must not hold the monitor after it has already rejected an oversized body.
  } catch (e) { void reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return { raw, data: JSON.parse(raw) };
}

function vector(data, now) {
  if (data?.status !== 'success' || data.data?.resultType !== 'vector'
    || !Array.isArray(data.data.result) || data.data.result.length < 1 || data.data.result.length > 16) throw Error('Invalid platform metric vector');
  const result = new Map();
  for (const row of data.data.result) {
    const m = row.metric, value = row.value;
    if (m?.app !== 'yale-shuttle' || !/^[a-z0-9-]{1,64}$/.test(m.instance ?? '')
      || !/^[a-z0-9-]{1,64}$/.test(m.host ?? '') || !/^[a-z0-9-]{1,16}$/.test(m.region ?? '')
      || !Array.isArray(value) || value.length !== 2 || !Number.isFinite(value[0])
      || Math.abs(value[0] * 1000 - now) > 5000 || typeof value[1] !== 'string'
      || !value[1].trim() || !Number.isFinite(Number(value[1])) || Number(value[1]) < 0) throw Error('Invalid platform metric sample');
    const key = [m.instance, m.host, m.region].join(':');
    if (result.has(key)) throw Error('Duplicate platform metric identity');
    result.set(key, { instance: m.instance, host: m.host, region: m.region, value: Number(value[1]) });
  }
  return result;
}

export function inspectPlatform(responses, now) {
  const delta = vector(responses.throttled, now), source = vector(responses.sourceTime, now), support = vector(responses.support, now);
  const keys = [...delta.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify([...source.keys()].sort())
    || JSON.stringify(keys) !== JSON.stringify([...support.keys()].sort())) throw Error('Platform metric identities differ');
  const freshInstances = new Set([...source.values()].filter(r => now - r.value * 1000 >= -5000 && now - r.value * 1000 <= 90000).map(r => r.instance));
  const instances = [], superseded = [];
  for (const key of keys) {
    const s = source.get(key), count = support.get(key).value;
    if (s.value * 1000 > now + 5000) throw Error('Platform source clock is in the future');
    if (now - s.value * 1000 > 90000) {
      if (freshInstances.has(s.instance)) { superseded.push({ instance: s.instance, host: s.host, sourceAt: s.value * 1000 }); continue; }
      throw Error('Platform metric source is stale');
    }
    if (!Number.isInteger(count) || count < 2) throw Error('Insufficient platform counter observations');
    const d = delta.get(key);
    instances.push({ instance: d.instance, host: d.host, region: d.region, sourceAt: s.value * 1000, counterSamples: count,
      throttledSeconds: d.value, flagged: d.value >= THROTTLE_SECONDS });
  }
  if (!instances.length) throw Error('No fresh platform metric source');
  return { state: instances.some(r => r.flagged) ? 'throttled' : 'healthy', instances, superseded };
}

/** Current read-only platform observations, independent of a blocked app loop.
 * Missing/stale metrics remain unknown; they never become zero throttling. */
export async function collectPlatform(value, { now = Date.now(), fetcher = fetch, tokenProvider = getToken } = {}) {
  if (value == null) return { configured: false, enabled: false, state: 'disabled' };
  let policy;
  try { policy = validatePolicy(value); }
  catch { return { configured: true, enabled: true, state: 'unknown', error: 'Invalid platform monitoring policy' }; }
  if (!policy.enabled) return { configured: true, enabled: false, state: 'disabled', policy };
  try {
    const token = await tokenProvider(), authorization = authorizationFor(token), filter = '{app="yale-shuttle"}';
    const queries = { throttled: `increase(fly_instance_cpu_throttle${filter}[${WINDOW_SECONDS}s])/100`,
      sourceTime: `timestamp(fly_instance_cpu_throttle${filter})`, support: `count_over_time(fly_instance_cpu_throttle${filter}[${WINDOW_SECONDS}s])` };
    const captures = await Promise.all(Object.entries(queries).map(async ([name, query]) => {
      const url = new URL('https://api.fly.io/prometheus/' + policy.org + '/api/v1/query');
      url.search = new URLSearchParams({ query, time: String(now / 1000) });
      const response = await fetcher(url, { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      const { raw, data } = await boundedJSON(response);
      if (raw.includes(token.replace(/^FlyV1 /, ''))) throw Error('Platform response contains credential bytes');
      return { name, query, raw, sha256: hash(raw), data };
    }));
    const inspected = inspectPlatform(Object.fromEntries(captures.map(r => [r.name, r.data])), now);
    const snapshot = { version: 1, queriedAt: now, receivedAt: Date.now(), policy, windowSeconds: WINDOW_SECONDS,
      thresholdSeconds: THROTTLE_SECONDS, responses: captures.map(({ data, ...r }) => r) };
    const bytes = JSON.stringify(snapshot);
    if (Buffer.byteLength(bytes) > MAX_SNAPSHOT) throw Error('Platform snapshot exceeds bound');
    return { configured: true, enabled: true, policy, ...inspected, snapshot, snapshotSha256: hash(bytes) };
  } catch {
    return { configured: true, enabled: true, policy, state: 'unknown', error: 'Platform quota metrics are unavailable, invalid or stale; retained episodes are preserved' };
  }
}
