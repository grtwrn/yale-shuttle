import { describe, expect, it } from "vitest";

import {
  CURRENT_LOCATION_TEXT,
  cancelFromEdit,
  effectiveOrigin,
  isCurrentLocationText,
  unresolvedStartText,
} from "./originEdit";

const PROSPECT = { lat: 41.3264183, lon: -72.9223693 };
const GPS = { lat: 41.3083, lon: -72.9279 };

describe("effectiveOrigin", () => {
  it("uses the coordinate the rider picked", () => {
    expect(effectiveOrigin({ picked: PROSPECT, text: "517, Prospect Street", gps: GPS }))
      .toEqual(PROSPECT);
  });

  it("falls back to GPS only while nothing is typed", () => {
    expect(effectiveOrigin({ picked: null, text: "", gps: GPS })).toEqual(GPS);
    expect(effectiveOrigin({ picked: null, text: "517 Prospect", gps: GPS })).toBeNull();
  });

  it("has no origin when there is neither a pick nor a fix", () => {
    expect(effectiveOrigin({ picked: null, text: "", gps: null })).toBeNull();
  });
});

describe("unresolvedStartText", () => {
  const base = { hasDestination: true, origin: null, text: "", busy: false };

  it("offers back a start that was typed but never committed", () => {
    // Report #84: the rider typed an address, dismissed the suggestion list,
    // and the trip screen fell back to the first-run home page in silence.
    expect(unresolvedStartText({ ...base, text: "517 Prospect St" }))
      .toBe("517 Prospect St");
  });

  it("trims what it offers back", () => {
    expect(unresolvedStartText({ ...base, text: "  Payne Whitney Gym " }))
      .toBe("Payne Whitney Gym");
  });

  it("says nothing while a lookup is still running", () => {
    // The spinner already answers "why is nothing here yet".
    expect(unresolvedStartText({ ...base, text: "517 Prospect St", busy: true }))
      .toBeNull();
  });

  it("says nothing once the start has resolved", () => {
    expect(unresolvedStartText({ ...base, text: "517, Prospect Street", origin: PROSPECT }))
      .toBeNull();
  });

  it("says nothing before a destination is set", () => {
    expect(unresolvedStartText({ ...base, hasDestination: false, text: "517 Prospect St" }))
      .toBeNull();
  });

  it("says nothing for the current-location placeholder", () => {
    expect(unresolvedStartText({ ...base, text: CURRENT_LOCATION_TEXT })).toBeNull();
    expect(unresolvedStartText({ ...base, text: "" })).toBeNull();
    expect(unresolvedStartText({ ...base, text: "   " })).toBeNull();
  });
});

describe("cancelFromEdit", () => {
  it("puts back the start the rider had before they opened the editor", () => {
    expect(cancelFromEdit({
      previousText: "517, Prospect Street", previousOrigin: PROSPECT, gps: GPS,
    })).toEqual({ text: "517, Prospect Street", origin: PROSPECT });
  });

  it("falls back to current location when there was nothing to restore", () => {
    expect(cancelFromEdit({ previousText: "", previousOrigin: null, gps: GPS }))
      .toEqual({ text: "", origin: GPS });
  });

  it("does not restore a label whose coordinate was never resolved", () => {
    // A half-typed previous value is not a start; going back to it would
    // re-create the dead end cancelling is supposed to escape.
    expect(cancelFromEdit({ previousText: "517 Prosp", previousOrigin: null, gps: null }))
      .toEqual({ text: "", origin: null });
  });
});

describe("isCurrentLocationText", () => {
  it("treats blank and the placeholder alike", () => {
    expect(isCurrentLocationText("")).toBe(true);
    expect(isCurrentLocationText(CURRENT_LOCATION_TEXT)).toBe(true);
    expect(isCurrentLocationText("Old Campus")).toBe(false);
  });
});
