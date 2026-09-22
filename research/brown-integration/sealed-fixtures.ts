/** Synthetic translation only: never represents captured future observations. */
import type {AdapterContext} from '../brown-response/adapter.ts';
import type {Arm,ModelManifest} from '../brown-response/model.ts';
import {bodyHash} from './sidecar.ts';

export function shiftFixture(original:any,at:number) {
  const c=structuredClone(original),delta=at-c.at;
  c.name=`synthetic-sealed/${original.name}/${at}`;c.at=at;
  c.syntheticClockTranslation={originalAt:original.at,delta,originalSha256:bodyHash(original)};
  delete c.originalCandidates; // New sealed pools do not have old-fit parity.
  for(const s of Object.values(c.snapshots) as any[]) {
    for(const key of ['asof','began','observedAt'])s[key]+=delta;
    for(const o of Object.values(s.origins) as any[]){o.departed+=delta;o.knownAt+=delta;}
    for(const key of Object.keys(s.releasedOrigins))s.releasedOrigins[key]+=delta;
    s.prefixSha256=bodyHash({syntheticClockTranslation:c.syntheticClockTranslation,originalPrefix:s.prefixSha256});
  }
  for(const [i,f]of c.frames.entries()) {
    f.id=`${c.name}/${i}`;f.receivedAt+=delta;
    f.body.server_eta.at+=delta;f.body.server_eta.servedAt+=delta;
    for(const b of f.body.buses)if(Number.isFinite(b.observed_at))b.observed_at+=delta;
  }
  return c;
}

export function sealedContext(c:any,f:any,arm:Arm,topology:any,models:any):AdapterContext {
  const manifest:ModelManifest=models[arm.startsWith('frozen')?'frozen':'rolling'].manifest;
  return {responseId:f.id,receivedAt:f.receivedAt,arm,topology,
    model:{manifest,fit:()=>{throw Error('Sealed query must be bound before use');}},
    snapshot:()=>c.snapshots[arm.endsWith('_directed')?'directed':'original']};
}
