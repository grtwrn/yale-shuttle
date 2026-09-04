import { describe, expect, it } from "vitest";

import { BUS_HERE_BG, BUS_HERE_COLOR, stopRowHighlight } from "./stopRow";

const RED = "#C62828";

describe("stopRowHighlight", () => {
  it("bands the bus's stop in green", () => {
    const h = stopRowHighlight(true, false, RED);
    expect(h.background).toBe(BUS_HERE_BG);
    expect(h.banded).toBe(true);
    expect(h.color).toBe(BUS_HERE_COLOR);
  });

  it("still bands BOARD and GET OFF in the route colour", () => {
    const h = stopRowHighlight(false, true, RED);
    expect(h.background).toBe(`${RED}1f`);
    expect(h.banded).toBe(true);
    expect(h.color).toBe("#202124");
  });

  it("leaves an ordinary stop unbanded", () => {
    const h = stopRowHighlight(false, false, RED);
    expect(h.background).toBe("transparent");
    expect(h.banded).toBe(false);
  });

  it("gives the bus the row when it is sitting at BOARD", () => {
    const h = stopRowHighlight(true, true, RED);
    expect(h.background).toBe(BUS_HERE_BG);
    // the BOARD label keeps the row's near-black name beside it
    expect(h.color).toBe("#202124");
  });

  it("does not reuse the GPS dot's blue", () => {
    // Blue is the rider's own position everywhere else in the app; the bus
    // must not borrow it. (makeYouIcon: #1976D2)
    expect(BUS_HERE_COLOR.toLowerCase()).not.toBe("#1976d2");
    expect(BUS_HERE_BG).toContain("46,125,50");
  });

  it("never returns a background that would swallow the route colour band", () => {
    // Two different routes must still band their ends differently.
    expect(stopRowHighlight(false, true, "#C62828").background)
      .not.toBe(stopRowHighlight(false, true, "#2E7D32").background);
  });
});
