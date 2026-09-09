/** Offline portable inference for exported sklearn 1.8 HistGB quantile trees. */
import { atomRemainingQuantiles } from "./learned-distribution";
import { learnedFeatures, type LearnedProfiles, type LearnedStandQuery } from "./learned-features";
export interface LearnedTree {
  /** Leaf: [-1,value]. Branch: [feature,threshold,left,right,missingLeft,isCategory,bitsetIndex]. */
  nodes: number[][];
  leftCategories: number[][];
}

export interface LearnedExport {
  format: "sklearn-histgb-quantiles-v1";
  sklearnVersion: string;
  modelSha256: string;
  config: { family: "duration" | "remaining"; features: string; capacity: string };
  features: string[];
  quantileLevels: number[];
  categoryMaps: Record<string, number>[];
  quantileModels: {
    baseline: number;
    knownCategories: number[][];
    categoryFeatureMap: number[];
    trees: LearnedTree[];
  }[];
}

function inCategories(bits: readonly number[], category: number): boolean {
  if (category < 0 || category > 255 || !Number.isInteger(category)) return false;
  return (((bits[category >>> 5] ?? 0) >>> (category & 31)) & 1) !== 0;
}

/** Raw learned quantiles; a duration-family caller must additionally condition on waiting. */
export function predictLearnedQuantiles(model: LearnedExport, features: readonly (number | null)[]): number[] {
  if (model.format !== "sklearn-histgb-quantiles-v1" || features.length !== model.features.length) {
    throw new Error("Unsupported learned model or feature vector");
  }
  const x = features.map(v => v === null ? NaN : v);
  for (let i = 0; i < model.categoryMaps.length; i++) {
    const raw = x[i]!;
    x[i] = Number.isFinite(raw) ? (model.categoryMaps[i]![String(Math.trunc(raw))] ?? NaN) : NaN;
  }
  const quantiles: number[] = [];
  for (const quantile of model.quantileModels) {
    let value = quantile.baseline;
    for (const tree of quantile.trees) {
      let index = 0;
      while (true) {
        const node = tree.nodes[index]!;
        const feature = node[0]!;
        if (feature === -1) {
          value += node[1]!;
          break;
        }
        const input = x[feature]!;
        let left: boolean;
        if (Number.isNaN(input)) {
          left = node[4] !== 0;
        } else if (node[5]) {
          if (inCategories(tree.leftCategories[node[6]!]!, input)) {
            left = true;
          } else if (inCategories(quantile.knownCategories[quantile.categoryFeatureMap[feature]!]!, input)) {
            left = false;
          } else {
            left = node[4] !== 0;
          }
        } else {
          // JSON null encodes the positive-infinity threshold of a split on missingness.
          left = input <= (node[1] ?? Infinity);
        }
        index = node[left ? 2 : 3]!;
      }
    }
    quantiles.push(Math.max(0, value));
  }
  return quantiles.sort((a, b) => a - b);
}

/** Same frozen per-visit law drives both the initial total and current remaining stand. */
export function predictLearnedStand(model: LearnedExport, features: readonly (number | null)[]): {
  remainingQuantilesSec: number[]; totalAtArrivalQuantilesSec: number[];
} {
  const initial = [...features];
  const elapsedIndex = model.features.indexOf("elapsed_sec");
  if (elapsedIndex < 0 || !Number.isFinite(features[elapsedIndex])) throw new Error("Missing elapsed rest age");
  const elapsed = features[elapsedIndex] as number;
  initial[elapsedIndex] = 0;
  const total = predictLearnedQuantiles(model, initial);
  if (model.config.family === "duration") {
    return { remainingQuantilesSec: atomRemainingQuantiles(total, elapsed, model.quantileLevels),
      totalAtArrivalQuantilesSec: atomRemainingQuantiles(total, 0, model.quantileLevels) };
  }
  return { remainingQuantilesSec: predictLearnedQuantiles(model, features), totalAtArrivalQuantilesSec: total };
}

/** Full Node entry point: observations and previously known departures only. */
export function predictLearnedQuery(model: LearnedExport, profiles: LearnedProfiles, query: LearnedStandQuery) {
  if (model.modelSha256 !== profiles.model_sha256) throw new Error("Profiles and model hashes do not match");
  return predictLearnedStand(model, learnedFeatures(query, profiles));
}
