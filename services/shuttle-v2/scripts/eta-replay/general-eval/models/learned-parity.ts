import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { predictLearnedQuantiles, type LearnedExport } from "./learned-evaluator";

const [modelPath, fixturePath, outputPath] = process.argv.slice(2);
if (!modelPath || !fixturePath || !outputPath) throw new Error("model, fixture and output paths required");
const start = performance.now();
const model = JSON.parse(fs.readFileSync(modelPath, "utf8")) as LearnedExport;
const loadMs = performance.now() - start;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  features: (number | null)[][]; expected: number[][]; descriptions: string[];
};
let maxAbsoluteError = 0;
let differentValues = 0;
const elapsed: number[] = [];
for (let i = 0; i < fixture.features.length; i++) {
  const begin = performance.now();
  const actual = predictLearnedQuantiles(model, fixture.features[i]!);
  elapsed.push(performance.now() - begin);
  for (let j = 0; j < actual.length; j++) {
    const error = Math.abs(actual[j]! - fixture.expected[i]![j]!);
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    if (error > 1e-10) differentValues++;
  }
}
elapsed.sort((a, b) => a - b);
const result = { rows: fixture.features.length, quantiles: model.quantileLevels.length,
  maxAbsoluteErrorSec: maxAbsoluteError, differentValuesOver1e10: differentValues,
  loadMs, medianQueryMs: elapsed[Math.floor(elapsed.length / 2)], p95QueryMs: elapsed[Math.floor(elapsed.length * .95)],
  meanQueryMs: elapsed.reduce((a, b) => a + b, 0) / elapsed.length };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
if (differentValues > 0) throw new Error("Portable inference differs from sklearn");
