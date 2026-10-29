import { describe, expect, it } from 'vitest';
import { assertForecastRuntime, FORECAST_RUNTIME } from './runtime-policy.mjs';

const runtime = () => Object.fromEntries(['node', 'platform', 'arch', 'timezone'].map(k => [k, FORECAST_RUNTIME[k]]));
const observer = () => ({ nativeRuntime: runtime(), runtimeBytes: { nodeBinarySHA256: FORECAST_RUNTIME.nodeBinarySHA256 } });
const producer = () => ({ runtime: runtime(), nodeBinarySHA256: FORECAST_RUNTIME.nodeBinarySHA256 });
describe('prospective replay runtime contract', () => {
  it('accepts independently attested observer and producer runtimes on the pinned binary', () => {
    expect(() => assertForecastRuntime(observer())).not.toThrow();
    expect(() => assertForecastRuntime(producer(), true)).not.toThrow();
  });
  it.each(['node', 'platform', 'arch', 'timezone'])('refuses a different observer %s before prospective collection', key => {
    const input = observer(); input.nativeRuntime[key] = 'different';
    expect(() => assertForecastRuntime(input)).toThrow('Learning observer runtime is incompatible');
  });
  it('refuses a matching version label on a different actual Node binary', () => {
    const input = observer(); input.runtimeBytes.nodeBinarySHA256 = 'f'.repeat(64);
    expect(() => assertForecastRuntime(input)).toThrow('pinned Node binary');
  });
  it('refuses an upgraded producer until the matching runtime has been qualified', () => {
    const input = producer(); input.runtime.node = 'v22.23.5';
    expect(() => assertForecastRuntime(input, true)).toThrow('Production runtime is incompatible');
  });
  it('cannot accept missing runtime or binary evidence', () => {
    for (const input of [null, {}, {nativeRuntime: runtime()}, {runtime: runtime()}]) {
      expect(() => assertForecastRuntime(input)).toThrow();
      expect(() => assertForecastRuntime(input, true)).toThrow();
    }
  });
});
