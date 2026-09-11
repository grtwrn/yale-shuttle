import { describe, expect, it } from "vitest";

import {
  CURRENT_LOCATION_TEXT,
  isCurrentLocationText,
  unresolvedEndpoint,
  unresolvedEndpointHint,
} from "./endpoints";

const resolved = (text: string) => ({ text, hasCoord: true });
const typed = (text: string) => ({ text, hasCoord: false });
const empty = { text: "", hasCoord: false };
const gps = { text: CURRENT_LOCATION_TEXT, hasCoord: false };

describe("isCurrentLocationText", () => {
  it("treats blank and the 📍 sentinel as 'not a typed place'", () => {
    expect(isCurrentLocationText("")).toBe(true);
    expect(isCurrentLocationText(CURRENT_LOCATION_TEXT)).toBe(true);
    expect(isCurrentLocationText("517 Prospect St")).toBe(false);
  });
});

describe("unresolvedEndpoint", () => {
  // Report #84: a start typed after a geolocation timeout, never resolved.
  it("names the start the rider typed but never picked", () => {
    expect(unresolvedEndpoint(typed("517 Prospect St"), resolved("Old Campus"))).toBe("from");
  });

  it("says nothing when both ends are settled", () => {
    expect(unresolvedEndpoint(resolved("517, Prospect Street"), resolved("Old Campus"))).toBeNull();
  });

  it("says nothing about an empty box — that is the home screen, not a mistake", () => {
    expect(unresolvedEndpoint(empty, empty)).toBeNull();
    expect(unresolvedEndpoint(empty, resolved("Old Campus"))).toBeNull();
  });

  it("says nothing while the start is 📍 Current location awaiting a fix", () => {
    // The sentinel is not a typed place; the origin follows GPS instead.
    expect(unresolvedEndpoint(gps, resolved("Old Campus"))).toBeNull();
  });

  it("names the destination first when both are pending — no trip without one", () => {
    expect(unresolvedEndpoint(typed("517 Prospect St"), typed("Old Camp"))).toBe("to");
  });

  it("ignores whitespace-only text", () => {
    expect(unresolvedEndpoint({ text: "   ", hasCoord: false }, resolved("Old Campus"))).toBeNull();
  });
});

describe("unresolvedEndpointHint", () => {
  it("asks the rider to choose, in one short line per end", () => {
    expect(unresolvedEndpointHint("from")).toMatch(/start/i);
    expect(unresolvedEndpointHint("to")).toMatch(/destination/i);
    for (const which of ["from", "to"] as const) {
      // One line on a phone: the results area is 358 px wide at 390 px.
      expect(unresolvedEndpointHint(which).length).toBeLessThanOrEqual(48);
      expect(unresolvedEndpointHint(which)).not.toMatch(/error|failed/i);
    }
  });
});
