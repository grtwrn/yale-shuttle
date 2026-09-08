import { describe, expect, it } from "vitest";

import { chipRemainder, restKey, type ChipFloors } from "./standChip";

describe("the chip's remainder never climbs inside one rest", () => {
  it("follows the number down and holds it against a rise", () => {
    const floors: ChipFloors = new Map();
    const rest = restKey(11, 1_000_000, 60);
    expect(chipRemainder(floors, "#304:11", rest, 240)).toBe(240);
    expect(chipRemainder(floors, "#304:11", rest, 180)).toBe(180);
    // The table's own tail hazard flattens and the residual median rises;
    // the chip must not, because the countdown beside it may not (#119).
    expect(chipRemainder(floors, "#304:11", rest, 300)).toBe(180);
    expect(chipRemainder(floors, "#304:11", rest, 120)).toBe(120);
  });

  it("starts over when the rest does", () => {
    const floors: ChipFloors = new Map();
    chipRemainder(floors, "#304:11", restKey(11, 1_000_000, 600), 60);
    // The bus pulls out and stands again: a new clock, so a new floor.
    expect(chipRemainder(floors, "#304:11", restKey(11, 2_000_000, 10), 300)).toBe(300);
  });

  it("keeps buses and stops apart", () => {
    const floors: ChipFloors = new Map();
    const rest = restKey(11, 1_000_000, 60);
    chipRemainder(floors, "#304:11", rest, 60);
    expect(chipRemainder(floors, "#309:11", rest, 400)).toBe(400);
    expect(chipRemainder(floors, "#304:12", rest, 400)).toBe(400);
  });

  it("is unclamped with a fresh store, so a replay sees the raw number", () => {
    expect(chipRemainder(new Map(), "#304:11", "r", 300)).toBe(300);
    expect(chipRemainder(new Map(), "#304:11", "r", -5)).toBe(0);
  });

  it("does not read a second's jitter in the rendered clock as a new rest", () => {
    // The same rest seen 1 s later with 1 s more elapsed is one rest.
    expect(restKey(11, 1_000_000, 60)).toBe(restKey(11, 1_001_000, 61));
  });
});
