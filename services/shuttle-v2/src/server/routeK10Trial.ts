import fs from 'node:fs';
import type { K10Evidence } from '../collector/k10Clock.js';
import type { ServerEtaWire } from '../../web/src/etaSource.js';
import { BLUE_K10_MODELS, applyBlueK10Trial, type BlueK10Model } from './blueK10Trial.js';

/** All-route qualification currently adds Orange Night. Unsupported or
 * regressing candidates retain the existing live estimator; the numeric
 * implementation and the two already qualified Blue fits are shared intact. */
export const ADDITIONAL_K10_MODELS: BlueK10Model[] = JSON.parse(fs.readFileSync(new URL('./data/route-k10-models.json', import.meta.url), 'utf8'));
export const ROUTE_K10_MODELS = [...BLUE_K10_MODELS, ...ADDITIONAL_K10_MODELS];

export function applyRouteK10Trial(wire: ServerEtaWire, evidence: ReadonlyMap<string, K10Evidence>,
  routes: Readonly<Record<string, readonly number[]>>, includeBlue = true): ServerEtaWire {
  return applyBlueK10Trial(wire, evidence, routes, includeBlue ? ROUTE_K10_MODELS : ADDITIONAL_K10_MODELS);
}
