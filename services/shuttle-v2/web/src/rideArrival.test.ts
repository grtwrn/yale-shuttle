import { describe, expect, it } from "vitest";
import { isUnambiguousRideArrival, rideHeadline, rideInWindow, rideLappedExit, rideStopPassed } from "./rideArrival";

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

describe("rideInWindow — the bus is carrying this ride", () => {
  it("is the arc (board, alight]: past the pickup, up to and at the exit", () => {
    expect(rideInWindow(6, 5, 8, 22)).toBe(true);
    expect(rideInWindow(8, 5, 8, 22)).toBe(true);   // at the exit
    expect(rideInWindow(5, 5, 8, 22)).toBe(false);  // still at the pickup
    expect(rideInWindow(4, 5, 8, 22)).toBe(false);  // still coming to the pickup
    expect(rideInWindow(9, 5, 8, 22)).toBe(false);  // past the exit
    expect(rideInWindow(0, 20, 2, 22)).toBe(true);  // across the wrap
    expect(rideInWindow(-1, 5, 8, 22)).toBe(false);
    expect(rideInWindow(6, 8, 8, 22)).toBe(false);
  });
});

describe("rideLappedExit — only on evidence the bus already carried the rider", () => {
  // Position alone cannot tell a lapped exit from a bus that has not reached
  // the pickup yet: both sit in (alight, board). A ride can start before its
  // bus arrives (TripBoardingActions keeps "I'm on it" for the approaching
  // bus), and a bus one stop short of the pickup must not read "May have
  // passed" the exit it has not driven to.
  const LOOP = Array.from({ length: 22 }, (_, i) => 100 + i);
  const base = { boardIndex: 5, alightIndex: 8, stopCount: 22, rawRoute: LOOP, alightStopId: 108 };
  it("needs the bus to have been seen inside the ride's window first", () => {
    expect(rideLappedExit({ ...base, busIndex: 4, rode: false })).toBe(false); // coming to pick up
    expect(rideLappedExit({ ...base, busIndex: 10, rode: false })).toBe(false);
    expect(rideLappedExit({ ...base, busIndex: 10, rode: true })).toBe(true);
    expect(rideLappedExit({ ...base, busIndex: 4, rode: true })).toBe(true);  // lapped nearly round
    expect(rideLappedExit({ ...base, busIndex: 7, rode: true })).toBe(false); // still riding
  });
  it("does not call a stop the line visits twice passed", () => {
    // Green's West Campus pass visits 23 twice; the ride list keeps only the
    // first, so the second visit is still ahead of a bus past the first.
    const GREEN_LIST = [...new Set(GREEN)];
    const alightIndex = GREEN_LIST.indexOf(23), boardIndex = GREEN_LIST.indexOf(84);
    expect(rideLappedExit({ busIndex: GREEN_LIST.indexOf(22), boardIndex, alightIndex, stopCount: GREEN_LIST.length,
      rode: true, rawRoute: GREEN, alightStopId: 23 })).toBe(false);
    expect(rideLappedExit({ ...base, busIndex: 10, rode: true, rawRoute: undefined })).toBe(false);
  });
});

describe("rideHeadline — the on-bus banner", () => {
  const h = (o: Partial<Parameters<typeof rideHeadline>[0]>) => rideHeadline({
    busFound: true, stopsRemaining: 5, alightName: "Rosenkranz Hall", etaStr: "7 min",
    holdText: null, alightPassed: false, ...o,
  });
  it("keeps the countdown while the bus moves", () => {
    expect(h({})).toBe("5 stops · 7 min");
    expect(h({ stopsRemaining: 2 })).toBe("Get off in 2 stops! · 7 min");
    expect(h({ stopsRemaining: 1 })).toBe("Get off NEXT stop! · 7 min");
    expect(h({ stopsRemaining: 0 })).toBe("Arriving at Rosenkranz Hall");
    expect(h({ etaStr: null })).toBe("5 stops until your stop");
    expect(h({ busFound: false })).toBe("Looking for your bus…");
    expect(h({ stopsRemaining: null })).toBe("Tracking your ride");
  });
  it("names the hold where a countdown that cannot rise used to sit", () => {
    // #119: the countdown may not rise while the bus stands, so through a
    // two-minute dwell it read "2 min" and did not move (2026-09-17 eval).
    expect(h({ holdText: "holding at Prospect/Hillside" })).toBe("5 stops · holding at Prospect/Hillside");
    expect(h({ stopsRemaining: 1, holdText: "holding at Prospect/Hillside" }))
      .toBe("Get off NEXT stop! · holding at Prospect/Hillside");
    expect(h({ stopsRemaining: 0, holdText: "holding at Rosenkranz Hall" })).toBe("Arriving at Rosenkranz Hall");
  });
  it("says the exit may have been passed instead of counting a whole loop", () => {
    expect(h({ alightPassed: true, stopsRemaining: 21, etaStr: "50 min" }))
      .toBe("May have passed Rosenkranz Hall · back in 50 min");
    expect(h({ alightPassed: true, stopsRemaining: 21, etaStr: null })).toBe("May have passed Rosenkranz Hall");
  });
});

