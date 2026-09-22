/** No fitting here: immutable requests/results bridge to the original Python fit. */
import {createHash} from 'node:crypto';
import {adaptResponse,type AdapterContext} from '../brown-response/adapter.ts';
import type {ModelManifest,ModelHandle,Query,Fit,Arm} from '../brown-response/model.ts';
export const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export const bodyHash=(body:unknown)=>sha(JSON.stringify(body));
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const eq=(a:any,b:any)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function binding(m:ModelManifest) {return {artifactId:m.artifactId,pathsSha256:m.pathsSha256,sourceSha256:m.sourceSha256,
  parametersSha256:m.parametersSha256,protocolSha256:m.protocolSha256,topologySha256:m.topologySha256,
  rawPrefixSha256:m.rawPrefixSha256,knownAtPrefixSha256:m.knownAtPrefixSha256};}
export interface QueryRequest {schema:1;binding:ReturnType<typeof binding>;manifest:ModelManifest;
  inputs:{responseId:string;receivedAt:number;arm:Arm;bodySha256:string;
    rows:{ordinal:number;featureSha256:string;prefixSha256?:string;queries:Query[]}[]}[];queries:Query[]}
export class QueryCollector {
  private requests=new Map<string,QueryRequest>();
  add(body:unknown,ctx:AdapterContext) {
    if(!ctx.model)throw Error('A request requires its fixed model manifest');
    const b=binding(ctx.model.manifest),id=b.artifactId;
    let request=this.requests.get(id);
    if(!request){request={schema:1,binding:b,manifest:ctx.model.manifest,inputs:[],queries:[]};this.requests.set(id,request);}
    if(!eq(request.binding,b)||!eq(request.manifest,ctx.model.manifest))throw Error('Artifact ID reused with different model bindings');
    if(request.inputs.some(r=>r.responseId===ctx.responseId&&r.arm===ctx.arm))throw Error('Duplicate request response/arm');
    const input:QueryRequest['inputs'][number]={responseId:ctx.responseId,receivedAt:ctx.receivedAt,arm:ctx.arm,bodySha256:bodyHash(body),rows:[]};
    // Null is only a planning sentinel. This overlay is discarded, never scored
    // or called actual model support. Every eligible group is collected first.
    const planning=adaptResponse(body,{...ctx,model:{manifest:ctx.model.manifest,fit:()=>null},onQueries:(ordinal,feature,queries)=>{
      input.rows.push({ordinal,featureSha256:bodyHash(feature),queries});
      for(const q of queries)if(!request!.queries.some(old=>eq(old,q)))request!.queries.push(q);
    }});
    for(const row of input.rows)row.prefixSha256=planning.audit.rows[row.ordinal]?.prefixSha256;
    request.inputs.push(input);
  }
  all(){return [...this.requests.values()];}
}
export interface QueryResult {schema:1;requestSha256:string;binding:ReturnType<typeof binding>;
  rows:{query:Query;fit:Fit|null}[];runtimeSha256:string}
export function queryBank(requestBytes:Buffer,resultBytes:Buffer,expectedResultSha256:string,expectedRuntimeSha256:string) {
  if(sha(resultBytes)!==expectedResultSha256)throw Error('Query result byte hash mismatch');
  const request:QueryRequest=JSON.parse(requestBytes.toString()),result:QueryResult=JSON.parse(resultBytes.toString());
  if(request.schema!==1||result.schema!==1||result.requestSha256!==sha(requestBytes)||!eq(result.binding,request.binding)
    ||!eq(binding(request.manifest),request.binding)||result.runtimeSha256!==expectedRuntimeSha256)throw Error('Query source/pool/request binding mismatch');
  const expected=new Set(request.queries.map(q=>JSON.stringify(q)));
  if(expected.size!==request.queries.length)throw Error('Duplicate requested query');
  const values=new Map<string,Fit|null>();
  for(const row of result.rows) {
    const key=JSON.stringify(row.query);
    if(!expected.has(key)||values.has(key)||!(row.fit===null||typeof row.fit==='object'))throw Error('Duplicate, extra or invalid result query');
    values.set(key,row.fit);
  }
  if(values.size!==expected.size)throw Error('Missing model query result');
  return {
    request,
    model(body:unknown,ctx:AdapterContext):ModelHandle {
      const input=request.inputs.find(r=>r.responseId===ctx.responseId&&r.arm===ctx.arm);
      if(!input||input.receivedAt!==ctx.receivedAt||input.bodySha256!==bodyHash(body)||!ctx.model||!eq(ctx.model.manifest,request.manifest))throw Error('Response/model not bound to query request');
      const observed:typeof input.rows=[];
      const planning=adaptResponse(body,{...ctx,model:{manifest:request.manifest,fit:()=>null},onQueries:(ordinal,feature,queries)=>
        observed.push({ordinal,featureSha256:bodyHash(feature),queries})});
      for(const row of observed)row.prefixSha256=planning.audit.rows[row.ordinal]?.prefixSha256;
      if(!eq(input.rows,observed))throw Error('Causal feature/query request changed after sealing');
      return {manifest:request.manifest,fit:q=>{const key=JSON.stringify(q);if(!values.has(key))throw Error('Missing model query');return values.get(key)!;}};
    },
  };
}
