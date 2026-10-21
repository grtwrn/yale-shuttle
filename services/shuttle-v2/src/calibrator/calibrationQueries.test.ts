import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DbBundle } from '../db/client.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import { calibrate, loadVisitCalibration, loadLegCalibration, loadStandGroups, loadStandOccurrenceGroups,
  loadStopShares, loadStopOccurrenceShares, loadDriveGroups, loadLegGroups, type ValueGroup } from './calibrator.js';

const now = Date.parse('2026-10-21T18:00:00Z'), day = 86400000;
let folder: string, bundle: DbBundle;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-calibration-queries-'));
  bundle = openDb(path.join(folder, 'source.sqlite'));
  migrate(bundle.db, { migrationsFolder: './drizzle' });
});
afterEach(() => { bundle.sqlite.close(); fs.rmSync(folder, { recursive: true, force: true }); });

function insert(table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  bundle.sqlite.prepare('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...columns.map(c => values[c]));
}
function visit(overrides: Record<string, unknown> = {}) {
  insert('stop_visits', { bus_id: 1, bus_name: '#fixture', anchor_bus_id: 1, route_id: 1, stop_id: 1, stop_index: 0,
    anchored_at: now - 60000, pinned_at: now - 40000, arrived_at: now - 40000, departed_at: now - 20000,
    stand_sec: 20, inside_sec: 20, outcome: 'stopped', how: 'next', confidence: 1, steps: 3, rest_polls: 2,
    shuffles: 0, closest_m: 10, first_moved_at: null, confirm_sec: 0, dow: 3, hour: 14, ...overrides });
}
function leg(overrides: Record<string, unknown> = {}) {
  insert('legs', { bus_id: 1, bus_name: '#fixture', route_id: 1, from_stop_id: 1, from_index: 0, to_stop_id: 2, to_index: 1,
    hops: 1, departed_at: now - 60000, arrived_at: now - 20000, to_pinned_at: now - 30000,
    leg_sec: 40, hold_sec: 10, drive_sec: 30, holds: 1, reached: 1, dow: 3, hour: 14, ...overrides });
}
const groups = (input: ValueGroup[]) => input.map(g => ({ ...g, all: g.all.slice().sort((a, b) => a - b), windowed: g.windowed.slice().sort((a, b) => a - b) })).sort((a, b) => a.key.localeCompare(b.key));
function compareVisits(at = now, days = 30) {
  const result = loadVisitCalibration(bundle.db, days, at);
  expect(groups(result.standGroups)).toEqual(groups(loadStandGroups(bundle.db, days, at)));
  expect(groups(result.standOccurrenceGroups)).toEqual(groups(loadStandOccurrenceGroups(bundle.db, days, at)));
  expect(result.stopShares).toEqual(loadStopShares(bundle.db, days, at));
  expect(result.stopOccurrenceShares).toEqual(loadStopOccurrenceShares(bundle.db, days, at));
  return result;
}
function compareLegs(at = now, days = 30) {
  const result = loadLegCalibration(bundle.db, days, at);
  expect(groups(result.driveGroups)).toEqual(groups(loadDriveGroups(bundle.db, days, at)));
  expect(groups(result.legGroups)).toEqual(groups(loadLegGroups(bundle.db, days, at)));
  return result;
}

describe('shared calibration reads preserve original sample eligibility and values', () => {
  it('keeps empty source tables empty', () => {
    expect(compareVisits()).toEqual({ standGroups: [], standOccurrenceGroups: [], stopShares: new Map(), stopOccurrenceShares: new Map() });
    expect(compareLegs()).toEqual({ driveGroups: [], legGroups: [] });
  });

  it('pools repeated stop occurrences with sample-weighted stop shares', () => {
    visit({ stop_index: 0 }); visit({ stop_index: 0, outcome: 'passed' });
    visit({ stop_index: 2, pinned_at: now - 50000 });
    for (let i = 0; i < 7; i++) visit({ stop_index: 2, outcome: 'passed', pinned_at: null, departed_at: null });
    const result = compareVisits();
    expect(result.stopShares.get('1:1')).toBe(2 / 10);
    expect(result.stopOccurrenceShares.get('1:1#0')).toBe(1 / 2);
    expect(result.stopOccurrenceShares.get('1:1#2')).toBe(1 / 8);
    expect(result.standGroups[0]!.n).toBe(3);
    expect(result.standGroups[0]!.all.slice().sort((a, b) => a - b)).toEqual([0, 20, 30]);
  });

  it('includes unpinned passes in stop shares without inventing stand samples', () => {
    visit(); visit({ outcome: 'passed', pinned_at: null, departed_at: null });
    visit({ stop_id: 2, outcome: 'passed', pinned_at: null, departed_at: null });
    const result = compareVisits();
    expect(result.standGroups.map(g => g.key)).toEqual(['1:1']);
    expect(result.stopShares.get('1:1')).toBe(0.5); expect(result.stopShares.get('1:2')).toBe(0);
  });

  it('preserves unresolved, unpinned and backwards-clock stopped-visit rules', () => {
    visit({ outcome: 'unresolved' }); visit({ pinned_at: null });
    visit({ departed_at: now - 50000 }); visit({ departed_at: null }); visit();
    const result = compareVisits(); expect(result.standGroups[0]!.all).toEqual([20]);
    expect(result.stopShares.get('1:1')).toBe(1);
  });

  it('excludes future completion and confirmation while keeping the exact confirmation boundary', () => {
    visit({ departed_at: now + 1 }); visit({ first_moved_at: now + 1 });
    visit({ confirm_sec: 20 }); visit({ confirm_sec: 20.001 });
    const before = compareVisits(now - 1), at = compareVisits(now), after = compareVisits(now + 1);
    expect(before.standGroups).toEqual([]); expect(at.standGroups[0]!.n).toBe(1); expect(after.standGroups[0]!.n).toBe(4);
  });

  it('checks the known anchor/first-movement lower bound for passes without departure clocks', () => {
    visit({ outcome: 'passed', pinned_at: null, departed_at: null, first_moved_at: now - 1000, confirm_sec: 1 });
    visit({ outcome: 'passed', pinned_at: null, departed_at: null, first_moved_at: now - 999, confirm_sec: 1 });
    const at = compareVisits(); expect(at.stopShares.size).toBe(1); expect(at.standGroups).toEqual([]);
    expect(loadVisitCalibration(bundle.db, 30, now - 1).stopShares.size).toBe(0);
  });

  it('keeps inclusive start lookback boundaries for visits and legs', () => {
    for (const offset of [-1, 0, 1]) {
      const start = now - 30 * day + offset;
      visit({ anchored_at: start, pinned_at: start, departed_at: start + 1000 });
      leg({ departed_at: start, arrived_at: start + 2000, to_pinned_at: start + 1000 });
    }
    expect(compareVisits().standGroups[0]!.n).toBe(2); expect(compareLegs().driveGroups[0]!.n).toBe(2);
  });

  it('keeps drive-only and whole-leg-only samples distinct', () => {
    leg(); leg({ leg_sec: 0 }); leg({ to_pinned_at: now - 60000 });
    leg({ to_pinned_at: now - 61000, leg_sec: Math.PI });
    leg({ to_pinned_at: null, leg_sec: 0.1 + 0.2 });
    leg({ to_pinned_at: now - 61000, leg_sec: 0 });
    const result = compareLegs(); expect(result.driveGroups[0]!.n).toBe(3); expect(result.legGroups[0]!.n).toBe(4);
    expect(result.legGroups[0]!.all).toContain(0.1 + 0.2); expect(result.legGroups[0]!.all).toContain(Math.PI);
  });

  it('retains one-hop, future-arrival and future-pin fences for both travel quantities', () => {
    leg(); leg({ hops: 2 }); leg({ arrived_at: now + 1 }); leg({ to_pinned_at: now + 1 });
    leg({ departed_at: now + 1, arrived_at: now + 2000, to_pinned_at: now + 1000 });
    const result = compareLegs(); expect(result.driveGroups[0]!.n).toBe(1); expect(result.legGroups[0]!.n).toBe(1);
  });

  it('retains exact non-millisecond doubles in both visit and travel tables', () => {
    for (const value of [0.1 + 0.2, 1 / 3, Math.PI, 30.115]) {
      visit({ pinned_at: now - 50000, departed_at: now - 50000 + value * 1000 });
      leg({ leg_sec: value, departed_at: now - 50000, arrived_at: now - 50000 + value * 1000, to_pinned_at: null });
    }
    compareVisits(); const result = compareLegs(); expect(result.legGroups[0]!.all).toEqual([0.1 + 0.2, 1 / 3, Math.PI, 30.115]);
  });

  it.each([now - 1, now, now + 60000])('matches all original loaders on mixed interleaved records at %s', at => {
    bundle.sqlite.transaction(() => {
      for (let i = 0; i < 257; i++) {
        const start = now - (i % 67) * day / 2;
        visit({ route_id: 1 + i % 3, stop_id: 1 + i % 4, stop_index: i % 5, anchored_at: start,
          pinned_at: i % 6 ? start + 1000.125 : null, departed_at: i % 11 ? start + 30000 + i % 13 : null,
          outcome: i % 7 === 0 ? 'unresolved' : i % 3 === 0 ? 'passed' : 'stopped',
          first_moved_at: i % 17 === 0 ? now + 1 : null, confirm_sec: i % 19 === 0 ? 60000 : 0 });
        leg({ route_id: 1 + i % 3, from_stop_id: 1 + i % 4, to_stop_id: 2 + i % 4, departed_at: start,
          arrived_at: start + 10000, to_pinned_at: i % 3 === 0 ? null : i % 7 === 0 ? start - 1000 : start + 5000,
          hops: i % 13 === 0 ? 2 : 1, leg_sec: i % 11 === 0 ? 0 : (i % 43) / 7 });
      }
    })();
    for (const days of [1, 30]) { compareVisits(at, days); compareLegs(at, days); }
  });

  it('runs the routine calibrator with five source reads including its hourly stand table', () => {
    visit(); visit({ stop_index: 2 }); leg();
    const network = TransitNetwork.build([{ id: 1, name: 'A', lat: 41.31, lon: -72.93 }, { id: 2, name: 'B', lat: 41.312, lon: -72.93 }, { id: 3, name: 'C', lat: 41.314, lon: -72.93 }],
      [{ id: 1, name: 'Loop', shortName: 'L', color: '#000', stops: [1, 2, 1, 3] }]);
    const reads = vi.spyOn(bundle.db, 'all');
    calibrate(bundle.db, network, new Date(now), new Map(), new Map(), new Set(['1:1']));
    expect(reads).toHaveBeenCalledTimes(5);
  });
});
