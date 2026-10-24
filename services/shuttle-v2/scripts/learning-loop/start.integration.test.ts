import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { deserialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta } from '../../src/server/serverEta';
import { EvaluationInputError,EvaluationInputs } from '../../src/server/evaluationInputs';
import { EvaluationSource } from '../../src/server/evaluationSource';
import { ROUTE_LISTS } from '../../web/src/routes';
import { COMPILED_MODEL_PARAMS, resetModelParams } from '../../web/src/eta/params';
import { registerRoutePaths } from '../../web/src/anchor';
import { fileIdentity, identityHash } from '../reestimate-validation.mjs';
import { ExactForecastStream, digest } from './stream';
import { etDay, nextDay } from './lib.mjs';
import { learningSourceFiles } from './source-files.mjs';
import {fixtureProducerExecution} from './__fixtures__/execution-identity';
import {readTrialPairs,trialContexts,verifyContextTransitions} from './trial-evidence.mjs';

const service = fileURLToPath(new URL('../..', import.meta.url));
const cap = JSON.parse(fs.readFileSync(new URL('../../src/server/__fixtures__/live-frames.json', import.meta.url), 'utf8'));
const temporary: string[] = [];
afterEach(() => { for (const p of temporary.splice(0)) fs.rmSync(p, { recursive: true, force: true }); resetModelParams(); registerRoutePaths(null); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
async function fixture(isolatedSource = false, statisticalTrial = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-observer-cli-')); temporary.push(root);
  // A source-change regression mutates only this private runtime copy. Other
  // tests and the installed observer keep their own source bytes untouched.
  const runtimeService = isolatedSource ? path.join(fs.realpathSync(root), 'runtime-service') : service;
  if (isolatedSource) {
    for (const file of learningSourceFiles(service)) {
      const target=path.join(runtimeService,path.relative(service,file));
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);
    }
    fs.copyFileSync(path.join(service,'package.json'),path.join(runtimeService,'package.json'));
    fs.symlinkSync(path.join(service,'node_modules'),path.join(runtimeService,'node_modules'),'dir');
    fs.symlinkSync(path.join(service,'web/node_modules'),path.join(runtimeService,'web/node_modules'),'dir');
  }

  // These retained daytime buses need a weekday service clock. Real wall time
  // made healthy CLI/control tests silently lose every eligible bus at night.
  // Keep elapsed time real, and share the explicit offset with the child CLI.
  let offset = 0;
  const clockBase = Date.parse('2026-10-14T15:00:00Z') - Date.now();
  const serverNow = () => Date.now() + clockBase + offset;
  const sourceFiles = learningSourceFiles(runtimeService), sourceKey = identityHash(fileIdentity(sourceFiles)), initial = serverNow() - 30000;
  const champion = { version: 'fixture-champion', accepted: true, publishedAt: initial - 86400000, params: structuredClone(COMPILED_MODEL_PARAMS) };
  const params = structuredClone(champion.params); params.P_REPEAT_STAND = .75; params.CONFORMAL = { '0-2': 1, '2-5': 1, '5-10': 1, '10-30': 1 };
  const producer = new ServerEta({ routes: ROUTE_LISTS.map(r => r.label) }); producer.useK10Trial(() => new Map());
  let inputs = new EvaluationInputs({ epoch: 'fixture-epoch' }); let version = 0, payload: any, mode = 'healthy',build='fixture-build',restarts=0,fleetGeneration=0;
  let producerExecution=fixtureProducerExecution();
  const publish = (at = serverNow()) => {
    const since = new Date((statisticalTrial?at:initial) - 60000).toISOString();
    payload = { ...cap.static, model_params: champion, buses: structuredClone(cap.frames[4].buses).map((b: any) => {
      if(fleetGeneration){b.bus_id+=100000*fleetGeneration;b.bus_name+=`-replacement-${fleetGeneration}`;}
      b.observed_at = at; for (const field of ['at_stop_since', 'stationary_since', 'last_moved_at']) if (b[field]) b[field] = since; return b;
    }) };
    const wire = producer.contribute(payload, ++version, at, true);
    inputs.append(version, at, JSON.stringify({ ...payload, ...(wire ? { server_eta: wire } : {}) }), producer.evaluationContext()!);
  };
  const makeSource = () => new EvaluationSource(producer, () => {
    const current=mode==='idle'?{...payload,buses:[]}:mode==='expired-fleet'?structuredClone(payload):payload;
    if (mode === 'expired-fleet') current.buses = [
      ...current.buses.map((b: any) => ({ ...b, observed_at: serverNow() - 60000 })),
      { ...current.buses[0], bus_name: '#unmodeled', bus_id: -1, observed_at: serverNow() },
    ];
    const wire = producer.evaluationWire(current.buses, serverNow()); return JSON.stringify({ ...current, ...(wire ? { server_eta: wire } : {}) });
  }, inputs, () => build, serverNow,statisticalTrial?()=>producerExecution:undefined);
  let source=makeSource();
  for (let i = 0; i < 5; i++) publish(initial + i * 5000);
  const seed = source.seed(), seedReceivedAt = serverNow(), startedAt = serverNow(), id = `cycle-${startedAt}`;
  const candidate = { params, n: {}, issues: [] }, stream = new ExactForecastStream('fixture-build', sourceKey, champion, { version: id, publishedAt: startedAt, params });
  stream.seed(seed, seedReceivedAt);
  const directory = path.join(root, id); fs.mkdirSync(directory); fs.mkdirSync(path.join(root, 'archives'));
  const raw = Buffer.from(JSON.stringify(seed)), bytes = gzipSync(raw), seedFile = { file: 'source-seed.json.gz', sha256: digest(bytes), rawSha256: digest(raw), bytes: bytes.length };
  fs.writeFileSync(path.join(directory, seedFile.file), bytes);
  const first = nextDay(etDay(startedAt)), state: any = { version: 2, forecastProtocol: 'served-control-v2', id, startedAt, sourceKey,
    productionBuild: 'fixture-build', champion, candidate, trainingDays: [], trainingInputs: [], requiredRoutes: [9, 10],
    calibrationDays: [first, nextDay(first)], pending: {}, visits: {}, outbox: [], lastOutcomeAt: null,
    source: { epoch: stream.epoch, seedSha256: stream.seedSha256, seedFile, seedReceivedAt, seedAt: seed.at, seedCursor: seed.cursor, initialChain: stream.chain } };
  for (const file of sourceFiles) { const target = path.join(directory, 'source', path.relative(runtimeService, file)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target); }
  fs.writeFileSync(path.join(directory, 'frozen-candidate.json'), JSON.stringify(state)); state.frozenCandidateSha256 = digest(fs.readFileSync(path.join(directory, 'frozen-candidate.json')));
  publish(); const packet = source.read(stream.epoch, stream.cursor); stream.advance(packet);
  const recorded = JSON.stringify({ receivedAt: serverNow(), source: packet });
  const inputName='feed-2026-10-14-15-0.jsonl.gz',inputBytes=gzipSync(recorded+'\n');
  fs.writeFileSync(path.join(directory,inputName),inputBytes);state.source.inputFiles={[inputName]:inputBytes.length};
  state.source.runtime = stream.persist(directory); fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  let sent = false;
  const requests: { method: string; path: string }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method!, path: request.url! }); response.setHeader('content-type', 'application/json');
    if (request.headers['x-admin-token'] !== 'fixture-only-token') { response.statusCode = 401; response.end('{}'); return; }
    const url = new URL(request.url!, 'http://fixture');
    if (request.method === 'POST') { response.end(JSON.stringify({ id: 'unexpected-publication' })); return; }
    if (url.pathname === '/healthz') { response.end(JSON.stringify({ ok: true, build: 'fixture-build' })); return; }
    if (url.pathname === '/api/stats/model-params') { response.end(JSON.stringify({ current: champion })); return; }
    if (url.pathname === '/api/evaluation/seed') { response.end(JSON.stringify(source.seed())); return; }
    if (url.pathname === '/api/evaluation/inputs') {
      if (!url.search) {
        const head=source.head();if(mode==='changed-build')head.build='replacement-build';if(mode==='changed-epoch')head.epoch='replacement-epoch';
        response.end(JSON.stringify(head));return;
      }
      if(mode==='changed-epoch'){response.statusCode=409;response.end(JSON.stringify({error:'evaluation_epoch'}));return;}
      if(mode==='malformed'){response.end('null');return;}
      if(mode==='invalid-json'){response.end('invalid json');return;}
      if (mode === 'gap') { response.statusCode = 409; response.end(JSON.stringify({ error: 'evaluation_gap' })); return; }
      if (!sent && (mode === 'corrupt' || mode === 'advance')) { publish(); sent = true; }
      let packet:any;
      try{packet=structuredClone(source.read(url.searchParams.get('epoch')!,Number(url.searchParams.get('after'))));}
      catch(error){if(error instanceof EvaluationInputError){response.statusCode=error.code==='cursor'?400:409;response.end(JSON.stringify({error:'evaluation_'+error.code}));return;}throw error;}
      if(mode==='changed-build'||mode==='unconfirmed-build')packet.build='replacement-build';
      if (mode === 'corrupt' && packet.frames.length) {
        const frame = packet.frames[0], body = JSON.parse(frame.json); body.server_eta.rows[0][2] += 100;
        frame.json = JSON.stringify(body); frame.bytes = Buffer.byteLength(frame.json); frame.sha256 = digest(frame.json);
      }
      response.end(JSON.stringify(packet)); return;
    }
    response.statusCode = 500; response.end(JSON.stringify({ error: 'unexpected-fixture-request' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const launch = (once = true) => {
    const clock = path.join(root, 'clock.mjs');
    // Explicit local clock simulation lets the real CLI reach its next-day
    // calibration phase. It changes no OS, production or test-runner clock.
    fs.writeFileSync(clock, `const NativeDate=Date,offset=Number(process.env.YALE_FIXTURE_CLOCK_OFFSET);globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[NativeDate.now()+offset]));}static now(){return NativeDate.now()+offset;}};`);
    let log = '';
    const child = spawn(process.execPath, ['--import', path.join(service, 'node_modules/tsx/dist/loader.mjs'), '--import', clock,
      path.join(runtimeService, 'scripts/learning-loop/start.ts'), ...(once ? ['--once'] : [])], {
      cwd: runtimeService, env: { ...process.env, YALE_FIXTURE_CLOCK_OFFSET:String(clockBase+offset),TZ: 'America/New_York', LEARNING_PUBLISH: '1', LEARNING_DIR: root,
        ARCHIVE_DIR: path.join(root, 'archives'), BOT_BASE_URL: `http://127.0.0.1:${port}`, SHUTTLE_ADMIN_TOKEN: 'fixture-only-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000); void exit.finally(() => clearTimeout(timer));
    return { child, exit, log: () => log };
  };
  return { root, service: runtimeService, directory, id, state, stream, seed, requests, sourceKey, launch,
    mode: (value: string) => { mode = value; sent = false; },
    tomorrow: () => { offset = 86400000; },
    advance: (ms=5000) => { offset+=ms;publish(); },
    replaceFleet:()=>{fleetGeneration++;publish();},
    restart: (differentExecution=false,epochChange=true,buildChange=true) => {
      restarts++;if(buildChange)build=`replacement-build-${restarts}`;if(epochChange)inputs=new EvaluationInputs({epoch:`replacement-epoch-${restarts}`});
      if(differentExecution)producerExecution=fixtureProducerExecution(10+restarts);
      source=makeSource();publish();
    },
    breakExecution:()=>{producerExecution={...producerExecution,sha256:'0'.repeat(64)};},
    freezeSyntheticIntervals:(atOverride?:number)=>{
      // Protocol setup only: this supplied artifact does not claim measured
      // calibration support. Real support/publication gates remain in force.
      const current=read(path.join(root,'state.json')),folder=path.join(root,current.id);
      const own=new ExactForecastStream(current.productionBuild,current.sourceKey,current.champion,
        {version:current.trial.id,publishedAt:current.trial.startedAt,params:current.candidate.params});
      own.recover(folder,current.source.runtime,current.source.seedSha256);
      current.candidate=structuredClone(current.candidate);current.candidate.params.CONFORMAL['2-5']=1.5;
      current.calibratedAt=atOverride??serverNow();const day=etDay(current.calibratedAt);
      current.testStartDay=current.calibrationDays.includes(day)?nextDay(day):day;
      own.setModels(current.champion,{version:current.trial.id,publishedAt:current.trial.startedAt,params:current.candidate.params});
      current.source.previousRuntime=current.source.runtime;current.source.runtime=own.persist(folder);
      const bytes=Buffer.from(JSON.stringify(current.candidate));fs.writeFileSync(path.join(folder,'calibrated-candidate.json'),bytes);
      current.calibratedCandidateSha256=digest(bytes);fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(current));
      return current;
    },
    prepareTrial: () => {
      fs.unlinkSync(path.join(root,'state.json'));
      for(let i=1;i<=7;i++){
        const day=new Date(startedAt-i*86400000).toISOString().slice(0,10),folder=path.join(root,'archives',day);fs.mkdirSync(folder);
        const at=new Date(startedAt-86400000).toISOString(),manifest:any={ok:true,generatedAt:at,tables:{}};
        for(const table of ['raw_positions','stop_visits']){
          const bytes=gzipSync(''),file=table+'.jsonl.gz';fs.writeFileSync(path.join(folder,file),bytes);
          manifest.tables[table]={complete:true,file,sha256:digest(bytes),capturedAt:at};
        }
        fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest));
      }
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, predicate: (s: any) => boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const status = read(path.join(f.root, 'status.json')); if (predicate(status)) return status; } catch {}
    await wait(100);
  }
  const last=read(path.join(f.root,'status.json'));
  throw Error('Actual CLI did not reach expected status: '+JSON.stringify({phase:last.phase,pending:last.pending,error:last.error,sourceRefusal:last.sourceRefusal}));
}
function candidateRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const state = read(path.join(f.root, 'state.json')), outer = deserialize(gunzipSync(fs.readFileSync(path.join(f.directory, state.source.runtime.file))));
  return deserialize(outer.arms.challenger.bytes);
}
describe('actual exact-source observer command', () => {
  it('runs one real poll with publication disabled even when the environment enables it', async () => {
    const f = await fixture();
    try {
      const run = f.launch(), exit = await run.exit; expect(exit, run.log()).toBe(0);
      const status = read(path.join(f.root, 'status.json'));
      expect(status).toMatchObject({ running: false, publicationEnabled: false, forecastProtocol: 'served-control-v2', protocolFailures: null });
      expect(status.productionControl.compared).toBeGreaterThan(0); expect(status.productionControl.mismatched).toBe(0);
      expect(f.requests.some(r => r.method === 'POST')).toBe(false); expect(fs.existsSync(path.join(f.root, 'observer.lock'))).toBe(false);
    } finally { await f.close(); }
  }, 30000);
  it.each(['corrupt', 'gap','unconfirmed-build','malformed'])('refuses %s input and retains its original cycle/evidence', async mode => {
    const f = await fixture();
    try {
      f.mode(mode); const run = f.launch(), exit = await run.exit; expect(exit, run.log()).toBe(1);
      const state = read(path.join(f.root, 'state.json')), status = read(path.join(f.root, 'status.json'));
      expect(state.id).toBe(f.id); expect(state.protocolFailures.count).toBe(1); expect(state.sourceRefusal.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(status).toMatchObject({ running: false, publicationEnabled: false });
      expect(f.requests.some(r => r.path === '/api/evaluation/seed' || r.method === 'POST')).toBe(false);
      expect(fs.existsSync(path.join(f.root, 'observer.lock'))).toBe(false);
    } finally { await f.close(); }
  }, 30000);
  it('refuses a damaged own-runtime checkpoint without adopting champion history or starting a new cycle',async()=>{
    const f=await fixture();
    try{
      const file=path.join(f.directory,read(path.join(f.root,'state.json')).source.runtime.file),bytes=fs.readFileSync(file);
      bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);
      const run=f.launch();expect(await run.exit,run.log()).toBe(1);
      const state=read(path.join(f.root,'state.json'));expect(state.id).toBe(f.id);expect(state.sourceRefusal.reason).toContain('checksum');
      expect(state.protocolFailures.count).toBe(1);expect(f.requests.some(r=>r.path==='/api/evaluation/seed'||r.method==='POST')).toBe(false);
      expect(digest(fs.readFileSync(file))).not.toBe(state.source.runtime.sha256);
    }finally{await f.close();}
  },30000);
  it('refuses a removed warming journal without recreating its source or publishing',async()=>{
    const f=await fixture();try{const before=read(path.join(f.root,'state.json')),name=Object.keys(before.source.inputFiles)[0]!;fs.unlinkSync(path.join(f.directory,name));const run=f.launch();expect(await run.exit,run.log()).toBe(1);const after=read(path.join(f.root,'state.json'));expect(after.id).toBe(f.id);expect(after.sourceRefusal).toBeTruthy();expect(after.source.inputFiles).toEqual(before.source.inputFiles);expect(f.requests.some(r=>r.path==='/api/evaluation/seed'||r.method==='POST')).toBe(false);}finally{await f.close();}
  },30000);
  it('restores the candidate own runtime across two real command executions', async () => {
    const f = await fixture();
    try {
      const before = candidateRuntime(f), first = f.launch(); expect(await first.exit, first.log()).toBe(0);
      const middle = candidateRuntime(f), second = f.launch(); expect(await second.exit, second.log()).toBe(0);
      const after = candidateRuntime(f);
      expect(after.modelParams).toEqual(before.modelParams); expect(middle.cache.evaluationRows).toEqual(before.cache.evaluationRows);
      expect(after.cache.evaluationRows).toEqual(before.cache.evaluationRows);
      expect(f.requests.some(r => r.path === '/api/evaluation/seed' || r.method === 'POST')).toBe(false);
    } finally { await f.close(); }
  }, 30000);
  it.each(['changed-build','changed-epoch'])('seals the old cycle before a %s and keeps its frozen evidence',async mode=>{
    const f=await fixture();
    try{
      const before=digest(fs.readFileSync(path.join(f.directory,'frozen-candidate.json')));f.mode(mode);
      const run=f.launch();expect(await run.exit,run.log()).toBe(1);
      const closed=read(path.join(f.directory,'closed-state.json')),status=read(path.join(f.root,'status.json'));
      expect(closed.id).toBe(f.id);expect(closed.invalidatedAt).toBeGreaterThan(0);
      expect(digest(fs.readFileSync(path.join(f.directory,'frozen-candidate.json')))).toBe(before);
      expect(status.error).toContain('Need seven archived');expect(status.running).toBe(false);
      expect(f.requests.some(r=>r.method==='POST')).toBe(false);
    }finally{await f.close();}
  },30000);
  it('runs idle service in calibration without inventing a new inference clock',async()=>{
    const f=await fixture();
    try{
      const before=read(path.join(f.root,'state.json')).source.runtime;f.tomorrow();f.mode('idle');
      const run=f.launch();expect(await run.exit,run.log()).toBe(0);
      const status=read(path.join(f.root,'status.json')),after=read(path.join(f.root,'state.json')).source.runtime;
      expect(status).toMatchObject({phase:'calibration',idleService:true,forecasts:{champion:0,challenger:0},protocolFailures:null});
      expect(after.cursor).toBe(before.cursor);expect(after.at).toBe(before.at);expect(status.productionControl.modelAt).toBe(before.at);
      expect(f.requests.some(r=>r.method==='POST'||r.path==='/api/evaluation/seed')).toBe(false);
    }finally{await f.close();}
  },30000);
  it('continues real CLI polling through expired modeled GPS and resumes on the next observation', async () => {
    const f = await fixture();
    try {
      const before = read(path.join(f.root, 'state.json')).source.runtime;
      f.tomorrow(); f.mode('expired-fleet');
      const waiting = f.launch(); expect(await waiting.exit, waiting.log()).toBe(0);
      const idle = read(path.join(f.root, 'status.json'));
      expect(idle).toMatchObject({phase: 'calibration', idleService: false,
        forecasts: {champion: 0, challenger: 0}, protocolFailures: null,
        productionControl: {modelAt: before.at, compared: 0, matched: 0, missing: 0, mismatched: 0}});
      expect(idle.error).toBeUndefined();
      expect(read(path.join(f.root, 'state.json')).source.runtime.cursor).toBe(before.cursor);
      f.mode('advance'); const returning = f.launch(); expect(await returning.exit, returning.log()).toBe(0);
      const resumed = read(path.join(f.root, 'status.json'));
      expect(resumed.productionControl.compared).toBeGreaterThan(0);
      expect(resumed.sourceRefusal).toBeNull(); expect(resumed.protocolFailures).toBeNull();
      expect(resumed.cycle).toBe(f.id);
      expect(f.requests.some(r => r.method === 'POST' || r.path === '/api/evaluation/seed')).toBe(false);
    } finally { await f.close(); }
  }, 30000);
  it('exits a refused-source wait after installed source changes, preserving its original failed cohort', async () => {
    const f=await fixture(true);let run: ReturnType<typeof f.launch>|undefined;
    const pairs=()=>Object.fromEntries(fs.readdirSync(f.directory).filter(n=>/^pairs-.*\.jsonl$/.test(n))
      .map(n=>[n,fs.readFileSync(path.join(f.directory,n),'utf8')]));
    try {
      f.tomorrow();f.mode('advance');run=f.launch(false);
      await ready(f,s=>s.phase==='calibration'&&s.pending>0);
      f.mode('corrupt');await ready(f,s=>s.sourceRefusal&&s.protocolFailures?.count===1&&s.pending===0);
      const refused=read(path.join(f.root,'state.json')),frozen=fs.readFileSync(path.join(f.directory,'frozen-candidate.json')),
        beforePairs=pairs(),headCount=f.requests.filter(r=>r.path==='/api/evaluation/inputs').length;
      expect(Object.keys(beforePairs).length).toBeGreaterThan(0);
      // A healthy head alone must not clear the refusal or retry the cohort.
      f.mode('healthy');const deadline=Date.now()+5000;
      while(f.requests.filter(r=>r.path==='/api/evaluation/inputs').length===headCount&&Date.now()<deadline)await wait(50);
      expect(f.requests.filter(r=>r.path==='/api/evaluation/inputs').length).toBeGreaterThan(headCount);
      expect(run.child.exitCode).toBeNull();expect(read(path.join(f.root,'state.json')).sourceRefusal).toEqual(refused.sourceRefusal);
      fs.appendFileSync(path.join(f.service,'scripts/canary-metrics.mjs'),'\n// Isolated regression source change.\n');
      const exit=await Promise.race([run.exit,wait(16000).then(()=> 'still-running')]);
      expect(exit,run.log()).toBe(1);
      const after=read(path.join(f.root,'state.json')),status=read(path.join(f.root,'status.json'));
      expect(status.running).toBe(false);expect(status.error).toContain('restart required');
      expect(after.id).toBe(f.id);expect(after.sourceKey).toBe(f.sourceKey);
      expect(after.sourceRefusal).toEqual(refused.sourceRefusal);expect(after.protocolFailures).toEqual(refused.protocolFailures);
      expect(after.pending).toEqual(refused.pending);expect(pairs()).toEqual(beforePairs);
      expect(fs.readFileSync(path.join(f.directory,'frozen-candidate.json'))).toEqual(frozen);
      const rows=Object.values(beforePairs).flatMap(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
      expect(rows.every(r=>r.det===null&&r.reason==='source-protocol-refusal')).toBe(true);
      expect(f.requests.some(r=>r.method==='POST'||r.path==='/api/evaluation/seed')).toBe(false);
      expect(fs.existsSync(path.join(f.root,'observer.lock'))).toBe(false);
    }finally{if(run&&run.child.exitCode===null){run.child.kill('SIGKILL');await run.exit;}await f.close();}
  },45000);
  it('retains predictions as missing after a mid-run source failure during calibration', async () => {
    const f = await fixture(); let run: ReturnType<typeof f.launch> | undefined;
    try {
      f.tomorrow(); f.mode('advance'); run = f.launch(false);
      await ready(f, s => s.phase === 'calibration' && s.pending > 0);
      f.mode('corrupt'); await ready(f, s => s.sourceRefusal && s.protocolFailures?.count === 1 && s.pending === 0);
      run.child.kill('SIGTERM'); await run.exit;
      const state = read(path.join(f.root, 'state.json'));
      expect(state.id).toBe(f.id); expect(state.sourceRefusal).toBeTruthy();
      const rows = fs.readdirSync(f.directory).filter(n => /^pairs-.*\.jsonl$/.test(n)).flatMap(n => fs.readFileSync(path.join(f.directory, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
      expect(rows.length).toBeGreaterThan(0); expect(rows.every(r => r.det === null && r.reason === 'source-protocol-refusal')).toBe(true);
      expect(f.requests.some(r => r.method === 'POST' || r.path === '/api/evaluation/seed')).toBe(false);
    } finally { if (run && run.child.exitCode === null) { run.child.kill('SIGKILL'); await run.exit; } await f.close(); }
  }, 30000);
});


describe('actual frozen trial continuity across producer contexts',()=>{
 async function initialize(){
  const f=await fixture(true,true);f.prepareTrial();
  try{
   const run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const initial=read(path.join(f.root,'state.json'));expect(initial.trial.id).toBe(initial.id);expect(initial.trainingDays).toHaveLength(7);
   return {f,initial};
  }catch(error){await f.close();throw error;}
 }
 it.each(['epoch','build'])('preserves calibration and the full unknown cohort after a real %s change across an ET date',async kind=>{
  const {f,initial}=await initialize();
  try{
   f.advance(86400000);let run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const before=read(path.join(f.root,'state.json'));expect(Object.values(before.pending).some((p:any)=>!p.closed)).toBe(true);
   f.restart(false,kind==='epoch',kind==='build');run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const after=read(path.join(f.root,'state.json'));expect(after.id).not.toBe(initial.id);expect(after.trial.id).toBe(initial.id);
   expect(after.calibrationDays).toEqual(initial.calibrationDays);expect(after.candidate).toEqual(initial.candidate);expect(after.trainingInputs).toEqual(initial.trainingInputs);
   expect(after.priorContexts.map((c:any)=>c.id)).toEqual([initial.id]);expect(after.contextQualifiedAt).toBeNull();
   const rows=readTrialPairs(f.root,after);expect(rows.length).toBeGreaterThan(0);expect(rows.every((p:any)=>p.det===null)).toBe(true);
   expect(rows.every((p:any)=>p.sourceContextId===initial.id)).toBe(true);verifyContextTransitions(f.root,trialContexts(f.root,after));
   f.advance(10000);run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const qualified=read(path.join(f.root,'state.json'));expect(qualified.contextQualifiedAt).toBeGreaterThan(qualified.startedAt);
   expect(qualified.contextQualification.source.epoch).toBe(qualified.source.epoch);
   expect(qualified.trial.id).toBe(initial.id);expect(f.requests.some(r=>r.method==='POST')).toBe(false);
  }finally{await f.close();}
 },60000);
 it('preserves the original trial after a local UI edit and restores its own current-context checkpoint',async()=>{
  const {f,initial}=await initialize();
  try{
   fs.appendFileSync(path.join(f.service,'web/src/PickupReminderControls.tsx'),'\n// fixture UI change\n');
   let run=f.launch();expect(await run.exit,run.log()).toBe(0);const after=read(path.join(f.root,'state.json'));
   expect(after.trial.id).toBe(initial.id);expect(after.sourceKey).not.toBe(initial.sourceKey);expect(after.calibrationDays).toEqual(initial.calibrationDays);
   expect(after.executionIdentity.sha256).toBe(initial.executionIdentity.sha256);verifyContextTransitions(f.root,trialContexts(f.root,after));
   const seedRequests=f.requests.filter(r=>r.path==='/api/evaluation/seed').length;
   run=f.launch();expect(await run.exit,run.log()).toBe(0);const resumed=read(path.join(f.root,'state.json'));
   expect(resumed.id).toBe(after.id);expect(resumed.trial.id).toBe(initial.id);
   expect(f.requests.filter(r=>r.path==='/api/evaluation/seed')).toHaveLength(seedRequests);
  }finally{await f.close();}
 },60000);
 it('starts a separate trial for genuinely changed producer execution bytes',async()=>{
  const {f,initial}=await initialize();try{
   f.restart(true);const run=f.launch();expect(await run.exit,run.log()).toBe(0);const after=read(path.join(f.root,'state.json'));
   expect(after.trial.id).not.toBe(initial.trial.id);expect(after.priorContexts).toEqual([]);
   expect(after.trial.producerExecutionSHA256).not.toBe(initial.trial.producerExecutionSHA256);
   expect(fs.existsSync(path.join(f.root,initial.id,'closed-state.json'))).toBe(true);
  }finally{await f.close();}
 },60000);
 it('refuses a missing linked prior journal during current-context process recovery',async()=>{
  const {f,initial}=await initialize();try{
   f.advance(5000);let run=f.launch();expect(await run.exit,run.log()).toBe(0);f.restart();run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const after=read(path.join(f.root,'state.json')),closed=read(path.join(f.root,initial.id,'closed-state.json'));
   const file=Object.keys(closed.source.inputFiles)[0]!;fs.unlinkSync(path.join(f.root,initial.id,file));
   run=f.launch();expect(await run.exit,run.log()).toBe(1);const refused=read(path.join(f.root,'state.json'));
   expect(refused.id).toBe(after.id);expect(refused.sourceRefusal).toBeTruthy();expect(refused.protocolFailures.count).toBeGreaterThan(0);
  }finally{await f.close();}
 },60000);
 it('preserves a supplied calibrated artifact and complete evidence over three actual producer contexts',async()=>{
  const {f,initial}=await initialize();try{
   f.advance(86400000);let run=f.launch();expect(await run.exit,run.log()).toBe(0);
   // Move Thursday's unqualified cohort to Monday, then supply the frozen
   // artifact on Tuesday so the retained daytime buses stay in weekday hours.
   f.advance(4*86400000);run=f.launch();expect(await run.exit,run.log()).toBe(0);
   f.advance(86400000);const supplied=f.freezeSyntheticIntervals();f.advance(5000);
   run=f.launch();expect(await run.exit,run.log()).toBe(0);
   for(let i=0;i<2;i++){
    f.restart();run=f.launch();expect(await run.exit,run.log()).toBe(0);
    const current=read(path.join(f.root,'state.json'));expect(current.trial.id).toBe(initial.id);expect(current.priorContexts).toHaveLength(i+1);
    expect(current.candidate).toEqual(supplied.candidate);expect(current.calibratedAt).toBe(supplied.calibratedAt);
    expect(current.testStartDay).toBe(supplied.testStartDay);expect(current.contextQualifiedAt).toBeNull();
    verifyContextTransitions(f.root,trialContexts(f.root,current));
    f.advance(10000);run=f.launch();expect(await run.exit,run.log()).toBe(0);
   }
   const final=read(path.join(f.root,'state.json'));expect(final.contextQualifiedAt).toBeGreaterThan(final.startedAt);
   expect(final.calibratedCandidateSha256).toBe(supplied.calibratedCandidateSha256);
   expect(f.requests.some(r=>r.method==='POST')).toBe(false);
  }finally{await f.close();}
 },90000);
 it('keeps pre-fit qualification at the freeze timestamp and waits for a date untouched by extended calibration',async()=>{
  const {f,initial}=await initialize();try{
   f.advance(5*86400000);let run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const qualified=read(path.join(f.root,'state.json'));expect(qualified.contextQualification.intervalsFrozenAt).toBeNull();
   expect(qualified.calibrationDays).toContain(etDay(qualified.contextQualifiedAt));
   const supplied=f.freezeSyntheticIntervals(qualified.contextQualifiedAt);f.advance(5000);
   run=f.launch();expect(await run.exit,run.log()).toBe(0);const tested=read(path.join(f.root,'state.json'));
   expect(readTrialPairs(f.root,tested).some((row:any)=>row.phase==='test')).toBe(false);
   expect(read(path.join(f.root,'status.json')).phase).toBe('settling-calibration');
   expect(tested.contextQualification.at).toBe(tested.calibratedAt);expect(tested.contextQualification.intervalsFrozenAt).toBeNull();
   // The previous fleet's closed visit/horizon identities remain retained.
   // Introduce new buses through the real producer to obtain new prospective
   // forecasts; an unchanged fixture cannot manufacture another visit.
   f.advance(86400000);f.replaceFleet();run=f.launch();expect(await run.exit,run.log()).toBe(0);
   const untouched=read(path.join(f.root,'state.json')),pending=Object.values(untouched.pending).filter((row:any)=>row.phase==='test');
   expect(pending.length).toBeGreaterThan(0);expect(pending.every((row:any)=>!untouched.calibrationDays.includes(row.day))).toBe(true);
   expect(read(path.join(f.root,'status.json')).phase).toBe('test');
   f.restart();run=f.launch();expect(await run.exit,run.log()).toBe(0);const carried=read(path.join(f.root,'state.json'));
   const rows=readTrialPairs(f.root,carried).filter((row:any)=>row.phase==='test');
   expect(rows.length).toBe(pending.length);expect(rows.every((row:any)=>!carried.calibrationDays.includes(row.day)&&row.det===null)).toBe(true);
   expect(carried.trial.id).toBe(initial.id);expect(carried.calibratedCandidateSha256).toBe(supplied.calibratedCandidateSha256);
   expect(carried.sourceRefusal).toBeUndefined();verifyContextTransitions(f.root,trialContexts(f.root,carried));
  }finally{await f.close();}
 },90000);
 it.each(['gap','unconfirmed-build','malformed','invalid-json'])('retains a real trial refusal for %s without inventing another clean cohort',async mode=>{
  const {f,initial}=await initialize();try{
   f.mode(mode);const run=f.launch();expect(await run.exit,run.log()).toBe(1);
   const current=read(path.join(f.root,'state.json'));expect(current.trial.id).toBe(initial.id);expect(current.sourceRefusal).toBeTruthy();
   expect(current.protocolFailures.count).toBeGreaterThan(0);expect(f.requests.some(r=>r.method==='POST')).toBe(false);
   if(mode==='invalid-json')expect(Object.values(current.source.events).some((r:any)=>read(path.join(f.root,current.id,r.file)).exchange?.raw==='invalid json')).toBe(true);
  }finally{await f.close();}
 },60000);
 it('refuses a producer head whose execution attestation is malformed after restart',async()=>{
  const {f,initial}=await initialize();try{
   f.restart();f.breakExecution();const run=f.launch();expect(await run.exit,run.log()).toBe(1);
   const current=read(path.join(f.root,'state.json'));expect(current.id).toBe(initial.id);expect(current.sourceRefusal.reason).toContain('execution identity');
   expect(f.requests.some(r=>r.method==='POST')).toBe(false);
  }finally{await f.close();}
 },60000);
 it('keeps a prior source refusal after a compatible UI source reload',async()=>{
  const {f,initial}=await initialize();try{
   f.mode('corrupt');let run=f.launch();expect(await run.exit,run.log()).toBe(1);const refused=read(path.join(f.root,'state.json'));
   f.mode('healthy');fs.appendFileSync(path.join(f.service,'web/src/PickupReminderControls.tsx'),'\n// compatible fixture repaint\n');
   run=f.launch();expect(await run.exit,run.log()).toBe(1);const after=read(path.join(f.root,'state.json'));
   expect(after.id).toBe(initial.id);expect(after.sourceRefusal).toEqual(refused.sourceRefusal);expect(after.protocolFailures).toEqual(refused.protocolFailures);
   expect(f.requests.some(r=>r.method==='POST')).toBe(false);
  }finally{await f.close();}
 },60000);
});
