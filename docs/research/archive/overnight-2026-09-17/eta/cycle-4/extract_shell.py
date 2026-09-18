from pathlib import Path
import json,hashlib
O=Path(__file__).resolve().parent
R=Path.cwd()
src=(R/'web/src/TransitMap.tsx').read_text()
a=src.index('    return stableOptions.map((o) => {',src.index('const options: TripOption[] | null = useMemo'))
b=src.index('    // eslint-disable-next-line react-hooks/exhaustive-deps',a)
body=src[a:b]
assert body.endswith('    });\n')
imports='''import { pathToFileURL } from 'node:url';
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const planner=await load('planner.ts');
const {rideBoardArrivals,boardingVisitAllowed,dwellBoardWindowSec}=planner;
const {journeyArrival:actualJourney}=await load('journeyArrival.ts');
const {computeUpcomingArrivals}=await load('liveArrivals.ts');
const {liveEtaAvailable,liveBusAvailable}=await load('etaSource.ts');
const {haversineMeters}=await load('geo.ts');
const {AT_PLACE_M,walkSecFromMeters}=await load('walk.ts');
const {ROUTE_LISTS}=await load('routes.ts');
const {isCurrentLocationText}=await load('endpoints.ts');
export function reprice(stableOptions:any[], buses:any[], payload:any, effectiveFromLL:any, toLL:any) {
 const {routes:routeStops,stop_coords:stopCoords,segments:segmentTimes,dwells:dwellTimes}=payload;
 const fromText='Research explicit origin',userLatLon=null,liveAnchorStore=new Map();
 const etaFresh=liveEtaAvailable(buses);
 const trace:any[]=[];
 const noteShown=()=>{}; // Only suppress telemetry; no network or analytics in research.
 const pickLiveArrival=(...args:any[])=>{const p=planner.pickLiveArrival(...args);trace.push({kind:'pick',p});return p;};
 const journeyArrival=(board:any,visits:any[],target:number,walkTo:number,walkFrom:number,now:number)=>{
  const value=actualJourney(board,visits,target,walkTo,walkFrom,now);
  const destination=board?visits.filter((a:any)=>a.busName===board.busName&&a.routeLabel===board.routeLabel&&a.stopsAhead>board.stopsAhead&&a.stopId===target).sort((a:any,b:any)=>a.stopsAhead-b.stopsAhead)[0]:undefined;
  trace.push({kind:'journey',board,destination,available:!!value});return value;
 };
 const compute=()=>{
'''
output=imports+body+''' };
 return {options:compute(),trace};
}
'''
(O/'shell-live.generated.mts').write_text(output)
(O/'shell-extraction.json').write_text(json.dumps(dict(source=str(R/'web/src/TransitMap.tsx'),sourceSha256=hashlib.sha256(src.encode()).hexdigest(),bodySha256=hashlib.sha256(body.encode()).hexdigest(),firstLine=src[:a].count('\n')+1,lastLine=src[:b].count('\n'),changes='Exact map body wrapped as function; imports dynamic; telemetry suppressed; pure pick/journey wrappers record returns without changing them.',limits='React lifecycle and browser rendering not validated. Stationary explicit origins only; no future mode, aboard state or user refresh.'),indent=2)+'\n')
print('Extracted exact live map body, lines',src[:a].count('\n')+1,'to',src[:b].count('\n'))
