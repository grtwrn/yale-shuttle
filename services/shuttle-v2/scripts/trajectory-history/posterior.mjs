import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deserialize,serialize} from 'node:v8';
import {gunzipSync} from 'node:zlib';

const MiB=1024*1024,MAX_RUNTIME=12*MiB,MAX_RECORD=4*MiB,integer=Number.isSafeInteger;
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const modelKey=m=>sha(JSON.stringify(canonical({version:m?.version,params:m?.params})));

/** This reads the already-computed champion state. It never creates, restores,
 * steps or samples an estimator. Original model inputs stay byte-identical. */
export class PosteriorCapture {
  constructor(learningRoot,live,{now=Date.now(),prior={}}={}) {
    this.live=live;this.now=now;this.prior=structuredClone(prior);this.record=null;this.reason=null;this.target=null;
    try {
      if(!/^cycle-\d+$/.test(live.id??'')||!hash(live.sourceKey)||typeof live.productionBuild!=='string'||!live.productionBuild||typeof live.source?.epoch!=='string'||!live.source.epoch||!hash(live.source?.seedSha256))throw Error('native-source-identity-invalid');
      const references=[live.source?.previousRuntime,live.source?.runtime].filter(Boolean);
      if(!references.length){this.reason='runtime-receipt-missing';return;}
      const fresh=references.filter(r=>integer(r.at)&&r.at<=now+5000&&now-r.at<=120000);
      if(!fresh.length){this.reason='no-fresh-model';return;}
      let receipt,bytes;
      for(const r of fresh){
        if(typeof r.file!=='string'||!/^runtime-[a-f0-9]{64}\.v8\.gz$/.test(r.file)||!hash(r.sha256)||r.file!==`runtime-${r.sha256}.v8.gz`||!hash(r.rawSha256)||!integer(r.bytes)||r.bytes<=0||r.bytes>MAX_RUNTIME||!integer(r.cursor)||r.cursor<1)throw Error('runtime-receipt-invalid');
        const file=path.join(learningRoot,live.id,r.file);let st;try{st=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(!st.isFile()||st.isSymbolicLink()||st.size!==r.bytes)throw Error('runtime-file-invalid');
        bytes=fs.readFileSync(file);if(bytes.length!==r.bytes||sha(bytes)!==r.sha256)throw Error('runtime-checksum-mismatch');receipt=r;break;
      }
      if(!receipt){this.reason='runtime-file-rotated';return;}
      const raw=gunzipSync(bytes,{maxOutputLength:MAX_RUNTIME});if(sha(raw)!==receipt.rawSha256)throw Error('runtime-content-mismatch');
      const runtime=deserialize(raw),championKey=modelKey(live.champion);
      if(runtime.v!==1||runtime.build!==live.productionBuild||runtime.sourceKey!==live.sourceKey||runtime.epoch!==live.source.epoch||runtime.seedSha256!==live.source.seedSha256
        ||runtime.cursor!==receipt.cursor||runtime.at!==receipt.at||!hash(runtime.chain)||runtime.desiredModels?.champion!==championKey)throw Error('runtime-identity-mismatch');
      if(!runtime.lastFrame){this.reason='awaiting-first-model';return;}
      if(runtime.computedModels?.champion!==championKey)throw Error('runtime-identity-mismatch');
      const last=runtime.lastFrame;if(!hash(last.sha256)||!hash(last.contextSha256)||!integer(last.observationVersion)||last.observationVersion<0)throw Error('runtime-frame-reference-invalid');
      const armBytes=runtime.arms?.champion?.bytes;if(!(armBytes instanceof Uint8Array)||armBytes.length>4*MiB||runtime.arms.champion.lastAt!==runtime.at)throw Error('champion-state-invalid');
      const arm=deserialize(armBytes);
      if(arm.v!==1||arm.kind!=='runtime'||arm.at!==runtime.at||modelKey(arm.modelParams)!==championKey||!(arm.store instanceof Map)||arm.store.size>200||!(arm.observed instanceof Map)||arm.observed.size>200||!arm.cache)throw Error('champion-state-invalid');
      for(const [key,e]of arm.store){const b=e?.belief,C=b?.p?.length/2;if(typeof key!=='string'||!(b?.p instanceof Float64Array)||!integer(C)||C<1||C>20000||!(b.restMask instanceof Uint8Array)||b.restMask.length!==C||!(b.standLeg instanceof Int32Array)||b.standLeg.length!==C||!(b.zoneKey instanceof Int32Array)||b.zoneKey.length!==C)throw Error('posterior-shape-invalid');}
      const key=sha(JSON.stringify([live.sourceKey,runtime.epoch,runtime.cursor,last.sha256]));
      this.target={receipt,runtime,arm,championKey,key};
      if(prior.lastKey===key&&hash(prior.lastStateSha)){this.reason='already-sampled';return;}
      this.reason='original-frame-not-retained';
    } catch(error) {this.reason=String(error.message??error).slice(0,160);this.failed=true;}
  }
  get needsFrame(){return!!this.target&&!this.record&&this.reason!=='already-sampled'&&!this.failed;}
  matches(cycle,sourceKey){return this.needsFrame&&cycle===this.live.id&&sourceKey===this.live.sourceKey;}
  observe(packet,{cycle,sourceKey}={}) {
    if(!this.matches(cycle,sourceKey)||packet?.epoch!==this.target.runtime.epoch)return;
    const {runtime,arm,receipt,championKey,key}=this.target;
    for(const f of packet.frames??[]) {
      if(f.seq!==runtime.cursor)continue;
      try {
        if(packet.build!==runtime.build||f.at!==runtime.at||f.observationVersion!==runtime.lastFrame.observationVersion||f.sha256!==runtime.lastFrame.sha256||f.contextSha256!==runtime.lastFrame.contextSha256
          ||typeof f.json!=='string'||typeof f.contextJson!=='string'||Buffer.byteLength(f.json)!==f.bytes||sha(f.json)!==f.sha256||Buffer.byteLength(f.contextJson)!==f.contextBytes||sha(f.contextJson)!==f.contextSha256)throw Error('model-frame-mismatch');
        const p=JSON.parse(f.json),context=JSON.parse(f.contextJson);
        if(context.at!==f.at||!Array.isArray(p.buses)||modelKey(p.model_params)!==championKey||JSON.stringify(p.buses)!==JSON.stringify(arm.cache.currentBuses)||JSON.stringify(p.server_eta??null)!==JSON.stringify(arm.cache.trialWire??null))throw Error('served-control-mismatch');
        const state=serialize({v:1,kind:'native-posterior-projection',at:arm.at,modelParams:arm.modelParams,store:arm.store,observed:arm.observed});
        if(state.length>2*MiB||f.bytes+f.contextBytes>2*MiB)throw Error('posterior-record-size-bound');
        const record={kind:'posterior-projection',v:1,id:key,at:f.at,capturedAt:this.now,cycle,sourceKey,build:packet.build,epoch:packet.epoch,cursor:f.seq,sha256:f.sha256,contextSha256:f.contextSha256,
          frame:f,collector:context.collectorWitness??null,nativeRuntime:{...receipt,seedSha256:runtime.seedSha256,chain:runtime.chain,championModel:championKey},
          posterior:{encoding:'v8-base64',bytes:state.length,sha256:sha(state),data:state.toString('base64'),node:process.versions.node,v8:process.versions.v8},
          modelEntryContexts:null,entryContextReason:'No new causal model projection at this exact frame was available.',
          scope:'Exact original input and a lossless projection of its already-computed champion posterior. This is not the complete forecast runtime, independent physical truth or an accuracy/promotion qualification.'};
        if(Buffer.byteLength(JSON.stringify(record))>MAX_RECORD)throw Error('posterior-record-size-bound');
        this.record=record;this.reason=null;
      }catch(error){this.failed=true;this.reason=String(error.message??error).slice(0,160);}
      return;
    }
  }
  modelContext({frame,buses}) {
    if(!this.record||frame.sha256!==this.record.sha256||frame.seq!==this.record.cursor)return;
    this.record.modelEntryContexts=buses.map(b=>{const e=b.entry,valid=!e||(integer(e.at)&&e.at<=frame.at&&integer(e.previousAt)&&e.previousAt<e.at&&integer(e.previousCursor)&&e.previousCursor<frame.seq&&hash(e.modelSHA256)&&hash(e.previousModelSHA256)&&e.fromIndex===b.anchor?.[2]);return{name:b.name,id:b.id,route:b.route,anchor:b.anchor,entry:valid?e:null,clockReason:valid?b.clockReason:'unavailable-or-future-entry-context'};});
    this.record.entryContextReason=null;
  }
  finish(modelState) {
    if(this.record&&Buffer.byteLength(JSON.stringify(this.record))>MAX_RECORD){this.record=null;this.failed=true;this.reason='posterior-record-size-bound';}
    let ok=!!this.record||this.reason==='already-sampled';
    if(!ok&&!this.failed&&['no-fresh-model','awaiting-first-model'].includes(this.reason)&&(modelState.idleService||modelState.forecastUnavailable))ok=true;
    const status={enabled:true,ok,state:this.record?'captured':this.reason??'unavailable',modelAt:this.target?.runtime.at??this.live.source?.runtime?.at??null,capturedModels:this.record?1:0,
      sourceModelSha256:this.target?.runtime.lastFrame?.sha256??null,nativeRuntimeSha256:this.target?.receipt.sha256??null,posteriorStateSha256:this.record?.posterior.sha256??this.prior.lastStateSha??null,
      scope:'Posterior capture coverage; not an ETA-accuracy verdict.'};
    const records=this.record?[this.record]:!ok?[{kind:'posterior-unavailable',at:this.now,cycle:this.live.id,sourceKey:this.live.sourceKey,reason:this.reason,modelAt:status.modelAt}]:[];
    return{status,records,state:this.record?{lastKey:this.record.id,lastAt:this.record.at,lastStateSha:this.record.posterior.sha256}:this.prior};
  }
}
