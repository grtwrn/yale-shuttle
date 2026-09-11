import { describe, expect, it } from "vitest";
import { loadStudy } from "./study";
import type { StopStudy } from "../../../src/schema/stop-study";

const pin = Date.parse("2026-09-08T12:00:00Z");
function evidence():StopStudy {
  return {schemaVersion:1,source:"saved_study",title:"A saved comparison",generatedAt:pin+900_000,timezone:"America/New_York",days:["2026-09-08"],routes:[{routeId:3,name:"Red",shortName:"Red"}],stops:[{stopId:11,name:"344 Winchester",lat:41.32,lon:-72.92}],
    visits:[{id:"a",day:"2026-09-08",routeId:3,routePatternId:"pattern-a",stopId:11,stopIndex:14,busId:30,busKey:"307",busName:"307",anchoredAt:pin,pinnedAt:pin,recordedPinnedAt:pin+120_000,arrivedAt:pin,departedAt:pin+600_000,recordedStandSec:480,pinnedStandSec:600,outcome:"stopped",how:null,confidence:null,qualityNotes:[],previousDepartureAt:null,loopSec:null,labelStatus:"complete",leftCensored:false,rightCensored:false,originalEpisodeId:"old-a",predictions:[]}],
    positionTracks:[{routeId:3,busId:30,busKey:"307",positions:[{at:pin-120_000,lat:41.32,lon:-72.92,busId:30,distanceM:null,gapSec:null},{at:pin,lat:41.3201,lon:-72.92,busId:30,distanceM:null,gapSec:120}]},{routeId:3,busId:31,busKey:"307",positions:[{at:pin+60_000,lat:41.32,lon:-72.92,busId:31,distanceM:null,gapSec:null}]},{routeId:4,busId:30,busKey:"307",positions:[{at:pin+90_000,lat:41.4,lon:-72.92,busId:30,distanceM:null,gapSec:null}]}],
    provenance:{exporterVersion:"stop-study-v1",inputs:[{role:"labels",name:"episodes.jsonl",sha256:"a".repeat(64)}],sourceHashes:{},sampling:{forecastIntervalSec:30,positionIntervalSec:5,pairedQueriesOnly:true,firstPairedDisplayPreserved:true,description:"Saved paired queries."},counts:{},warnings:[]}};
}
describe("saved study adapter",()=>{
  it("selects observed track evidence for the route and bus identity, preserving the lead-in and id changes",()=>{
    const study=loadStudy(evidence());
    const detail=study.detail("a")!;
    expect(detail.source).toBe("saved_study");
    expect(detail.positions).toHaveLength(3);
    expect(detail.positions[0].at).toBe(pin-120_000);
    expect(detail.positions[0].distanceM).toBe(0);
    expect(detail.positions[1].distanceM).toBeCloseTo(11.12,1);
    expect(detail.coverage).toMatchObject({identityAmbiguous:true,maxGapSec:120,missingBefore:true,missingAfter:true});
    expect(detail.visit.recordedPinnedAt).toBe(pin+120_000);
    expect(detail.visit.pinnedAt).toBe(pin);
  });
  it("does not pool repeated stop occurrences or invent absent GPS",()=>{
    const raw=evidence();raw.visits.push({...raw.visits[0],id:"b",stopIndex:3,busKey:"other",busId:90});
    const study=loadStudy(raw);
    expect(study.day({day:"2026-09-08",routeId:3,stopId:11,stopIndex:14}).visits.map(v=>v.id)).toEqual(["a"]);
    expect(study.detail("b")!.positions).toEqual([]);
    expect(study.detail("missing")).toBeNull();
  });
});
