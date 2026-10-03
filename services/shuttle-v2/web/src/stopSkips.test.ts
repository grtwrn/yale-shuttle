import { describe, expect, it } from 'vitest';
import { parseStopSkips, skipNotice } from './stopSkips';

const names: Record<number, string> = { 122: 'Union Station (S)', 1: '100 Church Street South', 9: '300 George St' };
const coords = {
  122: { lat: 41.297929, lon: -72.926912 },
  1: { lat: 41.299671, lon: -72.929425 },
  9: { lat: 41.305166, lon: -72.930745 },
};

describe('the payload field', () => {
  it('keeps well-formed entries and drops everything else', () => {
    expect(parseStopSkips(undefined)).toEqual({});
    expect(parseStopSkips([1])).toEqual({});
    expect(parseStopSkips({
      10: {
        122: { skipped: 2, of: 3, last_at: 1, alt: 1 },
        1: { skipped: 3, of: 2, last_at: 1 },
        9: { skipped: 0, of: 3, last_at: 1 },
        26: { skipped: 2, of: 3 },
      },
      3: 'x',
      4: { 48: { skipped: 2, of: 2, last_at: 5, alt: 'Union' } },
    })).toEqual({ 10: { 122: { skipped: 2, of: 3, last_at: 1, alt: 1 } }, 4: { 48: { skipped: 2, of: 2, last_at: 5 } } });
  });
});

describe('the notice', () => {
  const skips = parseStopSkips({ 10: { 122: { skipped: 2, of: 3, last_at: 1, alt: 1 } } });

  it('says how many recent buses skipped the stop and where the last one did stop', () => {
    expect(skipNotice(skips, 'Purple', [10], 122, names, coords))
      .toBe('⚠️ 2 of the last 3 Purple buses skipped Union Station (S). Try 100 Church Street South (4 min walk).');
    expect(skipNotice(parseStopSkips({ 10: { 122: { skipped: 3, of: 3, last_at: 1 } } }), 'Purple', [10], 122, names, coords))
      .toBe('⚠️ The last 3 Purple buses skipped Union Station (S).');
  });

  it('is nothing for another stop or another line', () => {
    expect(skipNotice(skips, 'Purple', [10], 1, names, coords)).toBeNull();
    expect(skipNotice(skips, 'Red', [3], 122, names, coords)).toBeNull();
  });

  it('leaves the alternative out rather than guessing its walk', () => {
    expect(skipNotice(skips, 'Purple', [10], 122, names, { 122: coords[122] }))
      .toBe('⚠️ 2 of the last 3 Purple buses skipped Union Station (S).');
  });
});
