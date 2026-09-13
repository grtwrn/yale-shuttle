import fs from "node:fs";
import { registerRoutePaths } from "../web/src/anchor.ts";
import { ROUTE_LISTS, mergedRouteStops } from "../web/src/routes.ts";
import { ringForBus } from "../web/src/eta/index.ts";
const dir = process.env.PAY!;
const f = fs.readdirSync(dir).sort().filter(x => x.endsWith(".json")).at(-1)!;
const pay = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
registerRoutePaths(pay.route_paths);
const cfg = ROUTE_LISTS.find(c => c.routeIds[0] === "9")!;
const stops = mergedRouteStops(cfg, pay.routes);
const stopCoords: Record<number, any> = {};
for (const [k, v] of Object.entries(pay.stop_coords ?? {})) stopCoords[Number(k)] = Array.isArray(v) ? { lat: (v as any)[0], lon: (v as any)[1] } : v;
const bus = pay.buses.find((b: any) => String(b.route_id) === "9");
const ring: any = ringForBus(bus, stops, stopCoords)!;
console.log("published stops (" + stops.length + "):", JSON.stringify(stops));
console.log("ring keys:", Object.keys(ring).join(","));
console.log("ring.N =", ring.N, " ring.C =", ring.C);
for (const k of ["stops", "order", "repaired", "bridged", "layover"]) if (k in ring) console.log("ring." + k + ":", JSON.stringify(ring[k] instanceof Int32Array || ring[k] instanceof Uint8Array ? [...ring[k]] : ring[k]));
const names = pay.stop_names;
console.log("--- index -> stop id, published vs ring ---");
const rs: number[] | undefined = ring.stops ? [...ring.stops] : undefined;
for (let i = 0; i < Math.max(stops.length, ring.N); i++) {
  const p = stops[i], r = rs ? rs[i] : undefined;
  console.log(String(i).padStart(2), "published", String(p ?? "-").padEnd(5), (names[p!] ?? "-").slice(0, 26).padEnd(26), "| ring", String(r ?? "-").padEnd(5), (names[r!] ?? "-").slice(0, 26), p !== r ? "   <== DIFFERS" : "");
}
