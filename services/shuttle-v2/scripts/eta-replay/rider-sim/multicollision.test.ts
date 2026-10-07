import { describe, expect, it } from "vitest";
import { dedupeAndSort, stopVisits, type PosRow } from "./lib";

const c = { 10: { lat: 41.32, lon: -72.92 } };
const row = (i: number, t: number, meters: number, l: number | null = null, b = "#308"): PosRow =>
  ({ i, b, r: 15, t, lat: c[10].lat + meters / 111_000, lon: c[10].lon, h: 0, l });
const visit = (rows: PosRow[]) => stopVisits(rows, () => [10], c).get(10) ?? [];
const ev = (enter: number, exit: number) =>
  ({ enter, exit, busName: "#308", routeId: 15, source: "curb-only" });
const pairs = (ids: number[]): Array<[number, number]> =>
  ids.flatMap((a, i) => ids.slice(i + 1).map((b): [number, number] => [a, b]));
const permutations = (ids: number[]): number[][] => ids.length === 0 ? [[]] :
  ids.flatMap((id, i) => permutations(ids.filter((_, j) => i !== j)).map(rest => [id, ...rest]));
const geometry = (ids: number[], a: number, b: number): PosRow[] => [
  row(a, -2000, 300, null, "#alias"), row(b, -1000, 300, null, "#alias"),
  ...[0, 5000, 10000, 15000, 20000].flatMap(t => ids.map(id =>
    row(id, t, (id === a && (t === 5000 || t === 10000)) ||
      (id === b && (t === 10000 || t === 15000)) ? 0 : 300))),
];

for (const n of [3, 4]) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  describe(String(n) + "-way same-poll collisions", () => {
    it.each(pairs(ids))("does not borrow rearm between aliased ids %i and %i", (a, b) => {
      expect(visit(dedupeAndSort(geometry(ids, a, b)))).toEqual([
        ev(5000, 15000), ev(10000, 20000),
      ]);
    });

    it.each(pairs(ids))("does not invent served flips between aliased ids %i and %i", (a, b) => {
      // Each id's served-stop value is constant; every fix is outside 45 m.
      // A common earlier alias cannot override their later same-poll collision.
      expect(visit(dedupeAndSort([
        row(a, 0, 300, 9, "#alias"), row(b, 1000, 300, 10, "#alias"),
        ...ids.map(id => row(id, 5000, 300, id === b ? 10 : 9)),
      ]))).toEqual([]);
    });

    it("isolates non-first aliased ids in every within-poll ordering", () => {
      // stopVisits consumes time-ordered rows; no assumption about id order
      // inside a poll should affect the complete set of collision evidence.
      for (const order of permutations(ids)) {
        expect(visit(geometry(order, 2, 3)), "poll order " + order.join(",")).toEqual([
          ev(5000, 15000), ev(10000, 20000),
        ]);
      }
    });
  });
}

it("isolates every repeated root, not just the first aliased component in a poll", () => {
  const rows = [
    row(1, -4000, 300, null, "#a"), row(2, -3000, 300, null, "#a"),
    row(3, -2000, 300, null, "#b"), row(4, -1000, 300, null, "#b"),
    ...[0, 5000, 10000, 15000, 20000, 25000, 30000].flatMap(t =>
      [1, 2, 3, 4].map(id => row(id, t, t >= id * 5000 && t < id * 5000 + 10000 ? 0 : 300))),
  ];
  expect(visit(dedupeAndSort(rows))).toEqual([
    ev(5000, 15000), ev(10000, 20000), ev(15000, 25000), ev(20000, 30000),
  ]);
});

it("does not treat duplicate observations of one id as distinct colliders", () => {
  const rows = [row(1, 0, 300), row(1, 5000, 0), row(2, 10000, 0), row(2, 15000, 300)];
  expect(visit(rows.flatMap(p => [p, { ...p }]))).toEqual([ev(5000, 15000)]);
});
