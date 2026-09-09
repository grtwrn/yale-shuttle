import assert from "node:assert/strict";
import fs from "node:fs";
import { atomRemainingQuantiles } from "./learned-distribution";
import { atomQuantiles, analyticResidual } from "./analytic-distribution";

const [fixturePath, outputPath] = process.argv.slice(2);
if (!fixturePath || !outputPath) throw new Error("Fixture and output paths required");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {q:number[];elapsed:number;expected:number[]}[];
let maxPythonError = 0, maxAnalyticError = 0, analyticCompared = 0;
for (const row of fixture) {
  const actual = atomRemainingQuantiles(row.q, row.elapsed);
  for (let i = 0; i < actual.length; i++) {
    maxPythonError = Math.max(maxPythonError, Math.abs(actual[i]! - row.expected[i]!));
  }
  const dist = atomQuantiles(row.q);
  if (1 - dist.cdf(row.elapsed) > 1e-6) {
    const residual = analyticResidual(dist, row.elapsed);
    for (let i = 0; i < actual.length; i++) {
      maxAnalyticError = Math.max(maxAnalyticError, Math.abs(actual[i]! - residual((i + .5) / actual.length)));
    }
    analyticCompared++;
  }
}
assert.ok(maxPythonError < 1e-9, `Python parity error ${maxPythonError}`);
assert.ok(maxAnalyticError < 1e-6, `Analytic law parity error ${maxAnalyticError}`);
const slot = Array(19).fill(600) as number[];
assert.equal(atomRemainingQuantiles(slot, 100)[9], 500);
assert.ok(atomRemainingQuantiles(slot, 600)[9]! > 0);
assert.deepEqual(atomRemainingQuantiles(slot, 600), atomRemainingQuantiles(slot, 1e9));
const pass = [...Array(12).fill(0), ...Array(7).fill(120)] as number[];
assert.equal(atomRemainingQuantiles(pass, 0)[9], 120);
assert.ok(Math.abs(atomRemainingQuantiles(pass, 0)[9]! - atomRemainingQuantiles(pass, 1e-9)[9]!) < 1e-8);
const result = { rows: fixture.length, maxPythonErrorSec: maxPythonError,
  analyticCompared, maxAnalyticErrorSec: maxAnalyticError,
  semanticChecks: ["fixed positive atom counts down", "known-standing removes zero mass", "continuous at r=0", "overdue tail stays nonzero"] };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
