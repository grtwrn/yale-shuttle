import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { authorizationFor, collectPlatform, inspectPlatform, validatePolicy } from './platform.mjs';
import { advance } from './poll.mjs';

const now = Date.parse('2026-10-20T22:34:11Z');
const policy = { version: 1, enabled: true, org: 'personal', app: 'yale-shuttle' };
const token = 'fm2_fixture_credential_not_a_real_token';
const metric = { app: 'yale-shuttle', instance: '91854406a779d8', host: '744d', region: 'ewr' };
const vector = (value, labels = metric) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: labels, value: [now / 1000, String(value)] }] } });
function packets(seconds = 50) {
  return { throttled: vector(seconds), sourceTime: vector((now - 15000) / 1000), support: vector(20) };
}
function transport(data = packets(), calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const query = new URL(url).searchParams.get('query');
    const name = query.startsWith('increase(') ? 'throttled' : query.startsWith('timestamp(') ? 'sourceTime' : 'support';
    return Response.json(data[name]);
  };
}

describe('retained quota observations', () => {
  it('keeps the recorded October 20 stall visible across the two recovered HTTP checks', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./__fixtures__/cpu-throttle-20261020.json', import.meta.url), 'utf8'));
    const original = JSON.stringify(fixture), states = [], alerts = []; let prior;
    for (const c of fixture.cases) {
      const result = inspectPlatform(Object.fromEntries(Object.entries(c.responses).map(([k, v]) => [k, v.data])), c.at);
      states.push(result.state);
      prior = advance(prior, 'platform:personal:yale-shuttle', result.state === 'throttled' ? [{ code: 'platform-cpu-throttle', summary: 'Recorded quota pressure' }] : [], c.at);
      alerts.push(prior.alerts.length);
    }
    expect(fixture.cases.map(c => c.originalMonitorHealthy)).toEqual([false, true, true]);
    expect(states).toEqual(['throttled', 'throttled', 'throttled']); expect(alerts).toEqual([0, 0, 1]);
    expect(JSON.stringify(fixture)).toBe(original);
  });
  it('detects a recent stall even while the current app may have recovered', async () => {
    const calls = [], r = await collectPlatform(policy, { now, tokenProvider: async () => token, fetcher: transport(packets(), calls) });
    expect(r.state).toBe('throttled');
    expect(r.instances).toEqual([{ ...Object.fromEntries(Object.entries(metric).filter(([k]) => k !== 'app')), sourceAt: now - 15000, counterSamples: 20, throttledSeconds: 50, flagged: true }]);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const url = new URL(c.url); expect(url.origin).toBe('https://api.fly.io'); expect(url.pathname).toBe('/prometheus/personal/api/v1/query');
      expect(url.searchParams.get('time')).toBe(String(now / 1000));
      expect(c.options.headers.Authorization).toBe('FlyV1 ' + token); expect(c.options.redirect).toBe('error');
    }
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.snapshotSha256).toBe(createHash('sha256').update(JSON.stringify(r.snapshot)).digest('hex'));
    for (const capture of r.snapshot.responses) expect(capture.sha256).toBe(createHash('sha256').update(capture.raw).digest('hex'));
  });
  it.each([[19.999, 'healthy'], [20, 'throttled'], [20.001, 'throttled'], [0, 'healthy']])('uses the observed recent counter increase %s', (seconds, state) => {
    expect(inspectPlatform(packets(seconds), now).state).toBe(state);
  });
  it.each(['throttled', 'sourceTime', 'support'])('keeps an explicitly partial %s response unknown', async name => {
    for (const seconds of [0, 50]) {
      const data = packets(seconds); data[name].isPartial = true;
      const r = await collectPlatform(policy, { now, tokenProvider: async () => token, fetcher: transport(data) });
      expect(r.state).toBe('unknown'); expect(r.snapshot).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(token);
    }
  });
  it.each([null, 'false', 0])('rejects the malformed completeness marker %s', async marker => {
    for (const name of ['throttled', 'sourceTime', 'support']) {
      const data = packets(0); data[name].isPartial = marker;
      const r = await collectPlatform(policy, { now, tokenProvider: async () => token, fetcher: transport(data) });
      expect(r.state).toBe('unknown'); expect(r.snapshot).toBeUndefined();
    }
  });
  it.each([undefined, false])('accepts a valid vector with completeness marker %s', async marker => {
    for (const seconds of [0, 50]) {
      const data = packets(seconds);
      for (const value of Object.values(data)) if (marker !== undefined) value.isPartial = marker;
      const r = await collectPlatform(policy, { now, tokenProvider: async () => token, fetcher: transport(data) });
      expect(r.state).toBe(seconds ? 'throttled' : 'healthy'); expect(r.snapshot).toBeDefined();
    }
  });
  it('keeps absent configuration disabled and rejects unsafe policy scope before authentication', async () => {
    let calls = 0; const tokenProvider = async () => { calls++; return token; };
    expect(await collectPlatform(null, { now, tokenProvider })).toEqual({ configured: false, enabled: false, state: 'disabled' });
    expect((await collectPlatform({ ...policy, enabled: false }, { now, tokenProvider })).state).toBe('disabled');
    for (const bad of [{ ...policy, org: '../elsewhere' }, { ...policy, app: 'other-app' }, { ...policy, enabled: 'true' }]) {
      expect((await collectPlatform(bad, { now, tokenProvider })).state).toBe('unknown');
    }
    expect(calls).toBe(0); expect(() => validatePolicy({ ...policy, version: 2 })).toThrow();
  });
  it('supports documented credential schemes and rejects header injection', () => {
    expect(authorizationFor(token)).toBe('FlyV1 ' + token);
    expect(authorizationFor('FlyV1 ' + token)).toBe('FlyV1 ' + token);
    expect(authorizationFor('legacy-fixture-token')).toBe('Bearer legacy-fixture-token');
    expect(() => authorizationFor('legacy\r\nheader')).toThrow();
  });
  it.each(['stale', 'future', 'empty', 'missing', 'duplicate', 'wrong-app', 'insufficient', 'nonfinite'])('keeps %s evidence unknown', async kind => {
    const data = packets();
    if (kind === 'stale') data.sourceTime = vector((now - 90001) / 1000);
    if (kind === 'future') data.sourceTime = vector((now + 5001) / 1000);
    if (kind === 'empty') data.throttled.data.result = [];
    if (kind === 'missing') data.support.data.result[0].metric = { ...metric, instance: 'other' };
    if (kind === 'duplicate') data.throttled.data.result.push(structuredClone(data.throttled.data.result[0]));
    if (kind === 'wrong-app') data.sourceTime.data.result[0].metric = { ...metric, app: 'other-app' };
    if (kind === 'insufficient') data.support = vector(1);
    if (kind === 'nonfinite') data.throttled.data.result[0].value[1] = 'NaN';
    const r = await collectPlatform(policy, { now, tokenProvider: async () => token, fetcher: transport(data) });
    expect(r.state).toBe('unknown'); expect(r.snapshot).toBeUndefined(); expect(JSON.stringify(r)).not.toContain(token);
  });
  it('identifies an old host as superseded only when the same instance has a fresh replacement', () => {
    const data = packets(0), older = { ...metric, host: 'older' };
    for (const [name, value] of Object.entries({ throttled: 100, sourceTime: (now - 120000) / 1000, support: 20 })) data[name].data.result.push(vector(value, older).data.result[0]);
    const r = inspectPlatform(data, now); expect(r.state).toBe('healthy'); expect(r.superseded).toEqual([{ instance: metric.instance, host: 'older', sourceAt: now - 120000 }]);
    for (const d of Object.values(data)) d.data.result[1].metric.instance = 'another-instance';
    expect(() => inspectPlatform(data, now)).toThrow(/stale/);
  });
  it('does not retain credential echoes, redirects, oversized or unavailable responses', async () => {
    for (const response of [new Response('', { status: 401 }), new Response('', { status: 302 }),
      new Response('x'.repeat(32769), { headers: { 'content-type': 'application/json' } }),
      Response.json({ ...vector(50), echo: token })]) {
      const r = await collectPlatform(policy, { now, tokenProvider: async () => 'FlyV1 ' + token,
        fetcher: async () => response.clone() });
      expect(r.state).toBe('unknown'); expect(JSON.stringify(r)).not.toContain(token); expect(r.snapshot).toBeUndefined();
    }
  });
});
