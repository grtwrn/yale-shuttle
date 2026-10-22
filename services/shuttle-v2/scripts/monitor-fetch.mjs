import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const HOST = 'yale-shuttle.fly.dev';
const ORIGIN = `https://${HOST}`;
const resolver = new Resolver({ timeout: 1500, tries: 1 });
resolver.setServers(['1.1.1.1', '1.0.0.1']);

function hostnameFailure(error, depth = 0) {
  if (!error || depth > 5) return false;
  if (error.hostname === HOST && ['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL'].includes(error.code)
    && ['getaddrinfo', 'queryA', 'queryAaaa'].includes(error.syscall)) return true;
  return hostnameFailure(error.cause, depth + 1)
    || Array.isArray(error.errors) && error.errors.slice(0, 16).some(e => hostnameFailure(e, depth + 1));
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Only a failed DNS lookup for our fixed production GET origin is retried.
 * Requests still use the original hostname, SNI and certificate verification.
 * No OS/VPN settings change, HTTP-error retry or redirect following occurs. */
export function createMonitorFetch({
  fetcher = (input, init) => globalThis.fetch(input, init),
  resolve4 = hostname => resolver.resolve4(hostname, { ttl: true }),
  request = https.get,
  now = Date.now,
  onFallback = info => console.warn(JSON.stringify({ event: 'monitor-dns-fallback', ...info })),
} = {}) {
  let cached = null, pending = null;
  const counts = { dnsFallbackAttempts: 0, dnsFallbackResponses: 0, dnsFallbackFailures: 0 };
  const increment = key => { counts[key] = Math.min(1_000_000, counts[key] + 1); };
  const address = () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.ip);
    if (!pending) {
      const task = Promise.resolve().then(() => resolve4(HOST)).then(rows => {
        const row = rows.find(r => isIP(r?.address) === 4 && Number.isFinite(r.ttl) && r.ttl >= 0);
        if (!row) throw Error('No fallback IPv4 DNS answer');
        cached = { ip: row.address, until: now() + Math.min(row.ttl, 60) * 1000 };
        return row.address;
      });
      pending = task;
      const clear = () => { if (pending === task) pending = null; };
      task.then(clear, clear);
    }
    return pending;
  };

  async function monitorFetch(input, init = {}) {
    try { return await fetcher(input, init); }
    catch (error) {
      // Callers use URL/string GETs. Other Request semantics stay with fetch.
      if (!(typeof input === 'string' || input instanceof URL)) throw error;
      const url = new URL(input);
      if (url.origin !== ORIGIN || url.username || url.password
        || String(init.method ?? 'GET').toUpperCase() !== 'GET' || !hostnameFailure(error)) throw error;
      const signal = init.signal ?? AbortSignal.timeout(20_000);
      signal.throwIfAborted();
      increment('dnsFallbackAttempts');
      try {
        const ip = await abortable(address(), signal);
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.set('host', HOST);
        headers.set('accept-encoding', 'identity');
        const response = await new Promise((resolve, reject) => {
          let incoming;
          const req = request({ protocol: 'https:', hostname: HOST, servername: HOST,
            port: 443, path: url.pathname + url.search, method: 'GET', family: 4,
            rejectUnauthorized: true, agent: false, headers: Object.fromEntries(headers), signal,
            lookup: (hostname, _options, callback) => hostname === HOST
              ? callback(null, ip, 4) : callback(Error('Unexpected monitor hostname')),
          }, res => {
            incoming = res;
            try {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(res.headers)) if (value !== undefined)
                responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
              let body = res;
              const encoding = (responseHeaders.get('content-encoding') ?? '').toLowerCase().trim();
              const decode = encoding === 'gzip' ? createGunzip : encoding === 'deflate' ? createInflate
                : encoding === 'br' ? createBrotliDecompress : null;
              if (decode) {
                body = res.pipe(decode());
                res.once('error', error => body.destroy(error));
                body.once('close', () => res.destroy());
              } else if (encoding && encoding !== 'identity') throw Error('Unsupported monitor response encoding');
              const empty = [204, 205, 304].includes(res.statusCode);
              const value = new Response(empty ? null : Readable.toWeb(body), {
                status: res.statusCode, statusText: res.statusMessage, headers: responseHeaders,
              });
              if (empty) res.resume();
              resolve(value);
            } catch (error) { res.destroy(); reject(error); }
          });
          req.once('error', error => { incoming?.destroy(error); reject(error); });
        });
        increment('dnsFallbackResponses');
        // These are transport diagnostics only. The caller still validates the
        // status, complete bounded JSON, source identity and evidence chain.
        try { onFallback({ hostname: HOST, httpStatus: response.status }); } catch { /* logging cannot break capture */ }
        return response;
      } catch (fallbackError) {
        increment('dnsFallbackFailures');
        if (signal.aborted) throw signal.reason;
        throw new Error('Monitor DNS recovery failed', { cause: fallbackError });
      }
    }
  }
  monitorFetch.networkSummary = () => ({ scope: 'Since this process started', ...counts });
  return monitorFetch;
}

export const monitorFetch = createMonitorFetch();
export const monitorNetworkSummary = () => monitorFetch.networkSummary();
