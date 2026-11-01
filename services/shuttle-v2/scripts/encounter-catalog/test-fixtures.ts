/** Independent controlled reference declarations, never real service truth. */
import { sha256 } from '../encounter-proxy/canonical.js';
import type { CatalogInput, Evidence } from './types.js';

export const fixtureSource = { id: 'controlled-source', file: 'reference.json', bytes: 2, sha256: sha256('{}') };
export const fixtureEvidence = (): Evidence => ({ status: 'fixture-assumption', sourceIds: [fixtureSource.id] });
export function squareInput(): CatalogInput {
  return {
    schema: 'independent-catalog-embedding-input/v1', mode: 'fixture', routeId: 100,
    sources: [{ ...fixtureSource }],
    path: [{ lat: 41, lon: -73 }, { lat: 41, lon: -72.98 }, { lat: 41.01, lon: -72.98 },
      { lat: 41.01, lon: -73 }, { lat: 41, lon: -73 }],
    curbs: [
      { stopId: 1, coord: { lat: 41, lon: -72.99 }, sourceIds: [fixtureSource.id] },
      { stopId: 2, coord: { lat: 41.01, lon: -72.99 }, sourceIds: [fixtureSource.id] },
    ],
    published: [{ id: 'bottom', publishedIndex: 0, stopId: 1 }, { id: 'top', publishedIndex: 1, stopId: 2 }],
    spurs: [], variants: [{ id: 'plan', sourceIds: [fixtureSource.id], tokens: [
      { id: 'first', occurrenceOptions: ['bottom'] }, { id: 'second', occurrenceOptions: ['top'] },
    ] }],
    scope: { onePlanCycleOneRawLoop: fixtureEvidence(), orientations: ['forward'],
      orientationExclusions: [{ orientation: 'reverse', evidence: fixtureEvidence() }], qualificationPending: true },
  };
}

export function foldInput(): CatalogInput {
  const input = squareInput();
  input.path = [{ lat: 41, lon: -73 }, { lat: 41, lon: -72.96 }, { lat: 41.0002, lon: -72.96 },
    { lat: 41.0002, lon: -73 }, { lat: 41, lon: -73 }];
  input.curbs = [
    { stopId: 1, coord: { lat: 41.0001, lon: -72.98 }, sourceIds: [fixtureSource.id] },
    { stopId: 2, coord: { lat: 41.0001, lon: -72.96 }, sourceIds: [fixtureSource.id] },
    { stopId: 3, coord: { lat: 41.0001, lon: -73 }, sourceIds: [fixtureSource.id] },
  ];
  input.published = [{ id: 'west', publishedIndex: 0, stopId: 3 }, { id: 'south', publishedIndex: 1, stopId: 1 },
    { id: 'turn', publishedIndex: 2, stopId: 2 }, { id: 'north', publishedIndex: 3, stopId: 1 }];
  input.variants[0]!.tokens = input.published.map(call => ({ id: 'token-' + call.id, occurrenceOptions: [call.id] }));
  return input;
}
