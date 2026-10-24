import { describe, expect, it } from 'vitest';
import { shortOfNextStop, stepBelief, type Belief } from './filter';
import { buildRing, type Ring } from './ring';

const origin = { lat: 41.31, lon: -72.93 };
const at = (x: number, y = 0) => ({ lat: origin.lat + y / 111195, lon: origin.lon + x / 83500 });
const stops = [1, 2, 3, 4];
const coords = { 1: at(0), 2: at(940), 3: at(900, 450), 4: at(0, 450) };
const path: [number, number][] = [at(0), at(900), at(900, 450), at(0, 450), at(0)]
  .map(p => [p.lat, p.lon]);

function fixture() {
  const ring = buildRing('projection-test', path, stops, coords)!;
  const belief = stepBelief(undefined, ring, at(905), 20000, stops);
  Object.assign(belief, { lead: 0, lastStopId: 1, lastFix: at(905), leadTopFix: at(850),
    rested: false, restStop: -1, restApproach: false, leftStop: 0, leftAt: 1000, leadMassAt: 15000 });
  const cell = ring.stopCell[1]!, incoming = cell - 1;
  belief.p.fill(0); belief.p[ring.C + cell] = .65; belief.p[cell] = .25; belief.p[ring.C + incoming] = .1;
  belief.standLeg[cell] = 1; belief.zoneKey[cell] = 1;
  return { ring, belief };
}

function restAtNext(b: Belief, ring: Ring, standingMass: number) {
  b.rested = true; b.restStop = 1; b.restApproach = false; b.restPoint = at(905);
  const cell = ring.stopCell[1]!;
  b.p.fill(0); b.p[cell] = standingMass; b.p[ring.C + cell] = 1 - standingMass;
  b.standLeg[cell] = 1; b.zoneKey[cell] = 1;
}

describe('a projected marker before its published curb', () => {
  it('retains an incoming traversal after the projected marker while closing on the curb', () => {
    const { ring, belief } = fixture();
    expect(ring.stopCoords?.[1]).toEqual(coords[2]);
    expect(shortOfNextStop(belief, ring, 0)).toBe(true);
  });

  it('releases a bus moving away beyond the actual curb', () => {
    const { ring, belief } = fixture(); belief.lastFix = at(975);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('retains an approach curving toward the curb after its long chord turns sideways', () => {
    const { ring, belief } = fixture();
    belief.lastFix = at(940, 20);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
    belief.previousFix = at(905);
    expect(shortOfNextStop(belief, ring, 0)).toBe(true);
  });

  it('does not retain the curved approach after a distinct fix moves farther from the curb', () => {
    const { ring, belief } = fixture();
    belief.lastFix = at(940, 20); belief.previousFix = at(940, 10);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('requires meaningful closing rather than a GPS wobble', () => {
    const { ring, belief } = fixture(); belief.leadTopFix = at(900);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('requires a displaced marker and preserves the old rule without published coordinates', () => {
    const { ring, belief } = fixture();
    ring.stopCoords = [coords[1], { lat: ring.lat[ring.stopCell[1]!]!, lon: ring.lon[ring.stopCell[1]!]! }, coords[3], coords[4]];
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
    delete ring.stopCoords;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('requires the feed to uniquely identify the preceding call', () => {
    const { ring, belief } = fixture(); belief.lastStopId = 3;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
    belief.lastStopId = 1; ring.stops[2] = 1;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('retains the ambiguity gate for different published calls at a shared curb', () => {
    const { ring, belief } = fixture(); ring.stops[3] = 2;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
    ring.order[3] = ring.order[1]!;
    expect(shortOfNextStop(belief, ring, 0)).toBe(true);
  });

  it('never holds a newly observed departure from this curb', () => {
    const { ring, belief } = fixture(); belief.leftStop = 1; belief.leftAt = 20000;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('carries the incoming traversal through the first rest while movement still dominates', () => {
    const { ring, belief } = fixture(); restAtNext(belief, ring, .4);
    expect(shortOfNextStop(belief, ring, 0)).toBe(true);
    // A curved approach can remain closer than the first rest point while
    // its instantaneous radial direction has already turned sideways.
    belief.lastFix = at(940, 20);
    expect(shortOfNextStop(belief, ring, 0)).toBe(true);
  });

  it('releases on a dominant current stand or movement away from that incoming rest', () => {
    const { ring, belief } = fixture(); restAtNext(belief, ring, .6);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
    restAtNext(belief, ring, .4); belief.lastFix = at(940, 60);
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });

  it('lets a dominant at-curb standing mode advance before the rest clock is established', () => {
    const { ring, belief } = fixture(); restAtNext(belief, ring, .6);
    belief.rested = false; belief.restStop = -1;
    expect(shortOfNextStop(belief, ring, 0)).toBe(false);
  });
});
