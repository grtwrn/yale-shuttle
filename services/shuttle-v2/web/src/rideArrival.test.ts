import { describe, expect, it } from "vitest";
import { isUnambiguousRideArrival } from "./rideArrival";

// Raw sequences from the September 10 feed, retaining both West Campus passes.
const GREEN = [78,84,89,77,94,143,144,133,88,92,81,26,25,23,22,23,24,25,127,26,80,91,87];
const PURPLE = [10,9,1,122,127,26,25,24,23,22,23,24,25,26,72];
describe("the ride arrival shortcut", () => {
  it("does not mistake either repeated West Campus pass for the planned exit", () => {
    for (const route of [GREEN, PURPLE]) {
      for (const id of new Set(route)) {
        if (route.indexOf(id) === route.lastIndexOf(id)) continue;
        const displayIndex = [...new Set(route)].indexOf(id);
        expect(isUnambiguousRideArrival(route, id, displayIndex, displayIndex)).toBe(false);
      }
    }
  });
  it("retains arrival for an unambiguous LEPH exit", () => {
    expect(isUnambiguousRideArrival([48,104,113,4,42,98,38,39,72],72,8,8)).toBe(true);
    expect(isUnambiguousRideArrival(PURPLE,72,10,10)).toBe(true);
  });
  it("requires a known exit and a matching anchor", () => {
    expect(isUnambiguousRideArrival(undefined,72,8,8)).toBe(false);
    expect(isUnambiguousRideArrival([48,72],72,0,1)).toBe(false);
    expect(isUnambiguousRideArrival([48,72],99,-1,-1)).toBe(false);
  });
});
