/**
 * What the berth inset actually draws, for every cell in `berths.ts`.
 *
 * The inset's defects were all of the kind you cannot argue about — a zoom set
 * by a pair's compass bearing rather than its length, a box whose long edge ran
 * across the fact it was showing, labels clipped at an edge. This prints the
 * numbers that decide them, so a redesign is a measurement and not a taste:
 *
 *   npx tsx scripts/berth-inset-measure.ts [--payload buses.json] [--height 160]
 *
 * With no --payload it reads the checked-in `/api/buses` fixture, so it runs
 * offline and cannot drift from what the tests assert. Widths 316 / 346 / 386
 * are the inset's own box inside a 360 / 390 / 430 px phone.
 *
 * The reading that chose the current design (2026-09-10): every cell lands on
 * ONE resolution, 0.45 m/px at tile zoom 18; the road lies along the long edge
 * in all ten; and the direction along it is whichever of the two keeps the
 * basemap upright — seven drive right, three (300 George St, Church / George,
 * Chapel / Dwight) drive left. "Past" is therefore the way the ARROW points,
 * which is the invariant `berthThumb.test.ts` pins.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BERTHS } from "../web/src/berths";
import { buildBerthThumb } from "../web/src/berthThumb";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const payloadPath = arg("payload") ?? resolve(import.meta.dirname, "../web/src/__fixtures__/buses-payload.json");
const HEIGHT = Number(arg("height") ?? 160);
const WIDTHS = (arg("widths") ?? "316,346,386").split(",").map(Number);

const P = JSON.parse(readFileSync(payloadPath, "utf8")) as {
  stop_names?: Record<string, string>;
  stop_coords: Record<string, { lat: number; lon: number } | [number, number]>;
  route_paths: Record<string, [number, number][]>;
};
const coord = (id: number) => {
  const v = P.stop_coords[String(id)];
  return Array.isArray(v) ? { lat: v[0], lon: v[1] } : v;
};
const rad = (d: number) => (d * Math.PI) / 180;

console.log(`payload ${payloadPath}\nbox height ${HEIGHT}, widths ${WIDTHS.join("/")}\n`);

// The fact that chose the rotation: which axis the offset lies on.
console.log("bearing of each offset, and the box height a NORTH-UP inset would need");
for (const b of BERTHS) {
  const s = coord(b.stopId);
  const brg = (Math.atan2((b.lon - s.lon) * Math.cos(rad(s.lat)), b.lat - s.lat) * 180) / Math.PI;
  const offAxis = Math.min(Math.abs(((brg % 180) + 180) % 180), 180 - Math.abs(((brg % 180) + 180) % 180));
  const dNS = Math.abs(b.lat - s.lat) * 111_320;
  console.log(
    `  ${String(b.stopId).padStart(4)}/${String(b.routeId).padEnd(3)} ${(P.stop_names?.[String(b.stopId)] ?? "").slice(0, 22).padEnd(22)}`
    + ` ${Math.hypot((b.lon - s.lon) * 111_320 * Math.cos(rad(s.lat)), (b.lat - s.lat) * 111_320).toFixed(1).padStart(6)} m`
    + ` bearing ${((brg + 360) % 360).toFixed(0).padStart(3)}° (${offAxis.toFixed(0).padStart(2)}° off the N-S axis)`
    + ` north-up height ${Math.ceil(dNS / 0.45 / 0.86 + 48).toString().padStart(4)} px`,
  );
}

for (const width of WIDTHS) {
  console.log(`\n=== ${width} x ${HEIGHT} ===`);
  for (const b of BERTHS) {
    const t = buildBerthThumb(coord(b.stopId), { lat: b.lat, lon: b.lon },
      (P.route_paths[String(b.routeId)] ?? []).map(([lat, lon]) => ({ lat, lon })),
      { width, height: HEIGHT, labelHalfW: 44 });
    const dots = [t.published, t.berth].map((p) => Math.min(p.x, width - p.x, p.y, HEIGHT - p.y));
    const labels = [t.publishedLabel, t.berthLabel].map((l) => Math.min(l.x - 44, width - (l.x + 44), l.y - 11, HEIGHT - l.y));
    console.log(
      `  ${String(b.stopId).padStart(4)}/${String(b.routeId).padEnd(3)} z${t.zoom} ${t.metresPerPx.toFixed(3)} m/px`
      + ` span ${Math.hypot(t.berth.x - t.published.x, t.berth.y - t.published.y).toFixed(0).padStart(3)} px`
      + ` travel ${t.travelsRight ? "->" : "<-"} expected ${t.berth.x > t.published.x ? "RIGHT" : "LEFT "} (offset ${String(b.offsetM).padStart(4)} m)`
      + ` dot margin ${Math.min(...dots).toFixed(0).padStart(3)} label clear ${Math.min(...labels).toFixed(0).padStart(3)}`
      + ` road ${String(t.road.length).padStart(2)} pts arrow ${t.arrow ? `${t.arrow.deg.toFixed(0)}°` : "NONE"}`
      + ` link ${t.publishedLink ? "yes" : "no "} bar ${t.scale.m} m/${t.scale.px.toFixed(0)} px tiles ${t.tiles.length}`,
    );
  }
}
