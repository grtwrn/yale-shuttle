import { describe, expect, it } from "vitest";
import { loadTripDraft, saveTripDraft, type TripDraft } from "./tripDraft";
const makeStore = () => { let value: string | null = null; return {
  getItem: () => value, setItem: (_k: string, v: string) => { value = v; }, removeItem: () => { value = null; },
}; };
const trip: TripDraft = { fromText: "", fromLL: null, toText: "Yale Public Health",
  toLL: { lat: 41.303735, lon: -72.932155 }, tripTime: "", expandedKey: "Red" };
describe("waiting trip restoration", () => {
  it("restores the destination and route without freezing a live GPS origin", () => {
    const store = makeStore(); saveTripDraft(trip, store, 1000);
    expect(loadTripDraft(store, 2000)).toEqual(trip);
  });
  it("retains a selected manual origin and planning time", () => {
    const draft = { ...trip, fromText: "Division / Prospect", fromLL: { lat: 41.324769, lon: -72.923522 }, tripTime: "2026-09-10T17:00" };
    const store = makeStore(); saveTripDraft(draft, store, 1000);
    expect(loadTripDraft(store, 2000)).toEqual(draft);
  });
  it("does not resurrect cleared or stale plans", () => {
    const store = makeStore(); saveTripDraft(trip, store, 1000);
    expect(loadTripDraft(store, 1000 + 2 * 3600_000 + 1)).toBeNull();
    saveTripDraft(null, store); expect(loadTripDraft(store, 2000)).toBeNull();
  });
  it("rejects malformed coordinates and storage", () => {
    const store = makeStore(); store.setItem("", "not json"); expect(loadTripDraft(store)).toBeNull();
    saveTripDraft({ ...trip, toLL: { lat: 999, lon: 0 } }, store, 1000);
    expect(loadTripDraft(store, 2000)).toBeNull();
    const blocked = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
    expect(loadTripDraft(blocked)).toBeNull(); expect(() => saveTripDraft(trip, blocked)).not.toThrow();
  });
});
