import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// bannerzindex20261002: on the ride page the map scrolls under the sticky
// OnBusBanner. Leaflet's controls (z-index 1000 in leaflet.css) and the 📍
// button (1000) outranked the banner (500), so once a rider scrolled the stop
// list the zoom control covered the headline and a tap on "Done" hit "Show my
// location" instead. No DOM library here, so this pins the stacking rule in the
// source (same approach as Banners.test.tsx); scripts/ride-banner-stacking-check.mjs
// checks the built page in a real browser.
const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
const leafletCss = readFileSync(new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url), "utf8");

const between = (start: string, end: string) => {
  const from = src.indexOf(start), to = src.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
};
const rideMap = between("const RideRouteMap: FC<", "const RideStopList: FC<");
const banner = between("const OnBusBanner: FC<", "const TransitMap: FC");

describe("ride page stacking under the sticky ride banner", () => {
  const bannerZ = Number(/position: "sticky", top: 0, zIndex: (\d+)/.exec(banner)?.[1]);
  const leafletControlZ = Number(/\.leaflet-top,\s*\.leaflet-bottom\s*\{[^}]*z-index:\s*(\d+)/.exec(leafletCss)?.[1]);
  const rideMapZ = [...rideMap.matchAll(/[^\w]zIndex: (\d+)/g)].map((m) => Number(m[1]));

  it("has map layers that would outrank the banner on their own", () => {
    expect(bannerZ).toBeGreaterThan(0);
    expect(leafletControlZ).toBeGreaterThan(bannerZ);
    expect(Math.max(...rideMapZ)).toBeGreaterThan(bannerZ);
  });

  it("keeps the ride map and its 📍 button in their own stacking context", () => {
    const wrapper = /<div style=\{\{([^}]*)\}\}>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<div ref=\{ref\}/.exec(rideMap);
    expect(wrapper).not.toBeNull();
    expect(wrapper![1]).toMatch(/isolation: "isolate"/);
  });
});
