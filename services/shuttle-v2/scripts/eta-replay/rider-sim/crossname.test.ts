import { expect, it } from "vitest";
import { dedupeAndSort, stopVisits, type PosRow } from "./lib";

const c = { 10: { lat: 41.32, lon: -72.92 } };
const row = (i: number, t: number, meters: number, b: string, l: number | null = null): PosRow =>
  ({ i, b, r: 15, t, lat: c[10].lat + meters / 111_000, lon: c[10].lon, h: 0, l });
const visit = (rows: PosRow[]) => stopVisits(rows, () => [10], c).get(10) ?? [];
const ev = (enter: number, exit: number, busName: string) =>
  ({ enter, exit, busName, routeId: 15, source: "curb-only" });
const fourRows = () => [
  row(2, 0, 300, "#alias"), row(3, 1000, 300, "#alias"),
  row(2, 5000, 300, "#A", 9), row(3, 5000, 300, "#B", 10),
];

it("does not invent a served flip from four aliased rows reporting under different names", () => {
  // Each id's non-null served-stop value is constant and all fixes are 300 m
  // away. The earlier sequential alias cannot override their shared poll.
  expect(visit(fourRows())).toEqual([]);
});

it("isolates cross-name shared polls even when the sequential alias comes afterwards", () => {
  expect(visit(dedupeAndSort([
    ...[0, 5000, 10000].flatMap(t => [row(2, t, 300, "#A", 9), row(3, t, 300, "#B", 10)]),
    row(2, 20000, 300, "#alias"), row(3, 21000, 300, "#alias"),
  ]))).toEqual([]);
});

it("does not let a later rename join ids that previously reported in the same polls", () => {
  expect(visit(dedupeAndSort([
    ...[0, 5000, 10000].flatMap(t => [row(1, t, 300, "#A", 9), row(2, t, 300, "#B", 10)]),
    row(1, 20000, 300, "#B", 9),
  ]))).toEqual([]);
});

it.each([0, 80])("does not borrow cross-name rearm while a bus holds at %i m", holdM => {
  const rows = [
    row(2, -2000, 300, "#alias"), row(3, -1000, 300, "#alias"),
    ...[0, 5000, 10000, 15000, 20000].flatMap(t => [
      row(2, t, t === 5000 ? 0 : t === 10000 ? holdM : 300, "#A"),
      row(3, t, t === 10000 ? 0 : t === 15000 ? holdM : 300, "#B"),
    ]),
  ];
  // At 80 m the bus has left the entry radius but has not crossed rearm.
  expect(visit(dedupeAndSort(rows))).toEqual([ev(5000, 15000, "#A"), ev(10000, 20000, "#B")]);
});

it("isolates cross-name collisions in either poll ordering including duplicate observations", () => {
  const rows = fourRows();
  for (const poll of [rows.slice(2), rows.slice(2).reverse()]) {
    const ordered = [...rows.slice(0, 2), ...poll];
    expect(visit(ordered)).toEqual([]);
    expect(visit(ordered.flatMap(p => [p, { ...p }]))).toEqual([]);
  }
});

it("isolates every aliased component concurrently reporting under distinct names", () => {
  const rows = [
    row(1, -4000, 300, "#x"), row(2, -3000, 300, "#x"),
    row(3, -2000, 300, "#y"), row(4, -1000, 300, "#y"),
    ...[0, 5000, 10000, 15000, 20000, 25000, 30000].flatMap(t =>
      [4, 3, 2, 1].map(id => row(id, t, t >= id * 5000 && t < id * 5000 + 10000 ? 0 : 300, "#own" + id))),
  ];
  expect(visit(dedupeAndSort(rows))).toEqual([
    ev(5000, 15000, "#own1"), ev(10000, 20000, "#own2"),
    ev(15000, 25000, "#own3"), ev(20000, 30000, "#own4"),
  ]);
});
