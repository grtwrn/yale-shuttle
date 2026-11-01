import { readFileSync } from 'node:fs';
import { canonicalJSON, deepFreeze, sha256 } from '../encounter-proxy/canonical.js';
import { PROTOCOL_SHA256 as R3_SHA256 } from '../encounter-proxy/protocol.js';
import type { Caps } from './types.js';

export const PROTOCOL_SHA256 = '6f9f772861e52720dd192b5692ece4e144902ffa3c4048bbd4c3dacb4235781c';
const bytes = readFileSync(new URL('./protocol.v2.json', import.meta.url));
if (sha256(bytes) !== PROTOCOL_SHA256) throw new Error('Frozen catalog enumeration protocol changed');
export const PROTOCOL = deepFreeze(JSON.parse(bytes.toString('utf8')) as {
  schema: string; revision: number; proposalSHA256: string; r3ProtocolSHA256: string;
  publicationCapability: false; liveAdmissionCapability: false; caps: Caps; rules: Record<string, string>;
  io: { inputPassMaxPayloadBytes: number; inputFileMaxPayloadBytes: number; inputPassMaxFiles: number;
    eofProbeMaxAttemptsPerFD: number; eofProbeRequestedBytes: number; inputPassMaxEOFProbeAttempts: number;
    inputPassMaxActualEOFProbeBytes: number; inputPassMaxTotalActualIOBytes: number; rules: string[] };
});
if (PROTOCOL.r3ProtocolSHA256 !== R3_SHA256) throw new Error('R3 catalog geometry protocol changed');
export const R3_PROTOCOL_SHA256 = R3_SHA256;
export const DEFAULT_CAPS: Readonly<Caps> = PROTOCOL.caps;
export const IO_LIMITS = PROTOCOL.io;

export function effectiveCaps(overrides: Partial<Caps> = {}): Caps {
  const caps = { ...DEFAULT_CAPS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(caps, key) || !Number.isSafeInteger(value) || value! <= 0
      || value! > caps[key as keyof Caps]) throw new Error('Engineering caps can only be lowered');
    caps[key as keyof Caps] = value!;
  }
  if (caps.reservedRefusalOutputBytes >= caps.maxDiagnosticOutputBytes)
    throw new Error('Output budget must retain refusal reserve');
  return caps;
}

export const canonicalInputHash = (input: unknown) => sha256(canonicalJSON(input));
