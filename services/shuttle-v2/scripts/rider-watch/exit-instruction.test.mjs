import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { confirmExitInstruction, offPoleExitInstruction } from './exit-instruction.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./__fixtures__/blue-exit-instruction-20261015.json', import.meta.url), 'utf8'));
const input = (i = 0) => ({ sample: structuredClone(fixture.samples[i]), run: structuredClone(fixture.run),
  feed: { buses: structuredClone(fixture.samples[i].buses), stop_coords: fixture.stopCoords, stop_names: fixture.stopNames } });
const detect = ({ sample, run, feed }) => offPoleExitInstruction(sample.text, feed, run, Date.parse(sample.at), sample.feedAgeMs);
const fixed = text => text.replaceAll('Get off here', 'Watch for your stop').replaceAll('Arriving at College/George', 'Watch for College/George');

describe('independent ride instruction review', () => {
  it('finds the original Blue screen/GPS contradiction before the 50-minute timeout', () => {
    const a = detect(input()), b = detect(input(1));
    expect(a).toMatchObject({ bus: '#40', routeId: 1, exitStopId: 39, instruction: 'Get off here' });
    expect(a.distanceM).toBeGreaterThan(135);
    const now = Date.parse(fixture.samples[0].at), first = confirmExitInstruction(null, a, now);
    expect(first.alert).toBeNull();
    const second = confirmExitInstruction(first.state, b, Date.parse(fixture.samples[1].at));
    expect(second.alert).toMatchObject({ exitStopId: 39, firstWitness: a });
    expect(second.alert.confirmedAt).toBeLessThan(Date.parse('2026-10-15T16:42:05.834Z'));
    expect(confirmExitInstruction(second.state, detect(input(2)), Date.parse(fixture.samples[2].at)).alert).toBeNull();
  });
  it('accepts the corrected screen and a genuine near-marker position', () => {
    const x = input(); x.sample.text = fixed(x.sample.text);
    expect(detect(x)).toBeNull();
    const y = input(); Object.assign(y.feed.buses[0], fixture.stopCoords[39]);
    expect(detect(y)).toBeNull();
  });
  it('also sees an off-pole arriving banner after the popup is dismissed', () => {
    const x = input(); x.sample.text = x.sample.text.replace('Get off here', 'Dismissed');
    expect(detect(x)).toMatchObject({ instruction: 'Arriving at College / George' });
  });
  it.each(['old GPS', 'future GPS', 'missing GPS clock', 'old receipt', 'unknown receipt', 'invalid GPS',
    'unknown exit', 'wrong ride', 'wrong route', 'wrong bus', 'ambiguous buses', 'ambiguous caption',
    'unknown stored ride', 'different stored exit', 'not riding'])('declines %s', reason => {
    const x = input(), now = Date.parse(x.sample.at);
    if (reason === 'old GPS') x.feed.buses[0].observed_at = now - 30001;
    if (reason === 'future GPS') x.feed.buses[0].observed_at = now + 5001;
    if (reason === 'missing GPS clock') delete x.feed.buses[0].observed_at;
    if (reason === 'old receipt') x.sample.feedAgeMs = 30001;
    if (reason === 'unknown receipt') x.sample.feedAgeMs = NaN;
    if (reason === 'invalid GPS') x.feed.buses[0].lat = 91;
    if (reason === 'unknown exit') x.feed.stop_coords = {};
    if (reason === 'wrong ride') x.sample.text = x.sample.text.replaceAll('Blue Day #40', 'Red #317');
    if (reason === 'wrong route') x.run.line.busRouteIds = [3];
    if (reason === 'wrong bus') x.feed.buses[0].bus_name = '#41';
    if (reason === 'ambiguous buses') x.feed.buses.push({ ...x.feed.buses[0] });
    if (reason === 'ambiguous caption') x.sample.text += '\nRed #317 → Union Station';
    if (reason === 'unknown stored ride') x.run.boardedStorage = {};
    if (reason === 'different stored exit') x.run.boardedStorage['shuttle-boarded-ride'] = JSON.stringify({ ...JSON.parse(x.run.boardedStorage['shuttle-boarded-ride']), alightStopId: 72 });
    if (reason === 'not riding') x.run.phase = 'waiting';
    expect(detect(x)).toBeNull();
  });
  it('requires distinct GPS and consecutive time, permits moving distances, and resets after recovery', () => {
    const a = detect(input()), now = Date.parse(fixture.samples[0].at);
    const first = confirmExitInstruction(null, a, now);
    expect(confirmExitInstruction(first.state, a, now + 10000).alert).toBeNull();
    const b = { ...a, observedAt: a.observedAt + 10000, distanceM: a.distanceM + 20 };
    expect(confirmExitInstruction(first.state, b, now + 10000).alert).not.toBeNull();
    expect(confirmExitInstruction(first.state, b, now + 31000).alert).toBeNull();
    expect(confirmExitInstruction(first.state, { ...b, observedAt: a.observedAt - 1 }, now + 10000).alert).toBeNull();
    expect(confirmExitInstruction(first.state, b, now - 1).alert).toBeNull();
    expect(confirmExitInstruction(first.state, null, now + 10000)).toEqual({ state: null, alert: null });
    expect(confirmExitInstruction(first.state, { ...b, runId: 'another-run' }, now + 10000).alert).toBeNull();
  });
});
