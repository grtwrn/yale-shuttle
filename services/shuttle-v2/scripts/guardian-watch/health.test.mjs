import { describe, expect, test, vi } from 'vitest';
import { readHealth } from './health.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const summary = { scope: 'Since this process started', dnsFallbackAttempts: 1,
  dnsFallbackResponses: 1, dnsFallbackFailures: 0 };
const read = (response, extra = {}) => readHealth({ fetcher: async () => response,
  networkSummary: () => summary, ...extra });

describe('guardian DNS health response', () => {
  test('uses the fixed health URL and returns bounded diagnostic fields', async () => {
    const fetcher = vi.fn(async () => json({ ok: true, build: '80b252cb4b22',
      knownBuses: 19, pollStalenessMs: 100, collectorLagMs: 200, private: 'omit' }));
    const result = await readHealth({ fetcher, networkSummary: () => summary });
    expect(fetcher.mock.calls[0][0]).toBe('https://yale-shuttle.fly.dev/healthz');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ httpStatus: 200, health: { ok: true, build: '80b252cb4b22',
      knownBuses: 19, pollStalenessMs: 100, collectorLagMs: 200 }, transport: summary });
  });

  test('keeps a failed HTTP status even if its body says ok', async () => {
    expect(await read(json({ ok: true }, 503))).toMatchObject({ httpStatus: 503, health: { ok: true } });
    expect(await read(json({ ok: false }))).toMatchObject({ httpStatus: 200, health: { ok: false } });
  });

  test('rejects missing or nonboolean health truth and malformed JSON', async () => {
    for (const body of [null, [], {}, { ok: 'true' }, { ok: 1 }])
      await expect(read(json(body))).rejects.toThrow('Invalid health JSON');
    await expect(read(new Response('{', { headers: { 'content-type': 'application/json' } })))
      .rejects.toThrow();
  });

  test('rejects non-JSON content and empty responses', async () => {
    await expect(read(new Response('ok'))).rejects.toThrow('Invalid health response');
    await expect(read(new Response(null, { status: 204, headers: { 'content-type': 'application/json' } })))
      .rejects.toThrow('Invalid health response');
  });

  test('cancels an oversized streaming body before it can be accepted', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(17 * 1024)); },
      cancel() { cancelled = true; },
    });
    await expect(read(new Response(stream, { headers: { 'content-type': 'application/json' } })))
      .rejects.toThrow('Health response exceeds byte limit');
    expect(cancelled).toBe(true);
  });

  test('does not accept a body whose stream fails', async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(Error('broken body')); } });
    await expect(read(new Response(stream, { headers: { 'content-type': 'application/json' } })))
      .rejects.toThrow('broken body');
  });

  test('retains transport failures and honors cancellation before requesting', async () => {
    const fetcher = vi.fn(async () => { throw Error('untrusted TLS'); });
    await expect(readHealth({ fetcher })).rejects.toThrow('untrusted TLS');
    const abort = new AbortController(); abort.abort(Error('stop'));
    fetcher.mockClear();
    await expect(readHealth({ fetcher, signal: abort.signal })).rejects.toThrow('stop');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('limits unexpected diagnostic values without making health truth true', async () => {
    expect(await read(json({ ok: false, build: 'x'.repeat(5000), knownBuses: '19',
      pollStalenessMs: -1, collectorLagMs: null }))).toMatchObject({ health: {
      ok: false, build: null, knownBuses: null, pollStalenessMs: null, collectorLagMs: null,
    } });
  });
});
