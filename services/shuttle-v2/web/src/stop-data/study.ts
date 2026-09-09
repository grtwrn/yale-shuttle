import { validateStopStudy } from "../../../src/schema/stop-study";
import type { StopDataCatalog, StopDataDay, StopDataDetail, StopDataSelection } from "../../../src/schema/stop-data";
import type { ComparisonPoint } from "./analysis";
import { haversineMeters } from "../geo";
import type { ZodError } from "zod";

export interface SavedForecast extends ComparisonPoint {
  modelLabel:string; displaySec:number; displayKind:string; observedStartAt:number; note:string | null;
  downstream:{stopId:number;stopIndex:number;arrivalId:string;targetAt:number;medianSec:number|null;lowSec:number|null;highSec:number|null} | null;
}
export interface StudyView {
  title:string; summary:string; provenance:unknown; catalog:StopDataCatalog;
  arms:string[]; forecasts:SavedForecast[];
  day:(selection:StopDataSelection)=>StopDataDay;
  detail:(id:string)=>StopDataDetail|null;
}
export function loadStudy(input:unknown): StudyView {
  const study = (()=>{
    try { return validateStopStudy(input); }
    catch(error) {
      // Shared schema and web dependencies can resolve different Zod copies.
      if(error instanceof Error && "issues" in error && Array.isArray(error.issues)) {
        const issue=(error as ZodError).issues[0];
        throw new Error(`Invalid study format${issue?.path.length?` at ${issue.path.join(".")}`:""}: ${issue?.message ?? "schema mismatch"}`);
      }
      throw error;
    }
  })();
  const byId = new Map(study.visits.map(v => [v.id,v]));
  const routes:StopDataCatalog["routes"] = study.routes.map(r => ({...r,occurrences:[]}));
  for (const visit of study.visits) {
    let route = routes.find(r => r.routeId === visit.routeId);
    if (!route) { route = {routeId:visit.routeId,name:`Route ${visit.routeId}`,shortName:String(visit.routeId),occurrences:[]};routes.push(route); }
    let occurrence = route.occurrences.find(s=>s.stopId === visit.stopId && s.stopIndex === visit.stopIndex);
    if (!occurrence) {
      const stop = study.stops.find(s=>s.stopId===visit.stopId);
      occurrence = {stopId:visit.stopId,stopIndex:visit.stopIndex,name:stop?.name ?? `Stop ${visit.stopId}`,lat:stop?.lat??null,lon:stop?.lon??null,visitCount:0,currentTopologyMatch:false};
      route.occurrences.push(occurrence);
    }
    occurrence.visitCount++;
  }
  routes.forEach(r=>r.occurrences.sort((a,b)=>a.stopIndex-b.stopIndex||a.stopId-b.stopId));
  const anchors = study.visits.map(v=>v.anchoredAt);
  const catalog:StopDataCatalog = {
    schemaVersion:1,source:"saved_study",generatedAt:study.generatedAt,timezone:study.timezone,
    days:[...study.days].sort().reverse().map(day=>({day,visitCount:study.visits.filter(v=>v.day===day).length})),routes,
    availability:{visitsFrom:anchors.length?Math.min(...anchors):null,visitsTo:anchors.length?Math.max(...anchors):null,positionsFrom:null,positionsTo:null},
    limits:{catalogDays:366,visits:50_000,positions:20_000,positionWindowHours:3},
    warnings:study.provenance.warnings,
  };
  const forecasts:SavedForecast[] = study.visits.flatMap(v=>v.predictions.map(p=>({
    visitId:v.id,issuedAt:p.issuedAt,model:p.arm,modelLabel:p.model,totalSec:p.predictedTotalSec,remainingSec:p.predictedRemainingSec,
    first:p.firstCapturedDisplay,displaySec:p.displaySec,displayKind:p.displayKind,observedStartAt:p.observedStartAt,
    note:p.occurrenceAgreement?null:"Displayed occurrence disagrees with the labelled stop occurrence.",
    downstream:p.downstream?{stopId:p.downstream.targetStopId,stopIndex:p.downstream.targetStopIndex,arrivalId:p.downstream.targetArrivalId,targetAt:p.downstream.targetAt,medianSec:p.downstream.quantilesSec[p.downstream.quantileLevels.indexOf(.5)]??null,lowSec:p.downstream.quantilesSec[p.downstream.quantileLevels.indexOf(.1)]??null,highSec:p.downstream.quantilesSec[p.downstream.quantileLevels.indexOf(.9)]??null}:null,
  })));
  return {
    title:study.title,summary:[study.provenance.context?.cohort,study.provenance.context?.training].filter(Boolean).join(" ") || "Saved, paired replay outputs. Sampling and source details are available under provenance.",provenance:study.provenance,catalog,arms:["baseline","candidate"],forecasts,
    day(selection) {
      const visits = study.visits.filter(v=>v.day===selection.day && v.routeId===selection.routeId && v.stopId===selection.stopId && v.stopIndex===selection.stopIndex).sort((a,b)=>a.anchoredAt-b.anchoredAt);
      return {schemaVersion:1,source:"saved_study",selection,dayStartAt:visits[0]?.anchoredAt??0,dayEndAt:visits[visits.length-1]?.departedAt??visits[visits.length-1]?.anchoredAt??0,visits,totalVisits:visits.length,truncated:false,warnings:[
        "Observed durations use reconstructed labels. Saved forecasts are paired, associated samples; censored visits and missing forecasts remain visible.",
        ...(new Set(visits.map(v=>v.routePatternId)).size>1?["This selection contains multiple historical route patterns. Inspect each visit’s evidence notes before pooling results."]:[]),
      ]};
    },
    detail(id) {
      const visit=byId.get(id);if(!visit)return null;
      const stop=study.stops.find(s=>s.stopId===visit.stopId);
      const requestedFrom=Math.max(0,Math.min(visit.pinnedAt??visit.anchoredAt,visit.anchoredAt)-15*60_000);
      const desiredTo=(visit.departedAt??(visit.pinnedAt??visit.anchoredAt)+30*60_000)+2*60_000;
      const requestedTo=Math.min(desiredTo,requestedFrom+3*60*60_000);
      const points=visit.positions??(study.positionTracks??[])
        .filter(t=>t.routeId===visit.routeId&&t.busKey===visit.busKey)
        .flatMap(t=>t.positions).filter(p=>p.at>=requestedFrom&&p.at<=requestedTo).sort((a,b)=>a.at-b.at||a.busId-b.busId);
      const positions=points.map(p=>({...p,distanceM:stop?.lat!==null&&stop?.lat!==undefined&&stop?.lon!==null&&stop?.lon!==undefined?haversineMeters(p,{lat:stop.lat,lon:stop.lon}):null}));
      const first=positions[0]?.at??null,last=positions[positions.length-1]?.at??null;
      const maxGapSec=positions.length>1?Math.max(...positions.slice(1).map(p=>p.gapSec??0)):null;
      const identityAmbiguous=new Set(positions.map(p=>p.busId)).size>1;
      return {schemaVersion:1,source:"saved_study",visit,stop:{stopId:visit.stopId,name:stop?.name??`Stop ${visit.stopId}`,lat:stop?.lat??null,lon:stop?.lon??null},positions,
        coverage:{requestedFrom,requestedTo,actualFrom:first,actualTo:last,missingBefore:first===null||first>requestedFrom+30_000,missingAfter:last===null||last<requestedTo-30_000,maxGapSec,truncated:false,windowCapped:requestedTo<desiredTo,identityAmbiguous},
        warnings:[`Route pattern: ${visit.routePatternId}. Label status: ${visit.labelStatus}.`,
          ...(positions.length?[]:["No position samples were included for this visit in the exported study."]),
          ...(study.provenance.sampling.positionIntervalSec===null?[]:[`Positions sampled at a minimum ${study.provenance.sampling.positionIntervalSec} sec interval; gap values describe adjacent raw fixes.`]),
          ...(maxGapSec!==null&&maxGapSec>30?["GPS contains gaps longer than 30 sec. Missing movement is not interpolated."]:[]),
          ...(identityAmbiguous?["Multiple bus IDs share this name in the selected window. Identity changes break the plotted track."]:[]),
          ...(first===null||first>requestedFrom+30_000||last===null||last<requestedTo-30_000?["Saved GPS does not cover both edges of the requested window."]:[]),
          `Requested GPS window: ${new Date(requestedFrom).toISOString()} to ${new Date(requestedTo).toISOString()}. Distance uses the coordinates included in this study.`,
        ]};
    },
  };
}
