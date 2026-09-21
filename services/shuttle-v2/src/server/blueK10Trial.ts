import fs from 'node:fs';
import type { K10Evidence } from '../collector/k10Clock.js';
import { forwardStops } from '../collector/k10Scopes.js';
import type { ServerEtaWire, ServerEtaRow } from '../../web/src/etaSource.js';
import type { K10Model } from './k10Trial.js';

export interface BlueK10Model extends K10Model {
  routeId: number;
  label: string;
  sourceIndex: number;
  waitIndex: number;
}
export const BLUE_K10_MODELS: BlueK10Model[] = JSON.parse(fs.readFileSync(new URL('./data/blue-k10-models.json', import.meta.url), 'utf8'));
const et = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hourCycle:'h23', hour:'numeric', minute:'numeric', second:'numeric', weekday:'short' });
interface Forecast { eta: number; low: number; high: number; distribution: number[] }
const cache = new WeakMap<BlueK10Model, Map<number, Map<number, Forecast> | null>>();

/** The same broad target group, circular clock weights and weekday/weekend
 * split as the frozen Python experiment. Cache durations, never countdowns. */
function durations(model: BlueK10Model, departed: number): Map<number, Forecast> | null {
  let byDeparture = cache.get(model);
  if (!byDeparture) { byDeparture = new Map(); cache.set(model, byDeparture); }
  if (byDeparture.has(departed)) return byDeparture.get(departed)!;
  const parts = et.formatToParts(departed), part = (key: string) => parts.find(p => p.type === key)!.value;
  const clock = Number(part('hour')) * 60 + Number(part('minute')) + Number(part('second')) / 60;
  const weekend = ['Sat','Sun'].includes(part('weekday'));
  const result = new Map<number, Forecast>();
  for (const target of model.sequence.filter((_, i) => i !== model.waitIndex)) {
    const paths = (model.paths[target] ?? []).flatMap(([day,start,duration]) => {
      const dow = new Date(day+'T12:00:00Z').getUTCDay();
      if ((dow === 0 || dow === 6) !== weekend) return [];
      const delta = Math.abs(start-clock), weight = Math.exp(-.5*(Math.min(delta,1440-delta)/120)**2);
      return weight >= 1e-12 ? [{ day, duration, weight }] : [];
    });
    const total = paths.reduce((s,p) => s+p.weight,0), squares = paths.reduce((s,p) => s+p.weight**2,0);
    const days = new Map<string,number>();
    for (const p of paths) days.set(p.day,(days.get(p.day)??0)+p.weight);
    if (!total || total**2/squares < 12 || [...days.values()].filter(w => w>=total*.05).length < 3) {
      byDeparture.set(departed,null); break;
    }
    const mean = paths.reduce((s,p) => s+p.duration*p.weight,0)/total;
    paths.sort((a,b) => a.duration-b.duration);
    const q = (probability: number) => {
      let sum=0;
      for (const p of paths) { sum+=p.weight; if (sum>=total*probability) return p.duration; }
      return paths.at(-1)!.duration;
    };
    result.set(target,{ eta:mean,low:Math.min(mean,q(.1)),high:Math.max(mean,q(.9)),
      distribution:Array.from({length:50},(_,i)=>q((i+.5)/50)) });
  }
  if (!byDeparture.has(departed)) byDeparture.set(departed,result);
  const answer = byDeparture.get(departed)!;
  if (byDeparture.size>128) byDeparture.delete(byDeparture.keys().next().value!);
  return answer;
}

export function blueK10GroupPredictions(model: BlueK10Model, departed: number, now: number): Map<number, Forecast> | null {
  if (!Number.isFinite(departed) || !Number.isFinite(now) || departed>now || now<model.trainBefore
    || now>=model.validUntil || now-departed>2_700_000) return null;
  const prior = durations(model,departed);
  if (!prior) return null;
  const elapsed=(now-departed)/1000, result=new Map<number,Forecast>();
  for (const [target,p] of prior) {
    if (p.eta-elapsed<=60) return null;
    result.set(target,{eta:Math.max(0,p.eta-elapsed),low:Math.max(0,p.low-elapsed),high:Math.max(0,p.high-elapsed),
      distribution:p.distribution.map(v=>Math.max(0,v-elapsed))});
  }
  return result;
}

export function applyBlueK10Trial(wire: ServerEtaWire, evidence: ReadonlyMap<string,K10Evidence>,
  routes: Readonly<Record<string,readonly number[]>>, models = BLUE_K10_MODELS): ServerEtaWire {
  const byLabel = new Map(models.map(m=>[m.label,m]));
  const groups = new Map<string,ReturnType<typeof blueK10GroupPredictions>>();
  const changedByRoute: Record<string,number> = { ...(wire.trial?.byRoute ?? { Red:wire.trial?.changedRows ?? 0 }) };
  for (const m of models) changedByRoute[m.label]=0;
  let changed=0;
  const ordered = wire.rows.map((r,i): { row: ServerEtaRow; distribution: number[] } => {
    const old={row:r,distribution:wire.distributions?.[i]??[]};
    const bus=wire.buses[r[0]], model=bus&&byLabel.get(bus[1]), e=bus&&evidence.get(bus[0]);
    if (!model || routes[String(model.routeId)]?.join(',')!==model.sequence.join(',') || !e
      || e.routeId!==model.routeId || e.released || e.observedAt>wire.at || wire.at-e.observedAt>15_000
      || e.origin.departed>e.origin.knownAt || e.origin.knownAt>e.observedAt) return old;
    const n=model.sequence.length, ti=model.sequence.indexOf(r[1]), w=model.waitIndex, source=model.sourceIndex;
    if (ti<0 || ti===w || e.index<0 || e.index>=n || bus[2]<0 || bus[2]>=n || r[5]<=0 || r[5]>=n
      || forwardStops(source,e.index,n)>10 || (e.index===w && e.phase==='drive')) return old;
    if (e.index!==w && (forwardStops(e.index,ti,n)||n)<=forwardStops(e.index,w,n)) return old;
    const progress=forwardStops(source,bus[2],n);
    if (progress>10 || r[5]!==10+forwardStops(w,ti,n)-progress) return old;
    if (!groups.has(bus[0])) groups.set(bus[0],blueK10GroupPredictions(model,e.origin.departed,wire.at));
    const p=groups.get(bus[0])?.get(r[1]);
    if (!p) return old;
    changed++; changedByRoute[model.label]++;
    return {row:[r[0],r[1],Math.round(p.eta),Math.round(p.low),Math.round(p.high),r[5],r[6],r[7],r[8]],
      distribution:p.distribution.map(Math.round)};
  }).sort((a,b)=>a.row[2]-b.row[2]);
  return {...wire,rows:ordered.map(o=>o.row),distributions:ordered.map(o=>o.distribution),
    trial:{model:wire.trial?.model??'blue-k10-20260921',changedRows:(wire.trial?.changedRows??0)+changed,
      validUntil:Math.min(wire.trial?.validUntil??Infinity,...models.map(m=>m.validUntil)),byRoute:changedByRoute}};
}
