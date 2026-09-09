import assert from "node:assert/strict";
import fs from "node:fs";
import { predictLearnedStand, type LearnedExport } from "./learned-evaluator";

const [modelPath, fixturePath, outputPath] = process.argv.slice(2);
if (!modelPath || !fixturePath || !outputPath) throw new Error("Model, fixture and output paths required");
const model = JSON.parse(fs.readFileSync(modelPath, "utf8")) as LearnedExport;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  features: (number | null)[]; remaining: number[]; total: number[];
}[];
let maxErrorSec = 0;
for (const row of fixture) {
  const actual = predictLearnedStand(model, row.features);
  for (let i = 0; i < row.remaining.length; i++) {
    maxErrorSec = Math.max(maxErrorSec,
      Math.abs(actual.remainingQuantilesSec[i]! - row.remaining[i]!),
      Math.abs(actual.totalAtArrivalQuantilesSec[i]! - row.total[i]!));
  }
}
assert.ok(maxErrorSec < 1e-9, `Runtime distribution parity error ${maxErrorSec}`);
const result = { rows: fixture.length, maxErrorSec, law: "atom-preserving-log-survival-v1" };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
