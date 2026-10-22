import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, association } from './testFixtures.mjs';
import { WitnessStore, DEFAULT_POLICY } from './storage.mjs';
import { pollWitnesses, getJSON, runOnce, readStoragePolicy } from './poll.mjs';

const roots = [], stores = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) fs.rmSync(r,{recursive:true,force:true}); });
const json = (v,status=200) => new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'collector-poll-test-')); roots.push(root);
  const store = new WitnessStore(root,{policy:{minFreeBytes:0}}); stores.push(store);
  const f = fixture(), requests = []; let model = 0, corrupt = false, reportFailure = false;
  const fetcher = async (url,options) => {
    url = new URL(url); requests.push({url,options});
    if(url.pathname==='/api/reports')return reportFailure?json({},503):json({reports:[]});
    if(!url.search)return json({...f.head(),evaluationCursor:model});
    const page=f.page(Number(url.searchParams.get('after')),Number(url.searchParams.get('limit')));
    if(model)page.evaluations=page.frames.map(association);
    const known=url.searchParams.get('knownTopologies')?.split(',')??[];
    page.topologies=page.topologies.filter(t=>!known.includes(t.sha256));
    if(corrupt&&page.frames.length)page.frames=[{...page.frames[0],json:'corrupt'}];
    return json(page);
  };
  const poll=()=>pollWitnesses({store,fetcher,token:'test-secret',now:f.at});
  return{f,store,requests,poll,setModel:v=>model=v,setCorrupt:v=>corrupt=v,setReportFailure:v=>reportFailure=v};
}
describe('read-only collector witness watcher',()=>{
  it('defaults when the optional policy is absent and accepts partial local limits',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'collector-policy-test-'));roots.push(root);
    const file=path.join(root,'policy.json');expect(await readStoragePolicy(file)).toEqual({});
    fs.writeFileSync(file,JSON.stringify({maxBytes:512*1024*1024}));
    expect(await readStoragePolicy(file)).toEqual({maxBytes:512*1024*1024});
    expect(DEFAULT_POLICY).toEqual({maxBytes:256*1024*1024,maxAgeMs:7*86400000,minFreeBytes:128*1024*1024});
  });
  it('rejects malformed, unknown, fractional, unsafe and oversized policy values',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'collector-policy-test-'));roots.push(root);
    const file=path.join(root,'policy.json');
    for(const value of ['null','[]','1','{',JSON.stringify({maxByte:123}),JSON.stringify({maxBytes:3*1024*1024-1}),
      JSON.stringify({maxBytes:Number.MAX_SAFE_INTEGER+1}),JSON.stringify({maxAgeMs:0}),JSON.stringify({minFreeBytes:-1}),
      JSON.stringify({minFreeBytes:0.5}),' '.repeat(4097)]){
      fs.writeFileSync(file,value);await expect(readStoragePolicy(file)).rejects.toThrow();
    }
    fs.writeFileSync(file,JSON.stringify({minFreeBytes:0}));expect(await readStoragePolicy(file)).toEqual({minFreeBytes:0});
    await expect(readStoragePolicy(root)).rejects.toThrow();
  });
  it('applies a raised cap across invocations and refuses invalid config without touching the cursor or evidence',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'collector-policy-run-'));roots.push(root);
    const dir=path.join(root,'store'),policyFile=path.join(root,'policy.json'),tokenFile=path.join(root,'token');
    fs.writeFileSync(tokenFile,'secret');fs.writeFileSync(policyFile,JSON.stringify({maxBytes:512*1024*1024,minFreeBytes:0}));
    const f=fixture();f.add();let requests=0;
    const fetcher=async url=>{requests++;url=new URL(url);return json(url.pathname==='/api/reports'?{reports:[]}:
      !url.search?f.head():f.page(Number(url.searchParams.get('after')),Number(url.searchParams.get('limit'))));};
    const options={dir,policyFile,tokenFile,incidents:path.join(root,'pending'),fetcher,now:f.at};
    expect(await runOnce(options)).toMatchObject({ok:true,cursor:1,retention:{maxBytes:512*1024*1024,maxAgeMs:7*86400000}});
    const db=path.join(dir,'witnesses.sqlite'),before=fs.readFileSync(db),count=requests;
    fs.writeFileSync(policyFile,JSON.stringify({maxBytes:'secret-invalid-value'}));f.add();
    expect(await runOnce({...options,now:f.at})).toMatchObject({ok:false,errorCode:'capture_rejected'});
    expect(requests).toBe(count);expect(fs.readFileSync(db)).toEqual(before);
    expect(fs.readFileSync(path.join(dir,'status.json'),'utf8')).not.toContain('secret-invalid-value');
    fs.writeFileSync(policyFile,JSON.stringify({maxBytes:512*1024*1024,minFreeBytes:0}));
    expect(await runOnce({...options,now:f.at})).toMatchObject({ok:true,cursor:2,frames:1,boundary:null,retention:{maxBytes:512*1024*1024}});
    const store=new WitnessStore(dir,{policy:{maxBytes:512*1024*1024,minFreeBytes:0}});stores.push(store);
    expect(store.db.prepare('SELECT count(*) n FROM frames').get().n).toBe(2);
  });
  it('captures a page, omits a known topology later, and does not fetch unchanged payloads',async()=>{
    const a=setup();a.f.add();const first=await a.poll();expect(first).toMatchObject({ok:true,frames:1,cursor:1});
    const count=a.requests.length;await a.poll();expect(a.requests.length).toBe(count+1);
    a.f.add();await a.poll();const last=a.requests.at(-1);
    expect(last.url.searchParams.get('knownTopologies')).toBe(a.f.topology.sha256);
    expect(a.requests.every(r=>r.options.headers['x-admin-token']==='test-secret'&&r.options.redirect==='error')).toBe(true);
  });
  it('revisits the last poll once when a model association arrives late',async()=>{
    const a=setup();a.f.add();await a.poll();a.setModel(1);
    const r=await a.poll();expect(r).toMatchObject({frames:0,cursor:1,pages:1});
    expect(a.store.db.prepare('SELECT count(*) n FROM model_refs').get().n).toBe(1);
    const count=a.requests.length;await a.poll();expect(a.requests.length).toBe(count+1);
  });
  it('records a clipped source boundary and retains the earlier checkpoint evidence',async()=>{
    const a=setup();a.f.add();await a.poll();const key=a.store.get('activeChunk');
    for(let i=0;i<722;i++)a.f.add();
    const r=await a.poll();expect(r.boundary).toBe('source-prefix-expired');
    expect(a.store.readChunk(key).frames[0].seq).toBe(1);
    const boundary=JSON.parse(a.store.db.prepare('SELECT json FROM boundaries ORDER BY id DESC LIMIT 1').get().json);
    expect(boundary.clippedPrefix).toBe(true);expect(boundary.previous.after).toBe(1);
  });
  it('preserves the cursor on corrupted input and protects old pins on report refresh failure',async()=>{
    const a=setup();a.f.add();await a.poll();const cp=a.store.checkpoint();
    a.f.add();a.setCorrupt(true);await expect(a.poll()).rejects.toThrow();expect(a.store.checkpoint()).toEqual(cp);
    a.setCorrupt(false);a.setReportFailure(true);a.store.put('reportsAt',0);
    const r=await a.poll();expect(r.ok).toBe(false);expect(r.reportsOK).toBe(false);expect(r.retention.cleanupUncertain).toBe(true);
  });
  it('treats an empty capture as zero frames and never infers service or accuracy',async()=>{
    const a=setup();const r=await a.poll();expect(r).toMatchObject({ok:true,frames:0,cursor:0});expect(r.scope).toContain('not ETA accuracy');
  });
  it('rejects HTML, oversized streams and invalid remote HTTP origins',async()=>{
    await expect(getJSON('https://example.test','secret',async()=>new Response('html'))).rejects.toThrow('type/size');
    await expect(getJSON('https://example.test','secret',async()=>json({data:'x'.repeat(200)}),32)).rejects.toThrow('byte bound');
    const a=setup();await expect(pollWitnesses({store:a.store,base:'http://example.test',token:'secret'})).rejects.toThrow('origin');
  });
  it('checks actual HTTP bytes and refuses malformed UTF-8 before retaining a receipt',async()=>{
    await expect(getJSON('https://example.test','secret',async()=>new Response(Buffer.from([123,34,120,34,58,34,255,34,125]),{headers:{'content-type':'application/json'}}))).rejects.toThrow();
  });
  it('refuses a head commitment that differs from the returned valid frame chain',async()=>{
    const a=setup();a.f.add();
    const fetcher=async url=>{url=new URL(url);return url.pathname==='/api/reports'?json({reports:[]}):url.search?json(a.f.page()):json({...a.f.head(),chain:'f'.repeat(64)});};
    await expect(pollWitnesses({store:a.store,fetcher,token:'secret',now:a.f.at})).rejects.toThrow('commitment');
    expect(a.store.checkpoint().after).toBe(0);expect(a.store.db.prepare('SELECT count(*) n FROM chunks').get().n).toBe(0);
  });
  it('reports stalled capture despite fresh HTTP heads and recovers on an actual new poll',async()=>{
    const a=setup();a.f.add();await a.poll();a.f.advance(120001);
    expect(await a.poll()).toMatchObject({ok:false,sourceStale:true,frames:0});
    a.f.add();expect(await a.poll()).toMatchObject({ok:true,sourceStale:false,frames:1});
  });
  it('bounds the initial no-input grace period without inferring that service is absent',async()=>{
    const a=setup();expect(await a.poll()).toMatchObject({ok:true,sourceStale:false,cursor:0});
    a.f.advance(120001);expect(await a.poll()).toMatchObject({ok:false,sourceStale:true,cursor:0});
  });
  it('reports incomplete source evidence even when the journal head and HTTP clock are healthy',async()=>{
    const a=setup();a.f.add({sourceWriteEvidence:'unavailable'});
    expect(await a.poll()).toMatchObject({ok:false,sourceCaptureUnavailable:true,sourceUnavailable:false});
    a.f.add();expect(await a.poll()).toMatchObject({ok:true,sourceCaptureUnavailable:false});
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
  });
});
