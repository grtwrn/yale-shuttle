import { describe, expect, it } from "vitest";

import {
  alightNoteText,
  CLOSER_STOP_MIN_GAIN_M,
  findAlightNote,
  LOOK_AHEAD_STOPS,
} from "./alightNote";
import type { LatLon } from "./geo";

// ── Report #59, as it actually happened ─────────────────────────────────────
//
// The Red loop (route "3") between 344 Winchester and Prospect / Hillside,
// with the segment averages and dwell medians taken verbatim from
// /api/buses on 2026-09-02, and the rider's destination geocoded from the
// address in the report.

const DEST_517_PROSPECT: LatLon = { lat: 41.3264183, lon: -72.9223693 };

const RED_STOPS = [11, 146, 49, 48, 104];

const RED_COORDS: Record<number, LatLon> = {
  11: { lat: 41.324661, lon: -72.928677 }, // 344 Winchester      — 562 m out
  146: { lat: 41.325379, lon: -72.92774 }, // Winchester/Division — 463 m
  49: { lat: 41.325324, lon: -72.926572 }, // Division/Sheffield  — 371 m
  48: { lat: 41.324769, lon: -72.923522 }, // Division/Prospect   — 207 m
  104: { lat: 41.321076, lon: -72.923422 },// Prospect/Hillside   — 601 m
};

const RED_SEGS = {
  "11-146": { avg: 513.1, sd: 163.2, n: 30 },
  "146-49": { avg: 29, sd: 10, n: 31 },
  "49-48": { avg: 25, sd: 9, n: 31 },
  "48-104": { avg: 81, sd: 20, n: 31 },
};

const RED_DWELLS = {
  "11": { med: 460.1, sd: 277.2, n: 13 },  // the layover
  "146": { med: 24.9, sd: 19.5, n: 12 },
  "48": { med: 75, sd: 29, n: 13 },
};

describe("findAlightNote — report #59", () => {
  it("explains 344 Winchester by naming Division/Prospect and the layover", () => {
    const note = findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, RED_DWELLS,
    );
    expect(note).not.toBeNull();
    // The stop the rider could see on their map, not merely the next one along.
    expect(note!.closerStopId).toBe(48);
    expect(note!.metresCloser).toBeGreaterThan(300);
    // 8.6 min of riding to save ~5.4 min of walking.
    expect(note!.extraSec).toBeGreaterThan(3 * 60);
    expect(note!.layoverSec).toBeCloseTo(460.1, 1);
  });

  it("writes the rider a sentence with no jargon and minutes spelled min", () => {
    const note = findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, RED_DWELLS,
    )!;
    const text = alightNoteText(note, "Division / Prospect");
    expect(text).toContain("Division/Prospect");
    expect(text).toContain("rests about 8 min");
    expect(text).toMatch(/\bmin\b/);
    // No bare "m" as a unit of time, and nothing a rider would need to be a
    // developer to read.
    expect(text).not.toMatch(/\d\s*m\b/);
    expect(text).not.toMatch(/segment|dwell|stopId|polyline|planTrip/i);
  });
});

describe("findAlightNote — when there is nothing to explain", () => {
  it("stays silent when no later stop is meaningfully closer", () => {
    // Alight at Division/Prospect itself: everything ahead is further out.
    expect(
      findAlightNote(RED_STOPS, 48, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, RED_DWELLS),
    ).toBeNull();
  });

  it("stays silent when riding on really would be faster", () => {
    // Same geography, but the layover is gone and the hop is a normal 40 s.
    // Riding three stops now costs ~94 s and saves ~380 s of walking, so the
    // planner would have sent them there — printing a note here would
    // contradict the option above it.
    const fastSegs = { ...RED_SEGS, "11-146": { avg: 40, sd: 10, n: 30 } };
    expect(
      findAlightNote(RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, fastSegs, RED_DWELLS),
    ).toBeNull();
  });

  it("stays silent for a stop closer by less than the noticeable margin", () => {
    const coords: Record<number, LatLon> = {
      ...RED_COORDS,
      // Nudge every later stop to within a hair of 344 Winchester's distance.
      146: { lat: 41.3219, lon: -72.9269 },
      49: { lat: 41.3219, lon: -72.9269 },
      48: { lat: 41.3219, lon: -72.9269 },
      104: { lat: 41.3219, lon: -72.9269 },
    };
    const note = findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, coords, RED_SEGS, RED_DWELLS,
    );
    expect(note).toBeNull();
  });

  it("ignores a nearer stop that is still too far to walk from", () => {
    const faraway: LatLon = { lat: 41.45, lon: -72.9223693 };
    // Every stop is >1500 m from this destination, so none is a candidate
    // even though some are nearer than others.
    expect(
      findAlightNote(RED_STOPS, 11, faraway, RED_COORDS, RED_SEGS, RED_DWELLS),
    ).toBeNull();
  });

  it("returns null for a stop that isn't on the route", () => {
    expect(
      findAlightNote(RED_STOPS, 999, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, RED_DWELLS),
    ).toBeNull();
  });

  it("survives missing segment and dwell tables", () => {
    expect(() =>
      findAlightNote(RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, undefined, undefined),
    ).not.toThrow();
  });
});

describe("findAlightNote — structure", () => {
  it("drops the layover clause when the alight stop is an ordinary stop", () => {
    const ordinary = { ...RED_DWELLS, "11": { med: 45, sd: 20, n: 13 } };
    const note = findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, ordinary,
    )!;
    expect(note.layoverSec).toBeNull();
    const text = alightNoteText(note, "Division / Prospect");
    expect(text).not.toContain("rests");
    expect(text).toContain("Division/Prospect");
  });

  it("ignores a thinly-sampled dwell rather than calling it a layover", () => {
    const thin = { ...RED_DWELLS, "11": { med: 460.1, sd: 277.2, n: 2 } };
    const note = findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, thin,
    )!;
    expect(note.layoverSec).toBeNull();
  });

  it("does not look further than LOOK_AHEAD_STOPS around the loop", () => {
    // A long tail of stops far from the destination, with the nearest one
    // parked just past the horizon.
    const stops = [11, 900, 901, 902, 903, 904, 905, 48];
    const coords: Record<number, LatLon> = { 11: RED_COORDS[11], 48: RED_COORDS[48] };
    for (const sid of [900, 901, 902, 903, 904, 905]) {
      coords[sid] = { lat: 41.30, lon: -72.95 };
    }
    expect(stops.indexOf(48) - stops.indexOf(11)).toBeGreaterThan(LOOK_AHEAD_STOPS);
    expect(findAlightNote(stops, 11, DEST_517_PROSPECT, coords, {}, {})).toBeNull();
  });

  it("keeps the margin constant above zero so near-ties stay quiet", () => {
    expect(CLOSER_STOP_MIN_GAIN_M).toBeGreaterThan(0);
  });
});
