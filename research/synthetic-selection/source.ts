import {RESEARCH_SOURCE} from '../../services/shuttle-v2/web/src/__researchSelection.generated';
import {assertLoadedSource,qualification,sourceProof} from './source-versions.mjs';
export const ACTIVE_QUALIFICATION=qualification();
assertLoadedSource(RESEARCH_SOURCE,ACTIVE_QUALIFICATION);
export const ACTIVE_PROOF=sourceProof(ACTIVE_QUALIFICATION.source);
