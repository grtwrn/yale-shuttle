import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorFetch, monitorNetworkSummary } from '../monitor-fetch.mjs';

const HEALTH = 'https://yale-shuttle.fly.dev/healthz';
const MAX_BYTES = 16 * 1024;

/** Private DNS recovery for the Python guardian's fixed production health GET.
 * TLS, original hostname and DNS retry policy are owned by monitorFetch. */
export async function readHealth({ fetcher = monitorFetch, networkSummary = monitorNetworkSummary,
  signal = AbortSignal.timeout(10_000) } = {}) {
  signal.throwIfAborted();
  const response = await fetcher(HEALTH, { redirect: 'error', signal });
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    await response.body?.cancel();
    throw Error('Invalid health response');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw Error('Health response exceeds byte limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean')
    throw Error('Invalid health JSON');
  const health = { ok: body.ok };
  for (const key of ['pollStalenessMs', 'collectorLagMs', 'knownBuses'])
    health[key] = Number.isFinite(body[key]) && body[key] >= 0 ? body[key] : null;
  health.build = typeof body.build === 'string' && /^[a-f0-9]{7,40}$/.test(body.build) ? body.build : null;
  return { httpStatus: response.status, health, transport: networkSummary() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await readHealth()) + '\n'); }
  catch {
    process.stdout.write(JSON.stringify({ error: 'health_recovery_unavailable' }) + '\n');
    process.exitCode = 1;
  }
}
