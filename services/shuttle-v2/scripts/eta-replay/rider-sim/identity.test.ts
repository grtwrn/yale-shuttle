import { describe, expect, it } from "vitest";
import { dedupeAndSort, stopVisits, type PosRow } from "./lib";

const c = { 10: { lat: 41.32, lon: -72.92 } };
const row = (i: number, t: number, meters: number, l: number | null = null, b = "#308"): PosRow =>
  ({ i, b, r: 15, t, lat: c[10].lat + meters / 111_000, lon: c[10].lon, h: 0, l });
const visits = (rows: PosRow[]) => stopVisits(dedupeAndSort(rows), () => [10], c).get(10) ?? [];

describe("stopVisits physical track identity", () => {
  it("does not re-arm one bus with another same-name bus's distant fix", () => {
    expect(visits([
      row(1, 0, 300), row(2, 0, 300),
      row(1, 5000, 0), row(2, 5000, 300),
      row(1, 10000, 0), row(2, 10000, 0),
      row(1, 15000, 300), row(2, 15000, 0),
      row(1, 20000, 300), row(2, 20000, 300),
    ])).toEqual([
      { enter: 5000, exit: 15000, busName: "#308", routeId: 15, source: "curb-only" },
      { enter: 10000, exit: 20000, busName: "#308", routeId: 15, source: "curb-only" },
    ]);
  });

  it("does not borrow another physical bus's served flip or closest approach", () => {
    expect(visits([
      row(1, 0, 300, 9), row(2, 0, 300, 9),
      row(1, 5000, 0, 9), row(2, 5000, 100, 9),
      row(1, 10000, 300, 9), row(2, 10000, 90, 10),
      row(1, 15000, 300, 9), row(2, 15000, 300, 10),
    ])).toEqual([
      { enter: 10000, exit: 15000, busName: "#308", routeId: 15, source: "feed" },
    ]);
  });

  it("does not invent transitions between two buses' initial last-stop values", () => {
    expect(visits([
      row(1, 0, 300, 9), row(2, 0, 300, 10),
      row(1, 5000, 300, 9), row(2, 5000, 300, 10),
    ])).toEqual([]);
  });

  it("keeps feedless geometry independent of a same-name bus with feed history", () => {
    expect(visits([
      row(1, 0, 300), row(2, 0, 300, 9),
      row(1, 5000, 0), row(2, 5000, 300, 9),
      row(1, 10000, 300), row(2, 10000, 300, 9),
    ])).toEqual([
      { enter: 5000, exit: 10000, busName: "#308", routeId: 15, source: "curb-only" },
    ]);
  });

  it("retains the display name at entry when the same bus is renamed during a visit", () => {
    expect(visits([
      row(1, 0, 300, 9, "#old"), row(1, 5000, 0, 9, "#old"),
      row(1, 10000, 0, 10, "#new"), row(1, 15000, 300, 10, "#new"),
    ])).toEqual([
      { enter: 5000, exit: 15000, busName: "#old", routeId: 15, source: "curb" },
    ]);
  });

  it("does not manufacture served flips in recorded simultaneous #308 tracks", () => {
    // 2026-09-10 raw_positions.jsonl.gz, first three collision polls. Exact
    // capture fields; ids 66174 (route 15) and 66183 (route 19) each hold
    // their own initial last_stop_id. Interleaving 156/0 is NOT a transition.
    const rows: PosRow[] = [
      {"i": 66174, "b": "#308", "r": 15, "lat": 41.311004, "lon": -72.93079, "h": 113, "l": 156, "t": 1789059455463},
      {"i": 66183, "b": "#308", "r": 19, "lat": 41.323603, "lon": -72.929131, "h": 0, "l": 0, "t": 1789059455463},
      {"i": 66174, "b": "#308", "r": 15, "lat": 41.311004, "lon": -72.93079, "h": 113, "l": 156, "t": 1789059460483},
      {"i": 66183, "b": "#308", "r": 19, "lat": 41.323603, "lon": -72.929131, "h": 0, "l": 0, "t": 1789059460483},
      {"i": 66174, "b": "#308", "r": 15, "lat": 41.310882, "lon": -72.930421, "h": 113, "l": 156, "t": 1789059465521},
      {"i": 66183, "b": "#308", "r": 19, "lat": 41.323603, "lon": -72.929131, "h": 0, "l": 0, "t": 1789059465521},
    ];
    expect(stopVisits(dedupeAndSort(rows), () => [156], { 156: {"lat": 41.31162, "lon": -72.9328} }).size).toBe(0);
  });
});
