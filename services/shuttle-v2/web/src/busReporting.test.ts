import { describe, expect, it } from 'vitest';
import { emptyReportingState, reportingNotice, stepBusReporting, type ReportingState,
  type ReportingWatch } from './busReporting';
import type { BusData } from './map-data';

const start = Date.parse('2026-10-14T13:37:00-04:00');
const watch: ReportingWatch = { busName: '317', routeLabel: 'Red', routeIds: [3] };
const next: ReportingWatch = { ...watch, busName: '126' };
const bus = (at: number, overrides: Partial<BusData> = {}): BusData => ({ bus_name: '#317', bus_id: 67678,
  route_id: 3, lat: 41.323396, lon: -72.928806, heading: 0, last_stop_id: 27, observed_at: at, ...overrides });
const step = (prior: ReportingState, elapsed: number, buses: BusData[], watched = [watch],
  available = true, visible = true, scope = ['Red']) => stepBusReporting(prior,
    { buses, at: start + elapsed, serverAt: start + elapsed }, watched, scope, available, visible);
const watching = () => step(emptyReportingState(), 0, [bus(start)]);
const lost = () => step(step(watching(), 5000, []), 10000, []);

describe('individual bus reporting notices', () => {
  it('enrolls a newly visible fresh bus on the current poll without counting that poll twice', () => {
    const initial = step(emptyReportingState(), 0, [bus(start)], []);
    expect(initial.records).toEqual([]);
    const enrolled = step(initial, 0, [bus(start)]);
    expect(enrolled.lastPollAt).toBe(start);
    expect(enrolled.records).toMatchObject([{ busName: '317', status: 'watching', missingPolls: 0 }]);
    expect(step(enrolled, 0, [bus(start)])).toBe(enrolled);
    const missing = step(enrolled, 5000, []);
    expect(missing.records[0]).toMatchObject({ status: 'watching', missingPolls: 1, missingSince: start + 5000 });
    expect(step(missing, 10000, []).records[0]?.status).toBe('lost');
  });

  it('adds a newly watched bus without advancing an existing missing episode on the same poll', () => {
    const replacement = bus(start + 5000, { bus_name: '#126' });
    const missing = step(watching(), 5000, [replacement]);
    const changed = step(missing, 5000, [replacement], [next]);
    expect(changed.lastPollAt).toBe(missing.lastPollAt);
    expect(changed.records.find(r => r.busName === '317')).toBe(missing.records[0]);
    expect(changed.records.find(r => r.busName === '126')).toMatchObject({ status: 'watching', missingPolls: 0 });
    expect(step(changed, 10000, [bus(start + 10000, { bus_name: '#126' })], [next]).records
      .find(r => r.busName === '317')?.status).toBe('lost');
  });

  it('preserves a dismissed loss when another fresh watch joins the same poll', () => {
    const state = lost(); state.records[0]!.dismissed = true;
    const changed = step(state, 10000, [bus(start + 10000, { bus_name: '#126' })], [next]);
    expect(changed.records.find(r => r.busName === '317')).toBe(state.records[0]);
    expect(changed.records.find(r => r.busName === '317')).toMatchObject({ status: 'lost', dismissed: true, missingPolls: 2 });
    expect(changed.records.find(r => r.busName === '126')?.status).toBe('watching');
  });

  it('replaces an out-of-scope record on the same poll even when the record count is unchanged', () => {
    const blue: ReportingWatch = { busName: '126', routeLabel: 'Blue Day', routeIds: [1] };
    const snapshot = { at: start, serverAt: start, buses: [bus(start), bus(start, { bus_name: '#126', route_id: 1 })] };
    const initial = stepBusReporting(emptyReportingState(), snapshot, [watch], ['Red', 'Blue Day'], true, true);
    const changed = stepBusReporting(initial, snapshot, [blue], ['Blue Day'], true, true);
    expect(changed).not.toBe(initial);
    expect(changed.lastPollAt).toBe(start);
    expect(changed.records).toMatchObject([{ busName: '126', routeLabel: 'Blue Day', status: 'watching' }]);
    expect(changed.records).toHaveLength(initial.records.length);
  });

  for (const reason of ['older poll', 'missing snapshot', 'missing bus', 'stale bus', 'failed connection', 'hidden tab'] as const) {
    it(`does not enroll a new watch from ${reason}`, () => {
      const initial = step(emptyReportingState(), 0, [bus(start)], []);
      const snapshot = reason === 'missing snapshot' ? null : { at: reason === 'older poll' ? start - 1 : start,
        serverAt: start, buses: reason === 'missing bus' ? [] : [bus(reason === 'stale bus' ? start - 45000 : start)] };
      expect(stepBusReporting(initial, snapshot, [watch], ['Red'], reason !== 'failed connection', reason !== 'hidden tab').records).toEqual([]);
    });
  }

  it('waits for two distinct successful polls and a short grace, keeping the missing bus after an ETA replacement', () => {
    const missing = step(watching(), 5000, [bus(start + 5000, { bus_name: '#126' })], [next]);
    expect(missing.records.find(r => r.busName === '317')?.status).toBe('watching');
    expect(step(missing, 5000, [], [next])).toBe(missing);
    expect(step(missing, 6000, [], [next]).records.find(r => r.busName === '317')?.status).toBe('watching');
    const state = step(missing, 10000, [bus(start + 10000, { bus_name: '#126' })], [next]);
    const record = state.records.find(r => r.busName === '317')!;
    expect(record.status).toBe('lost');
    expect(reportingNotice(record, next)).toEqual({ title: 'Red #317 stopped reporting',
      detail: expect.stringContaining('trip now shows #126') });
    expect(reportingNotice(record).detail).toContain('does not say whether');
  });

  it('does not alert for a one-poll dropout', () => {
    const state = step(step(watching(), 5000, []), 10000, [bus(start + 10000)]);
    expect(state.records[0]?.status).toBe('watching');
    expect(state.records[0]?.missingPolls).toBe(0);
  });

  it('does not call an ordinary change of selected bus a reporting loss', () => {
    const state = step(watching(), 5000, [bus(start + 5000), bus(start + 5000, { bus_name: '#126' })], [next]);
    expect(state.records.map(r => r.busName)).toEqual(['126']);
    expect(step(state, 10000, [bus(start + 10000, { bus_name: '#126' })], [next]).records[0]?.status).toBe('watching');
  });

  it('keeps the GPS watch when a fresh bus loses its forecast, then alerts if it also stops reporting', () => {
    const changed = stepBusReporting(watching(), { buses: [bus(start + 5000), bus(start + 5000, { bus_name: '#126' })],
      at: start + 5000, serverAt: start + 5000, forecasts: { at: start + 5000, watches: [next] } }, [next], ['Red'], true, true);
    expect(changed.records.find(r => r.busName === '317')).toMatchObject({ status: 'watching', forecastWithheld: true });
    // An unknown whole model cannot erase the original identity.
    const unknown = stepBusReporting(changed, { buses: [bus(start + 10000), bus(start + 10000, { bus_name: '#126' })],
      at: start + 10000, serverAt: start + 10000, forecasts: null }, [next], ['Red'], true, true);
    expect(unknown.records.find(r => r.busName === '317')?.forecastWithheld).toBe(true);
    const missing = step(unknown, 15000, [bus(start + 15000, { bus_name: '#126' })], [next]);
    expect(step(missing, 20000, [bus(start + 20000, { bus_name: '#126' })], [next]).records
      .find(r => r.busName === '317')?.status).toBe('lost');
  });

  it('forgets an ordinary selection change when the original fresh forecast is still available', () => {
    const state = stepBusReporting(watching(), { buses: [bus(start + 5000), bus(start + 5000, { bus_name: '#126' })],
      at: start + 5000, serverAt: start + 5000, forecasts: { at: start + 5000, watches: [watch, next] } }, [next], ['Red'], true, true);
    expect(state.records.map(r => r.busName)).toEqual(['126']);
  });

  it('keeps a stationary bus live when observations keep arriving', () => {
    expect(step(watching(), 120000, [bus(start + 120000)]).records[0]?.status).toBe('watching');
  });

  it('detects a stale individual observation even when the server retains its position', () => {
    const stale = step(watching(), 45000, [bus(start)]);
    expect(step(stale, 50000, [bus(start)]).records[0]?.status).toBe('lost');
  });

  it('uses server time for observation age when the phone clock is different', () => {
    const snapshot = { buses: [bus(start + 5000)], serverAt: start + 5000, at: start + 3600000 };
    expect(stepBusReporting(watching(), snapshot, [watch], ['Red'], true, true).records[0]?.status).toBe('watching');
  });

  it('does not count a failed app connection as a missing vehicle', () => {
    const failed = step(step(watching(), 5000, []), 10000, [], [watch], false);
    expect(failed.records[0]?.missingPolls).toBe(0);
    expect(step(failed, 15000, []).records[0]?.status).toBe('watching');
    expect(step(step(failed, 15000, []), 20000, []).records[0]?.status).toBe('lost');
  });

  it('does not count hidden-tab time or old responses as consecutive missing polls', () => {
    const hidden = step(step(watching(), 5000, []), 35000, [], [watch], true, false);
    expect(step(hidden, 35000, []).records[0]?.missingPolls).toBe(0);
    const resumed = step(hidden, 40000, []);
    expect(resumed.records[0]?.status).toBe('watching');
    expect(step(resumed, 45000, []).records[0]?.status).toBe('lost');
    expect(step(resumed, 1000, [])).toBe(resumed);
  });

  it('reports recovery under a new tracking ID, even after dismissal and a card switching to another bus', () => {
    const state = lost(); state.records[0]!.dismissed = true;
    const recovered = step(state, 15000, [bus(start + 15000, { bus_id: 67698, bus_name: '317' }),
      bus(start + 15000, { bus_name: '#126' })], [next]);
    const record = recovered.records.find(r => r.busName === '317')!;
    expect(record).toMatchObject({ status: 'returned', dismissed: false });
    expect(reportingNotice(record).title).toBe('Red #317 is reporting again');
    expect(step(recovered, 45000, [bus(start + 45000, { bus_name: '#126' })], [next])
      .records.find(r => r.busName === '317')?.status).not.toBe('returned');
  });

  it('expires a recovery notice after 30 seconds without keeping an old selection', () => {
    const recovered = step(lost(), 15000, [bus(start + 15000)], []);
    expect(step(recovered, 45000, [bus(start + 45000)], []).records).toEqual([]);
  });

  it('does not repeat an alert every poll, but allows a new loss after recovery', () => {
    const state = lost(); state.records[0]!.dismissed = true;
    expect(step(state, 15000, []).records[0]?.dismissed).toBe(true);
    const back = step(state, 20000, [bus(start + 20000)]);
    const lostAgain = step(step(back, 25000, []), 30000, []);
    expect(lostAgain.records[0]).toMatchObject({ status: 'lost', changedAt: start + 30000, dismissed: false });
  });

  it('clears records when the user changes scope, but does not use a filtered display as disappearance evidence', () => {
    expect(step(lost(), 15000, [], [], true, true, ['Blue Day']).records).toEqual([]);
    expect(step(watching(), 5000, [bus(start + 5000)], []).records).toEqual([]);
    expect(step(emptyReportingState(), 0, [], [watch]).records).toEqual([]);
  });

  it('does not mistake a matching bus number on another route for a return', () => {
    expect(step(lost(), 15000, [bus(start + 15000, { route_id: 19 })]).records[0]?.status).toBe('lost');
  });
});
