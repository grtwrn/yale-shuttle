import {stopCoords as originalCoords} from '../../services/shuttle-v2/web/src/__fixtures__/payload';
import {ROUTE_LISTS} from '../../services/shuttle-v2/web/src/routes';
export const NOW=Date.parse('2026-08-31T20:30:00.000Z');
export const board=100, alight=10;
export const scenario={origin:{lat:originalCoords[board].lat+220/111_195,lon:originalCoords[board].lon},destination:{...originalCoords[alight]}};
export type Bus={name:string;label?:string;pickup?:number;low?:number;high?:number;arrival?:number;arrivalLow?:number;arrivalHigh?:number;
  later?:number;raw?:boolean;board?:number;ride?:number};
// Deliberately synthetic two-stop routes at frozen pre-Sep21 stop coordinates.
// No visit/arrival outcomes or recorded prospective response is read.
export function feed(at=NOW, buses:Bus[]=[{name:'301'}], ageMs=0):any {
  const coords:any={[board]:{...originalCoords[board]},[alight]:{...originalCoords[alight]},[105]:{...originalCoords[105]}};
  const routes:any={},segments:any={},wireBuses:any[]=[],rows:any[]=[],positions:any[]=[];
  buses.forEach((b,i)=>{
    const cfg=ROUTE_LISTS.find(x=>x.label===(b.label??'Red'))!;
    const boardId=b.board??board;
    routes[cfg.routeIds[0]]=[boardId,alight];
    segments[cfg.routeIds[0]]={[`${boardId}-${alight}`]:{avg:b.ride??300,sd:30,n:100},[`${alight}-${boardId}`]:{avg:300,sd:30,n:100}};
    const pickup=b.pickup??600,low=b.low??Math.max(0,pickup-120),high=b.high??pickup+120;
    const arrival=b.arrival??pickup+300;
    wireBuses.push([b.name,cfg.label,b.raw?0:1,b.raw?{stopId:boardId,standingSec:0,approach:false}:null]);
    positions.push({bus_id:10_000+i,bus_name:'#'+b.name,route_id:cfg.busRouteIds[0],
      lat:coords[boardId].lat,lon:coords[boardId].lon,heading:0,last_stop_id:b.raw?boardId:alight,
      last_stop_departed_at:at-10_000,observed_at:at,...(b.raw?{at_stop_id:boardId,at_stop_since:at}:{}),lap:{}});
    rows.push([i,boardId,pickup,low,high,b.raw?0:1,0,Math.max(0,pickup-10),Math.max(0,low-10)]);
    rows.push([i,alight,arrival,b.arrivalLow??Math.max(0,arrival-60),b.arrivalHigh??arrival+60,2,0,Math.max(0,arrival-10),Math.max(0,arrival-100)]);
    if(b.later!==undefined){rows.push([i,boardId,b.later,b.later-120,b.later+120,3,0,b.later-10,b.later-130]);rows.push([i,alight,b.later+300,b.later+240,b.later+360,4,0,b.later+290,b.later+200]);}
  });
  return {buses:positions,routes,stop_names:{100:'Prospect / Canner',10:'333 Cedar',105:'Prospect / Huntington'},stop_coords:coords,
    segments,dwells:{},dwells_by_bus:{},route_paths:{},route_hours:{},route_active:{},route_peaks:{},model_params:null,announcements:[],
    server_eta:{v:2,at:at-ageMs,servedAt:at,buses:wireBuses,rows,
      distributions:rows.map(r=>Array.from({length:50},(_,j)=>r[3]+(r[4]-r[3])*j/49))}};
}
