import {it,expect,vi} from 'vitest';
import {appendFileSync,mkdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DiskTimeline,JsonlSink,POLICY,readScenarios,runStreamingEpisode,schedule} from './streaming';

it('runs the assigned complete baseline profile block with one isolated component at a time',async()=>{
  const stage=process.env.BENCH_STAGE,date=process.env.BENCH_DATE,route=Number(process.env.BENCH_ROUTE);
  const output=process.env.BENCH_OUTPUT!,spool=process.env.BENCH_SPOOL!,ready=process.env.BENCH_READY_SHA!;
  if(!['pilot','full','integration'].includes(stage??'')||!output||!spool||!ready)throw Error('Explicit synthetic benchmark assignment required');
  const geometries=readScenarios('../../research/synthetic-selection/PROSPECTIVE-SCENARIOS.json');
  const assigned=[];
  for(const e of schedule(geometries))if(e.date===date&&(stage==='full'?e.scenario.generatingRouteId===route:e.slot===24))assigned.push(e);
  if(stage==='integration')assigned.splice(2);
  expect(assigned.length).toBe(stage==='full'?288:stage==='pilot'?84:2);
  mkdirSync(join(output,'streams'),{recursive:true});
  writeFileSync(join(output,'assigned.json'),JSON.stringify(assigned.map(e=>e.id))+'\n');
  const input=new DiskTimeline(spool,ready),results:any[]=[],began=process.hrtime.bigint(),cpu=process.cpuUsage();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error('Forbidden benchmark network');}));
  const stderr=vi.spyOn(console,'error').mockImplementation((...args:any[])=>{
    if(typeof args[0]==='string'&&args[0].startsWith('react-test-renderer is deprecated'))return;
    throw Error('Unexpected component warning: '+args.join(' '));
  });
  try{
    for(const episode of assigned){
      vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(episode.scheduledAt);
      const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
      const path=join(output,'streams',episode.id.replaceAll(':','_')+'.jsonl.gz');
      const sink=new JsonlSink(path,{schema:1,episodeId:episode.id,captureId:input.metadata.captureId,policy:POLICY});
      try{
        const status=await runStreamingEpisode(episode,input,clock,sink);
        expect(vi.getTimerCount()).toBe(0);
        const bytes=await sink.close();
        const retained=stage!=='full'||(episode.date==='2026-09-23'&&episode.slot===0)||(episode.date==='2026-09-29'&&episode.slot===47);
        const result={...status,output:{...bytes,retained,file:retained?'streams/'+path.split('/').at(-1):null}};
        appendFileSync(join(output,'episodes.jsonl'),JSON.stringify(result)+'\n');results.push(result);
        if(!retained)unlinkSync(path);
        if(results.length%24===0)console.log(JSON.stringify({stage,date,route,completed:results.length,assigned:assigned.length}));
      }catch(error){sink.abort();await sink.done;appendFileSync(join(output,'episodes.jsonl'),JSON.stringify({id:episode.id,executionStatus:'execution_failed',reason:String(error)})+'\n');throw error;}
      finally{vi.useRealTimers();}
    }
    const report={stage,date,route,expected:assigned.length,completed:results.length,success:results.length===assigned.length,
      elapsedSeconds:Number(process.hrtime.bigint()-began)/1e9,cpuMicros:process.cpuUsage(cpu),maxRssKiB:process.resourceUsage().maxRSS,
      rawBytes:results.reduce((n,r)=>n+r.output.rawBytes,0),compressedBytes:results.reduce((n,r)=>n+r.output.compressedBytes,0),
      rows:results.reduce((n,r)=>n+r.output.rows,0),maxWritableBuffer:Math.max(...results.map(r=>r.output.maxBuffered)),
      statuses:results.reduce((all,r)=>{const key=[r.initialStatus,r.versionStatus,r.coverageStatus,r.executionStatus].join('/');all[key]=(all[key]??0)+1;return all;},{}),
      input:input.metadata};
    // The healthy workload must really execute, not pass by enumerating
    // unavailable versions or empty initial responses.
    expect(results.every(r=>r.initialStatus==='selected'&&r.versionStatus==='assumption_qualified')).toBe(true);
    expect(results.every(r=>stage==='integration'?r.executionStatus==='known_prefix_only':r.executionStatus==='completed')).toBe(true);
    writeFileSync(join(output,'complete.json'),JSON.stringify(report,null,2)+'\n');
  }finally{input.close();stderr.mockRestore();vi.unstubAllGlobals();}
});
