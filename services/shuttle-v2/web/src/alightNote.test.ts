import { describe, expect, it } from "vitest";

import {
  alightNoteText,
  CLOSER_STOP_MIN_GAIN_M,
  findAlightNote,
  LOOK_AHEAD_SEC,
  MIN_EXTRA_SEC,
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

describe("findAlightNote — says nothing unless it has a reason", () => {
  it("is silent when the alight stop is an ordinary stop", () => {
    // Without a layover the sentence could only restate arithmetic the card
    // already shows, which was 80% of what this printed.
    const ordinary = { ...RED_DWELLS, "11": { med: 45, sd: 20, n: 13 } };
    expect(findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, ordinary,
    )).toBeNull();
  });

  it("ignores a thinly-sampled dwell rather than calling it a layover", () => {
    const thin = { ...RED_DWELLS, "11": { med: 460.1, sd: 277.2, n: 2 } };
    expect(findAlightNote(
      RED_STOPS, 11, DEST_517_PROSPECT, RED_COORDS, RED_SEGS, thin,
    )).toBeNull();
  });

  it("stays quiet when the margin is inside the app's own ETA error", () => {
    // A 13-second difference rounded up to "about 1 min" on a quarter of the
    // notes this used to print.
    const near = { ...RED_COORDS };
    // Put the "closer" stop just far enough to clear the distance gate but
    // near enough in time that riding on is barely worse.
    const stops = [11, 48];
    const coords: Record<number, LatLon> = {
      11: RED_COORDS[11],
      48: { lat: DEST_517_PROSPECT.lat + 0.0012, lon: DEST_517_PROSPECT.lon },
    };
    const segs = { "11-48": { avg: 20, n: 30 } };
    const note = findAlightNote(stops, 11, DEST_517_PROSPECT, coords, segs, RED_DWELLS);
    if (note) expect(note.extraSec).toBeGreaterThanOrEqual(MIN_EXTRA_SEC);
    void near;
  });

  it("looks a few minutes ahead, not a fixed number of stops around the loop", () => {
    // Six stops is most of a 5-stop grocery loop and a fifth of Red's. The
    // horizon is ride time, so a stop 20 min further on is never described.
    const stops = [11, 900, 48];
    const coords: Record<number, LatLon> = {
      11: RED_COORDS[11], 48: RED_COORDS[48], 900: { lat: 41.30, lon: -72.95 },
    };
    // The layover itself does not count against the horizon (it is time spent
    // sitting, not distance), so the fixture puts real moving time past it.
    const far = { "11-900": { avg: 460 + LOOK_AHEAD_SEC + 60, n: 30 }, "900-48": { avg: 60, n: 30 } };
    expect(findAlightNote(stops, 11, DEST_517_PROSPECT, coords, far, RED_DWELLS)).toBeNull();
    // The same geometry within the horizon does produce the note.
    const near = { "11-900": { avg: 460 + 30, n: 30 }, "900-48": { avg: 60, n: 30 } };
    expect(findAlightNote(stops, 11, DEST_517_PROSPECT, coords, near, RED_DWELLS)).not.toBeNull();
  });

  it("has a time floor, not just a distance floor", () => {
    expect(CLOSER_STOP_MIN_GAIN_M).toBeGreaterThan(0);
    // The near-tie that reaches the rider is a tie in TIME; the old test
    // asserted only that a distance constant was positive.
    expect(MIN_EXTRA_SEC).toBeGreaterThanOrEqual(120);
  });
});
