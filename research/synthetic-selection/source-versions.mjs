// A process executes one exact source. Listing a second source never permits
// applying its metadata to a component imported from the first.
import {readFileSync} from 'node:fs';
export const BASELINE_SOURCE='05a988194af3c376e5aa5da16682c29f797db2b2';
export const CURRENT_SOURCE='e7784c03b8c739eaa603fb231fe5ce80d2d71e82';
export const VERSIONS=Object.freeze({
  [BASELINE_SOURCE]:Object.freeze({webTree:'39e7e9738975f45dfb5c443cc99961a39e9aa4ef',proofFile:'INITIAL-SOURCE-PROOF.json',walkingFraction:2/3}),
  [CURRENT_SOURCE]:Object.freeze({webTree:'f985c086ee1d340ab37c7fc7c482b98bcde03ac6',proofFile:'E778-SOURCE-PROOF.json',walkingFraction:1/2}),
});
export function qualification(source=process.env.SELECTION_SOURCE??BASELINE_SOURCE){
  if(!Object.hasOwn(VERSIONS,source))throw Error('Unsupported replay source');
  return {source,...VERSIONS[source]};
}
export function sourceProof(source){
  const q=qualification(source),proof=JSON.parse(readFileSync(new URL(q.proofFile,import.meta.url),'utf8'));
  if(proof.source!==q.source||proof.webTree!==q.webTree||!Number.isFinite(Date.parse(proof.proofKnownAt)))throw Error('Invalid pinned source proof');
  return proof;
}
export function assertLoadedSource(loaded,selected=qualification()){
  if(loaded?.source!==selected.source||loaded?.webTree!==selected.webTree)throw Error('Loaded frontend does not match selected replay source');
}
