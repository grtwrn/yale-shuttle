export type Origin = {departed:number; knownAt:number; route:number};
export type Warm = {first:number; last:number; route:number; provider:number};
export const HORIZONS = [2700000,5400000] as const;
export const FRESHNESS = [15000,45000] as const;
export const variant = (h:number,f:number) => `h${h/60000}_f${f/1000}`;
export function fresh(asof:number, observed:number, limit:number) {
  const age=asof-observed;
  return Number.isFinite(age) && age>=0 && (limit===15000 ? age<=limit : age<limit);
}
export function originEligible(e:Origin|undefined, route:number, asof:number, began:number, at:number, horizon:number) {
  return !!e && e.route===route && Number.isFinite(e.departed) && Number.isFinite(e.knownAt)
    && e.departed<=e.knownAt && e.knownAt<=asof && e.departed<=began
    && at>=e.departed && at-e.departed<=horizon;
}
export function resetReason(w:Warm|undefined,o:{collectedAt:number;routeId:number;busId:number},contended:boolean) {
  if(!Number.isFinite(o.busId))return 'unknown provider';
  if(contended)return 'contended name';
  if(!w)return 'initial';
  if(o.routeId!==w.route)return 'route change';
  if(o.busId!==w.provider)return 'provider change';
  if(o.collectedAt-w.last>60000)return 'raw gap';
  if(o.collectedAt<=w.last)return 'nonchronological observation';
  return null;
}
export function updateRelease(latches:Map<string,number>, history:Map<number,Origin>,
  route:number, index:number, phase:string, began:number, now:number, horizon:number,
  k:number, wait:number,n:number) {
  const source=(wait-k+n)%n, origin=history.get(source), release=history.get(wait);
  if(!originEligible(origin,route,now,began,now,horizon))return;
  if((release && origin!.departed<release.departed && release.departed<=began
      && release.departed<=release.knownAt && release.knownAt<=now)
    || (index-source+n)%n>k || (index===wait && phase==='drive'))
    latches.set(`${k}/${wait}`,origin!.departed);
}
