import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createMonitorFetch } from './monitor-fetch.mjs';
import { getJSON, pollWitnesses } from './collector-witness-watch/poll.mjs';
import { WitnessStore } from './collector-witness-watch/storage.mjs';
import { fixture } from './collector-witness-watch/testFixtures.mjs';

const HOST = 'yale-shuttle.fly.dev', URL = `https://${HOST}/api/buses`;
const dnsError = (hostname = HOST, code = 'ENOTFOUND') => new TypeError('fetch failed', {
  cause: Object.assign(Error('DNS unavailable'), { code, hostname, syscall: 'getaddrinfo' }),
});
const dnsFailedFetch = async () => { throw dnsError(); };
const answer = [{ address: '66.241.124.151', ttl: 60 }];
const servers = [], stores = [], directories = [];
let certificateDirectory, correct, wrong;
beforeAll(() => {
  certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-tls-test-'));
  function certificate(name) {
    const config = path.join(certificateDirectory, name + '.cnf');
    const key = path.join(certificateDirectory, name + '.key'), cert = path.join(certificateDirectory, name + '.pem');
    fs.writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${name}\n[ext]\nsubjectAltName=DNS:${name}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', config, '-keyout', key, '-out', cert], { stdio: 'pipe' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  }
  correct = certificate(HOST); wrong = certificate('wrong.example');
});
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(certificateDirectory, { recursive: true, force: true }));

