import { describe, expect, it } from "vitest";
import { dedupeAndSort, stopVisits, truthFor, type PosRow } from "./lib";

const c = { 10: { lat: 41.32, lon: -72.92 } };
const row = (i: number, t: number, meters: number, l: number | null = null, b = "#308"): PosRow =>
  ({ i, b, r: 15, t, lat: c[10].lat + meters / 111_000, lon: c[10].lon, h: 0, l });
const visits = (rows: PosRow[]) => stopVisits(dedupeAndSort(rows), () => [10], c).get(10) ?? [];

describe("stopVisits sequential id reissues", () => {
  it("closes a corroborated stand across a reissue instead of boarding all later riders", () => {
    const v = visits([
      row(1, 0, 300, 9), row(1, 5000, 0, 9), row(1, 30000, 0, 10),
      row(1, 600000, 0, 10), row(2, 645000, 5, 0),
      row(2, 900000, 5, 0), row(2, 960000, 300, 0),
    ]);
    expect(v).toEqual([
      { enter: 5000, exit: 960000, busName: "#308", routeId: 15, source: "curb" },
    ]);
    expect(truthFor(v, [15], 1000000, 45 * 60000)).toEqual({ kind: "none" });
  });

  it("keeps sparse feedless reissues on one track without inventing a second entry", () => {
    expect(visits([
      row(1, 0, 300), row(1, 5000, 0),
      row(2, 600000, 0), row(2, 605000, 300),
    ])).toEqual([
      { enter: 5000, exit: 605000, busName: "#308", routeId: 15, source: "curb-only" },
    ]);
  });

  it("preserves a renamed id then a sequential reissue under its new name", () => {
    expect(visits([
      row(1, 0, 300, 9, "#old"), row(1, 5000, 0, 9, "#old"),
      row(1, 10000, 0, 10, "#new"), row(2, 15000, 300, 0, "#new"),
    ])).toEqual([
      { enter: 5000, exit: 15000, busName: "#old", routeId: 15, source: "curb" },
    ]);
  });

  it("does not join known colliding ids indirectly through a reused alias", () => {
    expect(visits([
      row(1, 0, 300, null, "#alias"), row(2, 1000, 300, null, "#alias"),
      row(1, 5000, 0), row(2, 5000, 300),
      row(1, 10000, 0), row(2, 10000, 0),
      row(1, 15000, 300), row(2, 15000, 0),
      row(1, 20000, 300), row(2, 20000, 300),
    ])).toEqual([
      { enter: 5000, exit: 15000, busName: "#308", routeId: 15, source: "curb-only" },
      { enter: 10000, exit: 20000, busName: "#308", routeId: 15, source: "curb-only" },
    ]);
  });

  it("handles empty captures", () => {
    expect(visits([])).toEqual([]);
  });
  it("closes the recorded 09-04 #326 Green87 visit at the new id departure", () => {
    // Five exact raw capture rows; sequential ids 65952 -> 65973, not a same-poll collision.
    const rows: PosRow[] = [
      {"i":65952,"b":"#326","r":9,"lat":41.31275,"lon":-72.918771,"h":28,"l":127,"t":1788537855031},
      {"i":65952,"b":"#326","r":9,"lat":41.316072,"lon":-72.916237,"h":30,"l":91,"t":1788537900205},
      {"i":65952,"b":"#326","r":9,"lat":41.316836,"lon":-72.915644,"h":32,"l":87,"t":1788537915156},
      {"i":65952,"b":"#326","r":9,"lat":41.316836,"lon":-72.915644,"h":32,"l":87,"t":1788538125331},
      {"i":65973,"b":"#326","r":9,"lat":41.316904,"lon":-72.915545,"h":0,"l":0,"t":1788538315337},
    ];
    const v = stopVisits(dedupeAndSort(rows), () => [87], { 87: {"lat": 41.315906, "lon": -72.916327} }).get(87);
    expect(v).toEqual([
      { enter: 1788537900205, exit: 1788538315337, busName: "#326", routeId: 9, source: "curb" },
    ]);
    expect(truthFor(v, [9], Date.parse("2026-09-04T19:00:00Z"), 45 * 60000)).toEqual({ kind: "none" });
  });
});
