import assert from "node:assert/strict";
import fs from "node:fs";
import { predictLearnedQuery, type LearnedExport } from "./learned-evaluator";
import type { LearnedProfiles, LearnedStandQuery } from "./learned-features";

const [modelPath, profilePath, fixturePath, outputPath] = process.argv.slice(2);
if (!modelPath || !profilePath || !fixturePath || !outputPath) throw new Error("Model, profiles, fixture and output required");
const model = JSON.parse(fs.readFileSync(modelPath, "utf8")) as LearnedExport;
const profiles = JSON.parse(fs.readFileSync(profilePath, "utf8")) as LearnedProfiles;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  query: LearnedStandQuery; remaining: number[]; total: number[];
}[];
let maxErrorSec = 0;
for (const row of fixture) {
  const actual = predictLearnedQuery(model, profiles, row.query);
  for (let i = 0; i < row.remaining.length; i++) {
    maxErrorSec = Math.max(maxErrorSec,
      Math.abs(actual.remainingQuantilesSec[i]! - row.remaining[i]!),
      Math.abs(actual.totalAtArrivalQuantilesSec[i]! - row.total[i]!));
  }
}
assert.ok(maxErrorSec < 1e-9, `End-to-end Node query parity error ${maxErrorSec}`);
assert.throws(() => predictLearnedQuery(model, { ...profiles, model_sha256: "wrong" }, fixture[0]!.query), /hashes/);
assert.throws(() => predictLearnedQuery(model, { ...profiles, fit_cutoff: fixture[0]!.query.visitStartMs + 1 }, fixture[0]!.query), /cutoff/);
const result = { rows: fixture.length, maxErrorSec,
  checks: ["explicit observation query without target lookup", "model profile mismatch rejected", "future fit cutoff rejected"] };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