async function localTLS(handler, { material = correct, trust = true } = {}) {
  const server = https.createServer(material, handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const requests = [];
  const request = (options, callback) => {
    requests.push(options);
    // Only the test's socket address and trust anchor change. The real client
    // still checks the production hostname, SNI and rejectUnauthorized option.
    return https.get({ ...options, port: server.address().port,
      ...(trust ? { ca: material.cert } : {}),
      lookup: (_hostname, _options, done) => done(null, '127.0.0.1', 4),
    }, callback);
  };
  return { server, request, requests };
}
const json = (response, value) => {
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
};

describe('operational monitor DNS recovery', () => {
  it('keeps a normal fetch response and makes no fallback lookup', async () => {
    const response = Response.json({ ok: true }), resolve4 = vi.fn();
    const get = createMonitorFetch({ fetcher: async () => response, resolve4 });
    expect(await get(URL)).toBe(response); expect(resolve4).not.toHaveBeenCalled();
    expect(get.networkSummary().dnsFallbackAttempts).toBe(0);
  });

  it('recovers the exact JSON body with real TLS, original Host/SNI and scoped credentials', async () => {
    const body = Buffer.from('{"label":"Café","ok":true}'), received = [], logs = [];
    const tls = await localTLS((request, response) => {
      received.push({ host: request.headers.host, token: request.headers['x-admin-token'], sni: request.socket.servername });
      response.setHeader('content-type', 'application/json'); response.end(body);
    });
    const resolve4 = vi.fn(async () => answer);
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4, request: tls.request, onFallback: info => logs.push(info) });
    const response = await get(URL, { headers: { 'x-admin-token': 'private-test-token' }, signal: AbortSignal.timeout(3000) });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(received).toEqual([{ host: HOST, token: 'private-test-token', sni: HOST }]);
    expect(resolve4).toHaveBeenCalledWith(HOST);
    expect(tls.requests[0]).toMatchObject({ hostname: HOST, servername: HOST, port: 443, rejectUnauthorized: true, agent: false });
    expect(JSON.stringify(logs)).not.toContain('private-test-token');
    expect(get.networkSummary()).toMatchObject({ dnsFallbackAttempts: 1, dnsFallbackResponses: 1, dnsFallbackFailures: 0 });
  });

  it.each([['untrusted certificate', false, false], ['wrong certificate hostname', true, true]])(
    'rejects %s even when DNS supplies an address', async (_name, useWrong, trust) => {
      const tls = await localTLS((_request, response) => json(response, { ok: true }), { material: useWrong ? wrong : correct, trust });
      const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
      let failure; try { await get(URL); } catch (error) { failure = error; }
      expect(failure?.message).toBe('Monitor DNS recovery failed');
      expect(failure?.cause?.code).toBe(useWrong ? 'ERR_TLS_CERT_ALTNAME_INVALID' : 'DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(get.networkSummary()).toMatchObject({ dnsFallbackResponses: 0, dnsFallbackFailures: 1 });
    });

  it.each(['gzip', 'deflate', 'br'])('preserves fetch decoding semantics for %s', async encoding => {
    const body = Buffer.from('{"complete":"bounded source bytes"}');
    const encode = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding];
    const tls = await localTLS((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.setHeader('content-encoding', encoding); response.end(encode(body));
    });
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
    expect(Buffer.from(await (await get(URL)).arrayBuffer())).toEqual(body);
  });

  it('does not follow a redirect or send credentials to the redirect destination', async () => {
    let requests = 0;
    const tls = await localTLS((_request, response) => { requests++; response.writeHead(302, { location: 'https://other.example/private' }); response.end(); });
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
    await expect(getJSON(URL, 'private-test-token', get)).rejects.toThrow('HTTP 302');
    expect(requests).toBe(1); expect(tls.requests).toHaveLength(1);
  });

  it.each([['HTTP error', new Response('unavailable', { status: 503 })], ['successful empty response', new Response(null, { status: 204 })]])(
    'does not retry a primary %s', async (_name, response) => {
      const resolve4 = vi.fn(), request = vi.fn();
      const get = createMonitorFetch({ fetcher: async () => response, resolve4, request });
      expect(await get(URL)).toBe(response); expect(resolve4).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });

  it.each([
    ['another origin', 'https://other.example/api/reports', {}],
    ['HTTP', `http://${HOST}/api/reports`, {}],
    ['another port', `https://${HOST}:8443/api/reports`, {}],
    ['URL credentials', `https://user:secret@${HOST}/api/reports`, {}],
    ['a write', URL, { method: 'POST' }],
  ])('does not recover %s through the production fallback', async (_name, url, init) => {
    const error = dnsError(), resolve4 = vi.fn(), request = vi.fn();
    const get = createMonitorFetch({ fetcher: async () => { throw error; }, resolve4, request });
    await expect(get(url, init)).rejects.toBe(error); expect(resolve4).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['another DNS hostname', dnsError('other.example')],
    ['a socket failure', Object.assign(Error('socket'), { code: 'ECONNRESET' })],
    ['an HTTP timeout', Object.assign(Error('timeout'), { code: 'ETIMEDOUT' })],
  ])('leaves %s as a failed check', async (_name, error) => {
    const resolve4 = vi.fn();
    const get = createMonitorFetch({ fetcher: async () => { throw error; }, resolve4 });
    await expect(get(URL)).rejects.toBe(error); expect(resolve4).not.toHaveBeenCalled();
  });

  it('honors cancellation while a fallback DNS answer is pending', async () => {
    const controller = new AbortController(), request = vi.fn();
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const get = createMonitorFetch({ fetcher: dnsFailedFetch,
      resolve4: () => { began(); return new Promise(() => {}); }, request });
    const result = get(URL, { signal: controller.signal });
    await started;
    const reason = Error('operator deadline'); controller.abort(reason);
    await expect(result).rejects.toBe(reason); expect(request).not.toHaveBeenCalled();
  });

  it('aborts a body that stops arriving after HTTPS response headers', async () => {
    const tls = await localTLS((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.write('{"unfinished":');
    });
    const controller = new AbortController();
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
    const response = await get(URL, { signal: controller.signal });
    const reading = response.json(); controller.abort();
    await expect(reading).rejects.toThrow();
  });

  it('can retry a later poll after a fallback DNS failure', async () => {
    const tls = await localTLS((_request, response) => json(response, { ok: true }));
    const resolve4 = vi.fn().mockImplementationOnce(() => { throw Error('resolver unavailable'); }).mockResolvedValue(answer);
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4, request: tls.request, onFallback: () => {} });
    await expect(get(URL)).rejects.toThrow('Monitor DNS recovery failed');
    expect(await (await get(URL)).json()).toEqual({ ok: true }); expect(resolve4).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent lookups and expires the cache at the DNS TTL', async () => {
    let time = 1000;
    const tls = await localTLS((_request, response) => json(response, { ok: true }));
    const resolve4 = vi.fn(async () => [{ address: answer[0].address, ttl: 2 }]);
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4, request: tls.request, now: () => time, onFallback: () => {} });
    await Promise.all([get(URL).then(r => r.json()), get(URL).then(r => r.json())]);
    expect(resolve4).toHaveBeenCalledTimes(1);
    time = 3000; await (await get(URL)).json(); expect(resolve4).toHaveBeenCalledTimes(2);
  });

  it('caps a longer DNS TTL at sixty seconds', async () => {
    let time = 1000;
    const tls = await localTLS((_request, response) => json(response, { ok: true }));
    const resolve4 = vi.fn(async () => [{ address: answer[0].address, ttl: 3600 }]);
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4, request: tls.request, now: () => time, onFallback: () => {} });
    await (await get(URL)).json(); time = 61_000; await (await get(URL)).json();
    expect(resolve4).toHaveBeenCalledTimes(2);
  });

  it('retains the collector body-size and JSON checks after DNS recovery', async () => {
    const tls = await localTLS((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('x'.repeat(4096)); });
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
    await expect(getJSON(URL, 'private-test-token', get, 1024)).rejects.toThrow(/byte bound|type\/size/);
    await expect(getJSON(URL, 'private-test-token', get)).rejects.toThrow();
  });

  it('still rejects a corrupt source page and preserves the committed collector cursor', async () => {
    const f = fixture(); f.add(); let corrupt = false;
    const tls = await localTLS((request, response) => {
      const url = new globalThis.URL(request.url, `https://${HOST}`);
      if (url.pathname === '/api/reports') return json(response, { reports: [] });
      if (!url.search) return json(response, f.head());
      const page = f.page(Number(url.searchParams.get('after')), 16);
      if (corrupt && page.frames.length) page.frames[0] = { ...page.frames[0], json: 'corrupt' };
      json(response, page);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-source-test-')); directories.push(dir);
    const store = new WitnessStore(dir, { policy: { minFreeBytes: 0 } }); stores.push(store);
    const get = createMonitorFetch({ fetcher: dnsFailedFetch, resolve4: async () => answer, request: tls.request, onFallback: () => {} });
    const first = await pollWitnesses({ store, fetcher: get, token: 'private-test-token', now: f.at });
    expect(first).toMatchObject({ ok: true, cursor: 1, frames: 1 });
    const checkpoint = store.checkpoint(); f.add(); corrupt = true;
    await expect(pollWitnesses({ store, fetcher: get, token: 'private-test-token', now: f.at })).rejects.toThrow();
    expect(store.checkpoint()).toEqual(checkpoint);
  });
});
