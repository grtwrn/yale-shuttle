import { describe, expect, it } from "vitest";
import { isUnambiguousRideArrival, rideStopPassed } from "./rideArrival";

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

describe("rideStopPassed — the bus lapped the rider's exit", () => {
  // 2026-09-17 eval, restart recovery: persisted tracking came back to
  // "21 stops · 50 min" — the bus had gone past the alight stop and was
  // looping, but the banner read it as an ordinary countdown. The state
  // exists whenever the anchor is in the forward arc (alight, board):
  // past the drop, not yet back at the pickup.
  it("fires only in the arc between the alight stop and the pickup", () => {
    // Board at 5, alight at 8 on a 22-stop loop.
    expect(rideStopPassed(10, 5, 8, 22)).toBe(true);  // two past the exit, looping
    expect(rideStopPassed(4, 5, 8, 22)).toBe(true);   // lapped all the way back near pickup
    expect(rideStopPassed(6, 5, 8, 22)).toBe(false);  // still riding, mid-arc
    expect(rideStopPassed(7, 5, 8, 22)).toBe(false);  // one stop short of the exit
    expect(rideStopPassed(8, 5, 8, 22)).toBe(false);  // AT the exit — that is arriving
    expect(rideStopPassed(5, 5, 8, 22)).toBe(false);  // at the pickup stop itself
  });
  it("reads the wrap-around tail the same way", () => {
    // Board at 20, alight at 2 on the same loop: the tail runs 3..19.
    expect(rideStopPassed(19, 20, 2, 22)).toBe(true);
    expect(rideStopPassed(10, 20, 2, 22)).toBe(true);
    expect(rideStopPassed(21, 20, 2, 22)).toBe(false); // riding, mid-arc
    expect(rideStopPassed(2, 20, 2, 22)).toBe(false);  // at the exit
  });
  it("never fires without indices it can place", () => {
    expect(rideStopPassed(-1, 5, 8, 22)).toBe(false);
    expect(rideStopPassed(10, -1, 8, 22)).toBe(false);
    expect(rideStopPassed(10, 5, -1, 22)).toBe(false);
    expect(rideStopPassed(10, 8, 8, 22)).toBe(false); // board == alight: degenerate
    expect(rideStopPassed(10, 5, 8, 0)).toBe(false);
  });
});
