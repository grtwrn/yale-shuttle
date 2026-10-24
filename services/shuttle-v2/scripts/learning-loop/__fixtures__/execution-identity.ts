import { identityHash } from '../../reestimate-validation.mjs';
import type { ProductionExecutionIdentity } from '../../../src/server/executionIdentity';

/** Synthetic producer provenance for protocol tests, never a live attestation. */
export function fixtureProducerExecution(n=1):ProductionExecutionIdentity{
 const hash=(value:number)=>value.toString(16).padStart(64,'0');
 const core={v:1 as const,sourceTreeSHA256:hash(n),dependencyTreeSHA256:hash(n+1),nodeBinarySHA256:hash(n+2),
  runtime:{node:'fixture-node',platform:'fixture',arch:'fixture',versions:{node:'fixture'},timezone:'America/New_York',argumentsSHA256:hash(n+3)}};
 return {...core,sha256:identityHash(core)};
}
