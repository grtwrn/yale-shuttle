/** Read-only provenance. Nothing in this module is returned to model state. */
export const KS = [1, 2, 3, 5, 8, 10, 15];
const finite = (x: any) => typeof x === 'number' && Number.isFinite(x);
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: any[]) => [...new Set(xs)].sort();
const key = (...xs: any[]) => JSON.stringify(xs);

export function physicalReasons(e: any, knownAt: number, routes: Map<number, any>): string[] {
  const reasons: string[] = [];
  if (e.kind !== 'visit') reasons.push('not a visit');
  if (!['stopped', 'passed'].includes(e.outcome)) reasons.push('unresolved outcome');
  if (e.how === 'gap' || e.how == null) reasons.push('no non-gap confirmation');
  for (const f of ['pinnedAt', 'arrivedAt', 'departedAt']) if (!finite(e[f])) reasons.push('missing/nonfinite ' + f);
  if (finite(e.arrivedAt) && finite(e.departedAt) && e.arrivedAt > e.departedAt) reasons.push('arrival after departure');
  if (finite(e.departedAt) && e.departedAt > knownAt) reasons.push('departure after emission');
  if (finite(e.pinnedAt) && e.pinnedAt > knownAt) reasons.push('pin after emission');
  const seq = routes.get(e.routeId)?.stops;
  if (!seq || !Number.isInteger(e.stopIndex) || e.stopIndex < 0 || seq[e.stopIndex] !== e.stopId) reasons.push('canonical occurrence mismatch');
  return reasons;
}

export function filterFlags(origin: any, r: any): string[] {
  if (!origin) return ['model history absent'];
  const flags: string[] = [];
  if (origin.route !== r.route) flags.push('route mismatch');
  if (origin.knownAt > r.asof) flags.push('emission after asof');
  if (origin.departed > r.began) flags.push('departure after phase start');
  if (r.at - origin.departed > 2700000) flags.push('age exceeds45min');
  return flags;
}

export function readiness(r: any, state: any, warm: any): string[] {
  const flags: string[] = [];
  if (!state) flags.push('missing public-name state');
  if (!warm) flags.push('missing warm epoch');
  if (state && state.routeId !== r.route) flags.push('state route mismatch');
  if (state && r.asof - state.lastObservedAt > 15000) flags.push('observation older than15s');
  if (state && r.asof < state.lastObservedAt) flags.push('observation after asof');
  if (warm && warm.last - warm.first < 600000) flags.push('warm span below10min');
  if (r.index < 0) flags.push('unknown phase/index');
  return flags;
}

export function requested(r: any, k: number, routes: Map<number, any>, waits: any) {
  const seq = routes.get(r.route)?.stops ?? [], n = seq.length;
  if (r.targetIndex == null) return { reason: 'ambiguous target occurrence' };
  const ws: number[] = waits[r.route] ?? [];
  if (!ws.length) return { reason: 'no major wait' };
  if (k >= n) return { reason: 'K outside single loop' };
  // Same stable tie order and cyclic zero-as-full-loop rule as previous_wait.
  const distance = (w: number) => (r.targetIndex - w + n) % n || n;
  const wait = ws.reduce((a, b) => distance(b) < distance(a) ? b : a);
  const source = (wait - k + n) % n;
  return { wait, source, stop: seq[source] };
}

