/** Model-free topology audit; current repair is a variant, never assumed historical. */
import fs from "node:fs";
import crypto from "node:crypto";
import { TransitNetwork } from "../../../src/network/TransitNetwork.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: topology-variants.mts <topology.json> <output.json>");
const raw = JSON.parse(fs.readFileSync(input, "utf8"));
const routes = raw.routes.map((r: any) => ({ id: r.id, name: r.name, shortName: String(r.id), color: "#000000", stops: r.stops, path: r.path }));
const net = TransitNetwork.build(raw.stops, routes);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const variants = [...net.routes.values()].map(r => {
  const published = raw.routes.find((x: any) => x.id === r.id);
  const changed = JSON.stringify(r.stops) !== JSON.stringify(published.stops);
  return { routeId: r.id, publishedPatternId: published.patternId, publishedStops: published.stops,
    currentRepairedStops: r.stops, changed,
    currentPatternId: `${r.id}:${hash(JSON.stringify([r.stops])).slice(0, 24)}`,
    publishedIndexCandidates: r.stops.map(s => published.stops.map((id: number, i: number) => id === s ? i : -1).filter((i: number) => i >= 0)) };
});
const alignFile = new URL("../../../src/network/alignStops.ts", import.meta.url);
fs.writeFileSync(output, JSON.stringify({ sourceTopologySha256: hash(fs.readFileSync(input, "utf8")),
  currentAlignerSha256: hash(fs.readFileSync(alignFile, "utf8")),
  policy: "Variants describe geometry only. No historical deployment times are inferred; ambiguous stop indices remain unresolved.", variants }, null, 2) + "\n");
console.log(JSON.stringify({ output, changedRoutes: variants.filter(v => v.changed).map(v => v.routeId) }));
