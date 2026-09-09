import assert from "node:assert/strict";
import fs from "node:fs";
import { learnedFeatures, type LearnedProfiles, type LearnedStandQuery } from "./learned-features";

const [profilePath, fixturePath, outputPath] = process.argv.slice(2);
if (!profilePath || !fixturePath || !outputPath) throw new Error("Profiles, fixture and output paths required");
const profiles = JSON.parse(fs.readFileSync(profilePath, "utf8")) as LearnedProfiles;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { query: LearnedStandQuery; expected: (number | null)[] }[];
let maxError = 0;
for (const row of fixture) {
  const actual = learnedFeatures(row.query, profiles);
  for (let i = 0; i < actual.length; i++) {
    if (row.expected[i] === null) assert.ok(Number.isNaN(actual[i]));
    else maxError = Math.max(maxError, Math.abs(actual[i]! - row.expected[i]!));
  }
  const altered = { ...row.query, priorDepartures: [...(row.query.priorDepartures ?? []), {
    routeId: row.query.routeId, routePatternId: row.query.routePatternId,
    stopId: row.query.stopId, stopIndex: row.query.stopIndex, busKey: row.query.busKey,
    day: row.query.serviceDay!, pinnedAt: row.query.visitStartMs, departedAt: row.query.issuedAt + 600000,
    knownAt: row.query.issuedAt + 700000, outcome: "stopped",
  }] };
  assert.deepEqual(learnedFeatures(altered, profiles), actual);
}
assert.ok(maxError < 1e-9, `Feature parity error ${maxError}`);
const result = { rows: fixture.length, maxError, futureLabelChangesFeatures: false };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