export class Observer {
  emissions: any[] = []; resets: any[] = []; transitions: any[] = []; trackChanges: any[] = [];
  private strict = new Map<string, any[]>();
  private latest = new Map<string, any>();
  private latestInvalid = new Map<string, any>();
  private providerSources = new Map<string, any>();
  private physicalStops = new Map<string, any>();
  private cleared = new Map<number, any[]>();
  private nameSeen = new Map<string, any>();
  private providerSeen = new Map<number, any>();
  private nameTransitions = new Map<string, any[]>();
  private firstName = new Map<string, number>();
  private latestReset = new Map<string, any>();
  private openLosses = new Map<string, any>();
  constructor(readonly routes: Map<number, any>, readonly waits: any) {}
  private signature(name: string, index: number, origin: any) {
    return key(name, origin.route, index, origin.departed, origin.knownAt);
  }
  matches(name: string, index: number, origin: any) {
    return this.strict.get(this.signature(name, index, origin)) ?? [];
  }
  observePoll(obs: any[], plan: any, time: number) {
    if(obs.some(o=>o.collectedAt!==time))throw Error('observer poll contains mixed timestamps');
    const byName = new Map<string, any[]>(), byProvider = new Map<number, any[]>();
    for (const o of obs) {
      if (!byName.has(o.busName)) byName.set(o.busName, []);
      if (!byProvider.has(o.busId)) byProvider.set(o.busId, []);
      byName.get(o.busName)!.push(o); byProvider.get(o.busId)!.push(o);
      if (!this.firstName.has(o.busName)) this.firstName.set(o.busName, time);
    }
    const add = (event: any, names: string[]) => {
      const e = { id: this.transitions.length, at: time, ...event }; this.transitions.push(e);
      for (const name of new Set(names)) {
        if (!this.nameTransitions.has(name)) this.nameTransitions.set(name, []);
        this.nameTransitions.get(name)!.push(e);
      }
    };
    for (const [name, os] of byName) {
      const now = { at: time, providers: sorted(os.map(o => o.busId)), routes: sorted(os.map(o => o.routeId)) };
      const prev = this.nameSeen.get(name);
      if (prev && !same(prev.providers, now.providers)) add({ kind: 'public-name provider-set change', name, previous: prev, current: now,
        sequentialReissue: prev.providers.length === 1 && now.providers.length === 1 && !plan.contendedNames.has(name) }, [name]);
      if (plan.contendedNames.has(name)) add({ kind: 'simultaneous public-name contention', name, previous: prev ?? null, current: now }, [name]);
      this.nameSeen.set(name, now);
    }
    for (const [provider, os] of byProvider) {
      const now = { at: time, names: sorted(os.map(o => o.busName)), routes: sorted(os.map(o => o.routeId)) };
      const prev = this.providerSeen.get(provider);
      if (prev && !same(prev.names, now.names)) add({ kind: 'provider public-name-set change', provider, previous: prev, current: now }, [...prev.names, ...now.names]);
      if (now.names.length > 1) add({ kind: 'simultaneous provider-name ambiguity', provider, previous: prev ?? null, current: now }, now.names);
      this.providerSeen.set(provider, now);
    }
  }
  beforeReset(o: any, time: number, warm: any, plan: any, history: any, states: any, visits: any = new Map()) {
    const reasons: string[] = [];
    if (!warm) reasons.push('first observed warm epoch / left boundary unknown');
    if (warm && time - warm.last > 60000) reasons.push('observation gap above60s');
    if (warm && warm.route !== o.routeId) reasons.push('route change');
    if (plan.contendedNames.has(o.busName)) reasons.push('simultaneous public-name contention');
    const origins = [...(history ?? [])].map(([index, origin]: any) => ({ index, ...origin,
      strictEmissionIds: this.matches(o.busName, index, origin).map(e => e.id) }));
    const droppedOpenPins = [...states].filter(([,s]:any)=>s.busName===o.busName).flatMap(([k]:any)=>{
      const v=visits.get(k),p=v?.pass;
      return p&&finite(p.pinnedAt)?[{route:v.routeId,index:p.stopIndex,stop:p.stopId,anchoredAt:p.anchoredAt,
        pinnedAt:p.pinnedAt,arrivedAt:p.arrivedAt,confirmedDepartureKnown:false}]:[];
    });
    const event = { id: this.resets.length, at: time, name: o.busName, provider: o.busId, route: o.routeId,
      reasons, priorWarm: warm ? { ...warm } : null, origins,
      droppedOpenPins,
      droppedStates: [...states].filter(([,s]: any) => s.busName === o.busName).map(([trackKey,s]: any) => this.track(trackKey,s)) };
    this.resets.push(event); this.latestReset.set(o.busName,event);
    for(const p of droppedOpenPins)this.openLosses.set(key(o.busName,p.route,p.index),{...p,at:time,resetId:event.id,reasons:[...reasons]});
    for (const origin of origins) for (const id of origin.strictEmissionIds) {
      if (!this.cleared.has(id)) this.cleared.set(id,[]);
      this.cleared.get(id)!.push({id:event.id,at:time,reasons:[...reasons]});
    }
  }
  emission(e: any, time: number, warm: any) {
    if (e.kind !== 'visit') return;
    const reasons = physicalReasons(e,time,this.routes);
    const rejected: string[] = [];
    // Observe original insertion predicates exactly; stricter evidence never changes them.
    if (e.how === 'gap') rejected.push('gap confirmation');
    if (e.outcome === 'unresolved') rejected.push('unresolved');
    if (e.arrivedAt === null) rejected.push('null arrival');
    if (e.departedAt === null) rejected.push('null departure');
    if (!warm) rejected.push('no warm state');
    else if (e.departedAt < warm.first) rejected.push('departure before warm epoch');
    const record = { id:this.emissions.length, name:e.busName,provider:e.busId,anchorProvider:e.anchorBusId,
      route:e.routeId,stop:e.stopId,index:e.stopIndex,anchoredAt:e.anchoredAt,pinnedAt:e.pinnedAt,
      arrivedAt:e.arrivedAt,departedAt:e.departedAt,knownAt:time,outcome:e.outcome,how:e.how,
      physical:reasons.length===0,physicalRejections:reasons,modelAccepted:rejected.length===0,modelRejections:rejected,
      warmFirst:warm?.first??null };
    this.emissions.push(record);
    const cell=key(record.name,record.route,record.index);
    if (record.physical) {
      const sig=this.signature(record.name,record.index,{route:record.route,departed:record.departedAt,knownAt:time});
      if (!this.strict.has(sig)) this.strict.set(sig,[]);
      this.strict.get(sig)!.push(record);this.latest.set(cell,record);
      this.providerSources.set(key(record.provider,record.route,record.index),record);
      this.physicalStops.set(key(record.name,record.stop),record);
    } else this.latestInvalid.set(cell,record);
  }
  private track(trackKey: string,s: any) {
    return {trackKey,name:s.busName,provider:s.busId,route:s.routeId,observedAt:s.lastObservedAt,
      enteredAt:s.enteredAt,index:s.nearestIndex};
  }
  tracks(states: any) { return new Map([...states].map(([k,s]:any)=>[k,this.track(k,s)])); }
  afterTracks(before:any,states:any,time:number) {
    // A changed stopwatch/key is observable; do not guess the detector's causal branch.
    for (const [k,s] of states) {
      const a=before.get(k),b=this.track(k,s);
      if (a && (a.provider!==b.provider||a.name!==b.name||a.route!==b.route||a.enteredAt!==b.enteredAt&&a.index===b.index))
        this.trackChanges.push({at:time,before:a,after:b,kind:'identity/route state transition; reset causality unassigned'});
    }
    for(const [k,a] of before) if(!states.has(k)) this.trackChanges.push({at:time,before:a,after:null,kind:'track key removed or migrated'});
  }
  private context(name: string, since: number) {
    const events=(this.nameTransitions.get(name)??[]).filter(e=>e.at>=since);
    return {transitionIds:events.map(e=>e.id),flags:sorted(events.map(e=>e.kind)),
      sequentialProviderReissues:events.filter(e=>e.sequentialReissue).length,
      identityAmbiguous:events.some(e=>['simultaneous public-name contention','provider public-name-set change','simultaneous provider-name ambiguity'].includes(e.kind))};
  }
  snapshot(r:any,state:any,visit:any,warm:any,history:any) {
    if((this.emissions.at(-1)?.knownAt??-Infinity)>r.asof || (this.transitions.at(-1)?.at??-Infinity)>r.asof)
      throw Error('observer contains future evidence');
    const readyFlags=readiness(r,state,warm), ks:any={};
    if(r.ready !== (readyFlags.length===0)) throw Error('readiness observer disagreement');
    for(const k of KS) {
      const request:any=requested(r,k,this.routes,this.waits);
      const d:any={k,...request,category:'',flags:[]};ks[k]=d;
      if(request.reason){d.category='no unique requested source';continue;}
      const origin=history?.get(request.source), cell=key(r.bus,r.route,request.source);
      const source=this.latest.get(cell), invalid=this.latestInvalid.get(cell);
      const pass=visit?.routeId===r.route && visit?.pass?.stopIndex===request.source ? visit.pass : null;
      d.openPinned=Boolean(pass&&finite(pass.pinnedAt));
      if(d.openPinned)d.openVisit={anchoredAt:pass.anchoredAt,pinnedAt:pass.pinnedAt,arrivedAt:pass.arrivedAt,confirmedDepartureKnown:false};
      d.filterFlags=filterFlags(origin,r);
      d.retained=Object.hasOwn(r.origins,request.source);
      if(d.retained !== Boolean(r.ready&&origin&&d.filterFlags.length===0))throw Error('source-filter observer disagreement');
      d.lastInvalidEmissionId=invalid?.id??null;
      if(invalid)d.lastInvalidReasons=invalid.physicalRejections;
      const openLoss=this.openLosses.get(cell);
      if(openLoss)d.openPinnedLostAtReset={...openLoss};
      d.strictPhysicalEmissionId=source?.id??null;
      if(source){
        d.latestPhysical={id:source.id,provider:source.provider,knownAt:source.knownAt,departedAt:source.departedAt,
          modelAccepted:source.modelAccepted,modelRejections:source.modelRejections};
        d.context=this.context(r.bus,source.knownAt);
        d.clearedBy=(this.cleared.get(source.id)??[]).map(e=>({...e}));
        d.physicalAgeSec=(r.at-source.departedAt)/1000;
        d.flags.push(...(d.context.identityAmbiguous?['identity context ambiguous']:[]));
        if(source.departedAt>r.began)d.flags.push('latest physical departure after current phase start');
        if(warm&&source.departedAt<warm.first)d.flags.push('latest physical departure before current warm epoch');
      } else {
        const elsewhere=state?this.providerSources.get(key(state.busId,r.route,request.source)):null;
        if(elsewhere&&elsewhere.name!==r.bus)d.otherNamePhysical={id:elsewhere.id,name:elsewhere.name,provider:elsewhere.provider,knownAt:elsewhere.knownAt};
        const otherRoute=this.physicalStops.get(key(r.bus,request.stop));
        if(otherRoute&&otherRoute.route!==r.route)d.otherRoutePhysicalSameStop={id:otherRoute.id,route:otherRoute.route,index:otherRoute.index,knownAt:otherRoute.knownAt};
      }
      if(origin){
        const matches=this.matches(r.bus,request.source,origin);
        d.history={...origin};d.historyAgeSec=(r.at-origin.departed)/1000;
        d.matchingStrictEmissionIds=matches.map(e=>e.id);
        d.historyPhysicalProof=matches.length===1?'unique strict emission':matches.length?'multiple matching emissions / ambiguous':'unproven';
        d.historyContext=matches.length===1?this.context(r.bus,matches[0].knownAt):null;
      }
      if(!r.ready){d.category='current row not ready';continue;}
      if(origin){
        if(d.historyPhysicalProof!=='unique strict emission')d.category='model history physically unproven/ambiguous';
        else if(!d.filterFlags.length)d.category='strict physical source retained';
        else if(same(d.filterFlags,['age exceeds45min']))d.category='strict physical source expired solely by45min cap';
        else d.category='model history fails other/combined filters';
      }else if(source){
        if(d.context.identityAmbiguous)d.category='known physical source; identity context ambiguous';
        else if(d.clearedBy.length)d.category='known physical source cleared by observed model reset';
        else if(source.modelRejections.includes('departure before warm epoch'))d.category='known physical source rejected before warm epoch';
        else d.category='known physical source absent; attribution unknown';
      }else if(d.otherNamePhysical)d.category='no same-name source; other-name evidence ambiguous';
      else if(d.otherRoutePhysicalSameStop)d.category='no same-route source; other-route physical stop observed';
      else if(d.openPinned)d.category='no physical departure emitted; pinned visit still open';
      else if(openLoss)d.category='no physical source emitted; prior pinned visit lost at reset';
      else if(invalid)d.category='no physical source emitted; only invalid visit evidence';
      else d.category='no physical source emitted in observed prefix; left-censored unknown';
    }
    return {at:r.at,bus:r.bus,route:r.route,target:r.target,asof:r.asof,ready:r.ready,readinessFlags:readyFlags,
      firstNameObservedAt:this.firstName.get(r.bus)??null,warm:warm?{...warm}:null,
      lastReset:this.latestReset.get(r.bus)??null,currentState:state?this.track(r.bus,state):null,
      currentNameContext:this.nameSeen.get(r.bus)??null,ks};
  }
}
