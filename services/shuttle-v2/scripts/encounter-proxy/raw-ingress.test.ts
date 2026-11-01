import { describe, expect, it } from 'vitest';
import { canonicalJSON } from './canonical.js';
import { emptyIngressState, ingestRawPacket, projectPublicPacket, stripRawExchange, vehicleKey } from './raw-ingress.js';

const bus = (observedAt = 1000, lon = -73) => ({ route_id: 100, bus_id: 7, bus_name: '#raw',
  observed_at: observedAt, lat: 41, lon, stationary: true, at_stop_id: 100 });
const source = (buses: unknown[] = [bus()], cursor = 1, frames: unknown[] = []) => ({
  v: 1, epoch: 'raw-source', build: 'raw-build', cursor, latest: cursor, hasMore: false, frames, feed: { buses },
});
const timing = (at = 1100) => ({ originalReceivedAt: at, availableAt: at });

describe('independent raw receipt and observation boundaries', () => {
  it('separates full-byte custody from identical raw semantics under arbitrary model output changes', () => {
    const original = source();
    const changed = { ...original, server_eta: { rows: [[1, 100, -999, 0, 999999, 700]], travel: [1000] },
      feed: { ...original.feed, model_params: { changed: true }, segments: { guessed: 0 },
        dwells: { guessed: 99999 }, server_eta: { buses: [['fake', 'fake', 100]], rows: [] },
        buses: [{ ...bus(), heading: 9999, recent_speed: 999999, last_stop_id: 999, modelBelief: { lead: 100 } }] } };
    const a = stripRawExchange(new TextEncoder().encode(JSON.stringify(original)), 200, timing());
    const b = stripRawExchange(new TextEncoder().encode(JSON.stringify(changed)), 200, timing());
    expect(a.fullPacketHash).not.toBe(b.fullPacketHash);
    expect(canonicalJSON(a.packet)).toBe(canonicalJSON(b.packet));
    expect(canonicalJSON(a.packet)).not.toContain('modelBelief');
    expect(canonicalJSON(a.packet)).not.toContain('server_eta');
  });

  it('lets catch-up history acquire ONE later live witness without creating another observation', () => {
    const history = projectPublicPacket(source([bus()], 1, [{}]), timing());
    const first = ingestRawPacket(emptyIngressState(), history);
    expect(first.canonicalObservations).toHaveLength(1); expect(first.liveWitnesses).toEqual([]);
    const live = ingestRawPacket(first.state, projectPublicPacket(source(), timing(1200)));
    expect(live.canonicalObservations).toEqual([]); expect(live.liveWitnesses).toHaveLength(1);
    expect(live.liveWitnesses[0]!.evidence.availableAt).toBe(1200);
    const duplicate = ingestRawPacket(live.state, projectPublicPacket(source(), timing(1300)));
    expect(duplicate.canonicalObservations).toEqual([]); expect(duplicate.liveWitnesses).toEqual([]);
  });

  it('does not let a rejected far-future first fix poison the accepted progress watermark', () => {
    const future = ingestRawPacket(emptyIngressState(), projectPublicPacket(source([bus(100000)]), timing(10000)));
    expect(future.canonicalObservations).toEqual([]);
    const fresh = ingestRawPacket(future.state, projectPublicPacket(source([bus(10001)], 2), timing(10002)));
    expect(fresh.canonicalObservations).toHaveLength(1);
    expect(fresh.liveWitnesses).toHaveLength(1);
    expect(fresh.boundaries.some(value => value.reason === 'regressing-observation')).toBe(false);
  });

  it('remembers a rejected first variant before filters and detects a later same-clock conflict', () => {
    const future = ingestRawPacket(emptyIngressState(), projectPublicPacket(source([bus(100000)]), timing(99999)));
    const conflict = ingestRawPacket(future.state,
      projectPublicPacket(source([bus(100000, -72.99)], 2), timing(100001)));
    expect(conflict.boundaries.some(value => value.reason === 'same-clock-conflict')).toBe(true);
    expect(conflict.canonicalObservations).toEqual([]); expect(conflict.liveWitnesses).toEqual([]);
  });

  it('quarantines BOTH same-clock variants from one response rather than seeding the first one', () => {
    const conflict = ingestRawPacket(emptyIngressState(), projectPublicPacket(source([bus(), bus(1000, -72.99)]), timing()));
    expect(conflict.boundaries.some(value => value.reason === 'same-clock-conflict')).toBe(true);
    expect(conflict.canonicalObservations).toEqual([]); expect(conflict.liveWitnesses).toEqual([]);
  });

  it('retains malformed and absent fleet diagnostics instead of silently continuing the old vehicle', () => {
    const first = ingestRawPacket(emptyIngressState(), projectPublicPacket(source(), timing()));
    const malformed = projectPublicPacket(source([{ ...bus(2000), stationary: 'true' }], 2), timing(2100));
    expect(malformed.malformedBusIndices).toEqual([0]);
    const next = ingestRawPacket(first.state, malformed);
    expect(next.boundaries).toContainEqual({ vehicle: vehicleKey({ routeId: 100, busId: 7, busName: '#raw' }),
      reason: 'malformed-observation', availableAt: 2100 });
    expect(next.canonicalObservations).toEqual([]);
    expect(stripRawExchange(new TextEncoder().encode('{broken'), 200, timing()).error).toBe('malformed-packet');
    expect(stripRawExchange(new TextEncoder().encode('{}'), 503, timing()).error).toBe('http-error');
  });

  it('censors live observation regression even when it is an older retained historical observation', () => {
    const historical = ingestRawPacket(emptyIngressState(), projectPublicPacket(source([bus()], 1, [{}]), timing()));
    const current = ingestRawPacket(historical.state, projectPublicPacket(source([bus(2000)], 2), timing(2100)));
    const old = ingestRawPacket(current.state, projectPublicPacket(source([bus()], 3), timing(2200)));
    expect(old.boundaries.some(value => value.reason === 'regressing-observation')).toBe(true);
    expect(old.liveWitnesses).toEqual([]);
  });

  it('rejects changed consumer clocks and forged live-witness provenance after projection', () => {
    const packet = projectPublicPacket(source(), timing());
    const changedReceipt = structuredClone(packet); changedReceipt.availableAt++;
    expect(() => ingestRawPacket(emptyIngressState(), changedReceipt)).toThrow();
    const changedWitness = structuredClone(packet); changedWitness.observations[0]!.evidence.availableAt--;
    expect(() => ingestRawPacket(emptyIngressState(), changedWitness)).toThrow();
  });
});
