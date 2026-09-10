import { describe, expect, it } from "vitest";
import { rideMapStopSequence } from "./rideMapFocus";
const GREEN = [78,84,89,77,94,143,144,133,88,92,81,26,25,23,22,23,24,25,127,26,80,91,87];
const PURPLE = [10,9,1,122,127,26,25,24,23,22,23,24,25,26,72];
describe("initial onboard map focus", () => {
  it("frames the observed local Green ride without the West Campus detour", () => {
    expect(rideMapStopSequence(GREEN,143,81)).toEqual([143,144,133,88,92,81]);
  });
  it("keeps the forward leg across the route boundary", () => {
    expect(rideMapStopSequence(GREEN,91,84)).toEqual([91,87,78,84]);
  });
  it("falls back for every repeated endpoint instead of choosing the wrong pass", () => {
    for (const route of [GREEN,PURPLE]) for (const id of new Set(route)) {
      if (route.indexOf(id) === route.lastIndexOf(id)) continue;
      expect(rideMapStopSequence(route,route[0]!,id)).toBeNull();
      expect(rideMapStopSequence(route,id,route[route.length-1]!)).toBeNull();
    }
  });
  it("preserves repeated intermediate stops on an unambiguous longer ride", () => {
    expect(rideMapStopSequence(PURPLE,127,72)).toEqual(PURPLE.slice(4));
  });
  it("declines missing endpoints and zero-length or full-loop ambiguity", () => {
    expect(rideMapStopSequence(undefined,1,2)).toBeNull();
    expect(rideMapStopSequence([1,2],1,3)).toBeNull();
    expect(rideMapStopSequence([1,2],1,1)).toBeNull();
  });
});
