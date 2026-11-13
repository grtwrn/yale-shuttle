import { readFileSync } from 'node:fs';
import { canonicalJSON, deepFreeze, sha256 } from './canonical.js';

export interface Protocol {
  v: number; id: string; revision: number; publicationCapability: false;
  curbProxyRadiusM: number; departureRearmM: number; gpsCompatibilityM: number;
  maxForwardSpeedMps: number; maxDistinctObservationGapMs: number; maxActualReceiptGapMs: number;
  minimumDistinctWitnessSeparationMs: number; maxAbsLiveObservedReceiptSkewMs: number;
  matchWindowMs: number; settlementWindowMs: number; maxProgressIntervals: number;
  maxCatalogCalls: number; maxCatalogVertices: number; maxPacketBuses: number;
  maxPacketBytes: number; maxRetainedFixesPerVehicle: number; rejectFutureObservation: true;
  rules: Readonly<Record<string, string>>; scope: string;
}
export const PROTOCOL_SHA256 = 'fc773c29e476375a115a7e885a966eed53a1c94246da86af8b0b46d0d319aa20';
const bytes = readFileSync(new URL('./protocol.v3.json', import.meta.url));
if (sha256(bytes) !== PROTOCOL_SHA256) throw new Error('Frozen independent encounter protocol changed');
export const DEFAULT_PROTOCOL: Readonly<Protocol> = deepFreeze(JSON.parse(bytes.toString('utf8')) as Protocol);
const pinnedCanonical = canonicalJSON(DEFAULT_PROTOCOL);
export function assertProtocol(protocol: Readonly<Protocol>): void {
  if (protocol === DEFAULT_PROTOCOL) return;
  if (canonicalJSON(protocol) !== pinnedCanonical) throw new Error('Only the frozen R3 protocol is supported');
}
