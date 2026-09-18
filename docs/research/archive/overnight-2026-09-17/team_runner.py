#!/usr/bin/env python3
"""Two supervised overnight builder/reviewer teams, with serialized publication."""
import argparse, datetime as dt, fcntl, fnmatch, hashlib, json, os, pathlib, signal, subprocess, sys, time, urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
REMOTE='grtwrn/yale-shuttle'
ACTIVE=None
STOP=False
class Deferred(RuntimeError):pass
class StopNight(RuntimeError):pass

def low_memory():
 # This Pi has no memory cgroup controller; MemoryMax alone is not enforced.
 # Leave headroom for the production watcher and other existing services.
 for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
  if line.startswith('MemAvailable:'):return int(line.split()[1])<768*1024
 raise Deferred('Cannot verify available memory before running a model')

def save(path,value,durable=False):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.tmp')
 with tmp.open('w')as f:
  f.write(json.dumps(value,indent=2)+'\n')
  if durable:f.flush();os.fsync(f.fileno())
 tmp.replace(path)
 if durable:
  directory=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def stop_handler(signum,frame):
 global STOP
 STOP=True
 if ACTIVE is not None:
  try:os.killpg(ACTIVE.pid,signal.SIGTERM)
  except ProcessLookupError:pass

def run(argv,cwd=None,timeout=120,stdin=None):
 p=subprocess.run([str(a) for a in argv],cwd=cwd,input=stdin,text=True,capture_output=True,timeout=timeout)
 if p.returncode:raise Deferred(f'{argv[0]} failed ({p.returncode}): '+(p.stderr or p.stdout)[-2500:])
 return p.stdout.strip()
def git(repo,*args):return run(['git',*args],cwd=repo)
def api(path,method='GET',data=None):
 argv=['gh','api',f'repos/{REMOTE}/{path}','--method',method]
 if data is not None:argv+=['--input','-']
 return json.loads(run(argv,stdin=json.dumps(data)if data is not None else None))
def changed(repo,base=None):
 names=git(repo,'diff','--name-only','-z',base or 'HEAD').split('\0')
 names+=git(repo,'ls-files','--others','--exclude-standard','-z').split('\0')
 return sorted(set(n for n in names if n))
def allowed(path):
 p=pathlib.PurePosixPath(path)
 return (not p.is_absolute() and '..'not in p.parts and
  (path.startswith('services/shuttle-v2/') or path.startswith('docs/')) and
  not any(part.startswith('.env')or part in ['node_modules','store','.git','.codex','.agents']for part in p.parts) and
  not path.endswith(('.db','.sqlite','.pem','.key')))
def fingerprint(repo):
 # Include file content, not only porcelain status: a reviewer could change
 # an already-modified file without changing its status letter.
 names=changed(repo);h=hashlib.sha256(git(repo,'rev-parse','HEAD').encode())
 h.update(run(['git','diff','HEAD','--binary'],cwd=repo).encode())
 h.update(git(repo,'status','--porcelain=v1','-z').encode())
 for name in names:
  p=pathlib.Path(repo)/name
  if p.is_symlink():h.update(name.encode()+os.readlink(p).encode())
  elif p.is_file():h.update(name.encode()+p.read_bytes())
 return h.hexdigest()
def review_valid(v,head,base,needs_tests=True):
 tests=v.get('tests',[])
 return (v.get('verdict')=='approve' and v.get('head_sha')==head and v.get('base_sha')==base and
  v.get('blocking_findings')==[] and (not needs_tests or bool(tests)) and
  all(t.get('exit_code')==0 and t.get('command') and t.get('result')for t in tests))
def checks_ready(checks,required):
 latest={}
 for c in checks:
  if c['name']not in latest or c['id']>latest[c['name']]['id']:latest[c['name']]=c
 return (set(required)<=latest.keys() and
  all(latest[n].get('status')=='completed' and latest[n].get('conclusion')=='success'for n in required) and
  all(c.get('status')=='completed' and c.get('conclusion') in ['success','neutral','skipped']for c in latest.values()))
def checks_failed(checks):
 latest={}
 for c in checks:
  if c['name']not in latest or c['id']>latest[c['name']]['id']:latest[c['name']]=c
 return any(c.get('conclusion')in ['failure','cancelled','timed_out','action_required','startup_failure']for c in latest.values())
def required_checks(repo,files):
 if not any(f.startswith('services/shuttle-v2/')for f in files):return []
 # Read the repository's actual accuracy path list; gate changes cannot ship
 # in these teams' allowed file scope.
 text=(pathlib.Path(repo)/'.github/workflows/accuracy.yml').read_text()
 patterns=[l.strip()[3:-1]for l in text.splitlines()if l.strip().startswith('- "')and l.strip().endswith('"')]
 return ['gates']+(['replay']if any(fnmatch.fnmatch(f,p)for f in files for p in patterns)else [])

BUILD_SCHEMA={'type':'object','properties':{
 'outcome':{'type':'string','enum':['candidate','research','blocked']},'summary':{'type':'string'},'next_task':{'type':'string'},
 'tests':{'type':'array','items':{'type':'string'}}},'required':['outcome','summary','next_task','tests'],'additionalProperties':False}
REVIEW_SCHEMA={'type':'object','properties':{
 'verdict':{'type':'string','enum':['approve','changes_requested','research_only']},'summary':{'type':'string'},
 'head_sha':{'type':'string'},'base_sha':{'type':'string'},'next_task':{'type':'string'},
 'blocking_findings':{'type':'array','items':{'type':'string'}},
 'tests':{'type':'array','items':{'type':'object','properties':{'command':{'type':'string'},'exit_code':{'type':'integer'},'result':{'type':'string'}},'required':['command','exit_code','result'],'additionalProperties':False}}},
 'required':['verdict','summary','head_sha','base_sha','next_task','blocking_findings','tests'],'additionalProperties':False}

class Team:
 def __init__(self,a):
  self.a=a;self.dir=ROOT/a.team;self.dir.mkdir(exist_ok=True);self.repo=pathlib.Path(a.repo)
  self.path=self.dir/'status.json';self.state=json.loads(self.path.read_text())if self.path.exists()else {'round':0,'history':[]}
  self.until=dt.datetime.fromisoformat(a.until).timestamp();self.started=time.time()
 def status(self,durable=False,**kw):
  self.state.update(kw);self.state['heartbeat']=now();save(self.path,self.state,durable=durable)
 def pause(self,seconds,allow_finish=False):
  end=time.time()+seconds
  while time.time()<end:
   if STOP:raise StopNight('service stopping')
   if not allow_finish and time.time()>=self.until:raise StopNight('overnight deadline reached')
   self.status();time.sleep(min(5,max(0,end-time.time())))
 def model(self,role,prompt,seconds,schema):
  global ACTIVE
  if low_memory():raise Deferred('Available memory below 768 MiB; backing off before model work')
  tag=f'{self.state["round"]:03d}-{role}-{int(time.time())}'
  log=self.dir/(tag+'.jsonl');out=self.dir/(tag+'.json');spec=self.dir/(role+'-schema.json');save(spec,schema)
  argv=['codex','exec','-s','danger-full-access','-c','approval_policy="never"','--ephemeral','--json','-C',str(self.repo),
        '--output-schema',str(spec),'-o',str(out),'-']
  self.status(phase=role,log=str(log),role_started=now(),model_pid=None)
  with log.open('w')as stream:
   p=subprocess.Popen(argv,cwd=self.repo,stdin=subprocess.PIPE,stdout=stream,stderr=subprocess.STDOUT,text=True,start_new_session=True)
   ACTIVE=p;self.status(model_pid=p.pid)
   try:
    p.stdin.write(prompt);p.stdin.close();deadline=min(self.until,time.time()+seconds)
    while p.poll()is None:
     memory_pressure=low_memory()
     if STOP or time.time()>=deadline or memory_pressure or log.stat().st_size>128*1024*1024:
      os.killpg(p.pid,signal.SIGTERM)
      try:p.wait(timeout=15)
      except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
      raise Deferred('Model interrupted by '+('low available memory'if memory_pressure else 'stop/deadline/log limit')+'; source/artifacts preserved for recovery')
     self.status();time.sleep(5)
    if p.returncode:raise Deferred(f'{role} exited {p.returncode}; inspect {log}')
    if not out.exists():raise Deferred(f'{role} did not write structured result: {log}')
    result=json.loads(out.read_text());self.status(last_result=str(out));return result
   finally:
    try:
     # Any monitor exception must also reap its live worker before retrying.
     if p.poll()is None:
      try:os.killpg(p.pid,signal.SIGTERM)
      except ProcessLookupError:pass
      try:p.wait(timeout=15)
      except subprocess.TimeoutExpired:
       try:os.killpg(p.pid,signal.SIGKILL)
       except ProcessLookupError:pass
       p.wait()
    finally:ACTIVE=None;self.status(model_pid=None)
 def context(self):
  return '\n\n'.join((ROOT/'COMMON.md').read_text()for _ in [0])+f'\nTEAM: {self.a.team}\nWORKTREE: {self.repo}\nARTIFACTS: {self.dir}\nDEADLINE: {self.a.until}\nRead your HANDOFF.md, BACKLOG.md, FIRST_TASK.md (if present) and every current REVIEW/PROGRESS note before acting.\nCurrent controller state:\n'+json.dumps(self.state,indent=2)[-18000:]
 def build(self):
  return self.model('builder',self.context()+'\n\n'+(ROOT/'BUILDER.md').read_text(),self.a.builder_seconds,BUILD_SCHEMA)
 def review(self,base,head,has_code):
  before=fingerprint(self.repo)
  prompt=self.context()+'\n\n'+(ROOT/'REVIEWER.md').read_text()+f'\nExact base {base}; exact head {head}; candidate diff present: {has_code}.\n'
  v=self.model('reviewer',prompt,self.a.reviewer_seconds,REVIEW_SCHEMA)
  if fingerprint(self.repo)!=before:raise Deferred('Reviewer changed checkout content; fresh builder and review required')
  self.status(review=v);save(self.dir/'REVIEW.json',v);return v
 def commit_work(self,result):
  files=changed(self.repo)
  if any(not allowed(p)for p in files):raise Deferred('Files outside app/docs scope require correction: '+repr(files))
  if files:
   run(['git','add','--',*files],cwd=self.repo)
   run(['git','diff','--cached','--check'],cwd=self.repo)
   run(['git','commit','-m',f'{self.a.team}: '+result['summary'].splitlines()[0][:100]],cwd=self.repo)
  return git(self.repo,'rev-parse','HEAD')
 def acquire(self,name):
  lock=(ROOT/name).open('a')
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);return lock
   except BlockingIOError:self.status(phase='waiting_for_publication');self.pause(15)
 def verify_deploy(self,prnum,merge,has_app,stateful=True):
  if not has_app:return {'docs_only':True}
  if stateful:self.status(phase='deploy',pr=prnum,merge_sha=merge)
  else:self.status(phase='verifying_pending_publication')
  deadline=time.time()+1800
  while time.time()<deadline:
   runs=api('actions/workflows/deploy.yml/runs?per_page=30')['workflow_runs'];matches=[r for r in runs if r['head_sha']==merge]
   if matches:
    latest=max(matches,key=lambda r:r['id'])
    if latest['status']=='completed':
     if latest['conclusion']!='success':
      save(ROOT/'PUBLICATION-HALTED.json',{'at':now(),'team':self.a.team,'reason':'deployment failed','run':latest['html_url'],'merge':merge})
      raise Deferred('Deployment failed; further publication halted, research may continue')
     with urllib.request.urlopen('https://yale-shuttle.fly.dev/healthz',timeout=20)as f:health=json.load(f)
     if health.get('ok') and health.get('build')==merge[:12] and health.get('serverEta',{}).get('failures',1)==0 and health.get('pollStalenessMs',999999)<30000:
      save(self.dir/f'deploy-{merge[:12]}.json',{'run':latest['html_url'],'health':health});return health
   self.pause(20,allow_finish=True)
  save(ROOT/'PUBLICATION-HALTED.json',{'at':now(),'team':self.a.team,'reason':'deployment verification timed out','merge':merge})
  raise Deferred('Deployment verification timed out; publication halted')
 def reconcile_publication(self):
  # Called ONLY under publication.lock. The shared record is written before
  # the merge RPC, so process death cannot let another team race a deployment.
  path=ROOT/'PENDING-PUBLICATION.json'
  if not path.exists():return
  pending=json.loads(path.read_text());pr=api(f'pulls/{pending["pr"]}')
  if pr.get('merged'):
   merge=pr['merge_commit_sha']
   if pr['head']['sha']!=pending['head'] or (pending.get('merge') and pending['merge']!=merge):
    save(ROOT/'PUBLICATION-HALTED.json',{'at':now(),'reason':'pending publication identity changed','pending':pending,'observed_head':pr['head']['sha'],'observed_merge':merge},durable=True)
    raise Deferred('Pending publication head/merge changed; manager inspection required')
   try:health=self.verify_deploy(pr['number'],merge,pending['has_app'],stateful=False)
   except Deferred:
    if (ROOT/'PUBLICATION-HALTED.json').exists():
     save(ROOT/f'failed-publication-{pr["number"]}.json',pending);path.unlink()
    raise
   save(ROOT/f'verified-publication-{pr["number"]}.json',{**pending,'merge':merge,'health':health,'verified_at':now()})
   path.unlink()
  else:
   # An interrupted/failed RPC may have reached GitHub. Do not assume that
   # a currently open PR proves it cannot still merge, or publish past it.
   save(ROOT/'PUBLICATION-HALTED.json',{'at':now(),'reason':'unresolved merge RPC','pending':pending,'observed_pr_state':pr['state']})
   raise Deferred('Merge outcome unresolved; publication halted pending manager inspection')
 def publish(self,base,head,verdict,files):
  if (ROOT/'PUBLICATION-HALTED.json').exists():raise Deferred('Publication halted; see PUBLICATION-HALTED.json')
  if not review_valid(verdict,head,base,any(f.startswith('services/shuttle-v2/')for f in files)):
   raise Deferred('Review does not approve the exact head/base with passing tests')
  if git(self.repo,'rev-parse','HEAD')!=head or changed(self.repo):raise Deferred('Checkout changed after review')
  if api('commits/master')['sha']!=base:raise Deferred('Master advanced; integrate and repeat independent review')
  branch=git(self.repo,'branch','--show-current');run(['git','push','-u','origin',branch],cwd=self.repo)
  body=self.state['builder']['summary']+'\n\nIndependent '+self.a.team+' review of `'+head+'` against `'+base+'`:\n'+verdict['summary']+'\n\nValidation:\n'+'\n'.join('- '+t['command']+': '+t['result']for t in verdict['tests'])
  prs=api('pulls?state=open&head=grtwrn:'+branch)
  data={'title':self.state['builder']['summary'].splitlines()[0][:110],'body':body}
  pr=api('pulls/'+str(prs[0]['number']),'PATCH',data)if prs else api('pulls','POST',{**data,'base':'master','head':branch})
  self.status(phase='ci',pr=pr['number'],pr_url=pr['html_url'],reviewed_head=head,reviewed_base=base,has_app=any(f.startswith('services/shuttle-v2/')for f in files))
  deadline=time.time()+1800;required=required_checks(self.repo,files)
  while time.time()<deadline:
   if STOP or time.time()>=self.until:raise StopNight('Deadline before merge; reviewed PR remains open')
   pr=api(f'pulls/{pr["number"]}')
   if pr['state']!='open' or pr['head']['sha']!=head:raise Deferred('PR closed or head changed after review')
   if pr['base']['sha']!=base or api('commits/master')['sha']!=base:raise Deferred('Master advanced during CI; fresh review required')
   checks=api(f'commits/{head}/check-runs?per_page=100')
   if checks['total_count']>100:raise Deferred('Check list incomplete')
   if checks_failed(checks['check_runs']):raise Deferred('CI failed; fix and repeat review')
   if checks_ready(checks['check_runs'],required):break
   self.pause(20)
  else:raise Deferred('CI did not finish within30min')
  # Respect an external reviewer or manually blocked PR before any merge.
  reviews=api(f'pulls/{pr["number"]}/reviews?per_page=100');latest_reviews={}
  for r in reviews:
   if r['state'] in ['APPROVED','CHANGES_REQUESTED','DISMISSED']:
    author=r['user']['login']
    if author not in latest_reviews or r['id']>latest_reviews[author]['id']:latest_reviews[author]=r
  if len(reviews)>=100 or any(r['state']=='CHANGES_REQUESTED'for r in latest_reviews.values()):raise Deferred('Human changes requested or review list incomplete')
  query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}'
  threads=json.loads(run(['gh','api','graphql','-f','query='+query,'-f','owner=grtwrn','-f','name=yale-shuttle','-F','n='+str(pr['number'])]))['data']['repository']['pullRequest']['reviewThreads']
  if threads['pageInfo']['hasNextPage']or any(not t['isResolved']for t in threads['nodes']):raise Deferred('Unresolved review thread')
  if (ROOT/'PUBLICATION-HALTED.json').exists()or (ROOT/'PENDING-PUBLICATION.json').exists()or api('commits/master')['sha']!=base:raise Deferred('Publication state/base changed before merge')
  if STOP or time.time()>=self.until:raise StopNight('Stopped/deadline immediately before merge; PR left open')
  self.status(phase='merging')
  save(ROOT/'PENDING-PUBLICATION.json',{'at':now(),'team':self.a.team,'pr':pr['number'],'head':head,'base':base,'has_app':self.state['has_app'],'stage':'merge_rpc'},durable=True)
  result=api(f'pulls/{pr["number"]}/merge','PUT',{'merge_method':'squash','sha':head})
  if not result.get('merged'):
   (ROOT/'PENDING-PUBLICATION.json').unlink()
   raise Deferred('GitHub refused expected-head merge')
  merge=result['sha'];self.status(phase='deploy',merge_sha=merge)
  save(ROOT/'PENDING-PUBLICATION.json',{'at':now(),'team':self.a.team,'pr':pr['number'],'head':head,'base':base,'has_app':self.state['has_app'],'stage':'deploy','merge':merge},durable=True)
  health=self.verify_deploy(pr['number'],merge,self.state['has_app'])
  save(ROOT/f'verified-publication-{pr["number"]}.json',{'at':now(),'team':self.a.team,'pr':pr['number'],'merge':merge,'health':health})
  (ROOT/'PENDING-PUBLICATION.json').unlink()
  self.state['history'].append({'round':self.state['round'],'at':now(),'pr':pr['html_url'],'merge':merge,'health':health,'summary':self.state['builder']['summary']})
  self.status(phase='round_complete',pr=None,merge_sha=None,last_error=None,consecutive_errors=0)
 def reconcile(self):
  if not self.state.get('pr'):return
  pr=api(f'pulls/{self.state["pr"]}')
  if pr.get('merged'):
   verified=ROOT/f'verified-publication-{pr["number"]}.json'
   if verified.exists():health=json.loads(verified.read_text())['health']
   elif (ROOT/'PUBLICATION-HALTED.json').exists():health={'publication_halted':True,'details':str(ROOT/'PUBLICATION-HALTED.json')}
   else:health=self.verify_deploy(pr['number'],pr['merge_commit_sha'],self.state.get('has_app',True))
   self.state['history'].append({'at':now(),'recovered':True,'pr':pr['html_url'],'merge':pr['merge_commit_sha'],'health':health})
   self.status(phase='round_complete',pr=None,merge_sha=None,last_error=None)
  elif pr['state']=='closed':
   raise StopNight('PR was closed externally without merge; stopping this team for manager review')
 def cycle(self):
  if self.state.get('pr'):
   with self.acquire('publication.lock'):
    if not (ROOT/'PUBLICATION-HALTED.json').exists():self.reconcile_publication()
    self.reconcile()
  if (self.dir/'PAUSE').exists():raise StopNight('Team paused by manager')
  if not (self.dir/'bootstrap-ready.json').exists():self.status(phase='waiting_for_bootstrap');self.pause(15);return
  if self.state.get('preparation') or self.state.get('phase')=='round_complete' or not self.state.get('base'):
   if changed(self.repo):raise Deferred('Unexpected dirty checkout before a new round; preserving it')
   if not self.state.get('preparation'):
    git(self.repo,'fetch','origin','master');base=git(self.repo,'rev-parse','origin/master')
    number=self.state['round']+1;branch=f'overnight/{self.a.team}-20260917-{number:03d}'
    self.status(phase='preparing_round',preparation={'round':number,'base':base,'branch':branch},durable=True)
   preparation=self.state['preparation'];number=preparation['round'];base=preparation['base'];branch=preparation['branch']
   existing=git(self.repo,'for-each-ref','--format=%(objectname)',f'refs/heads/{branch}')
   if existing:
    if existing!=base:raise Deferred('Prepared branch contains unexpected commits; preserving it for manager inspection')
    git(self.repo,'checkout',branch)
   else:git(self.repo,'checkout','-b',branch,base)
   self.status(round=number,base=base,branch=branch,phase='builder',review=None,preparation=None,durable=True)
  before_head=git(self.repo,'rev-parse','HEAD');before_branch=git(self.repo,'branch','--show-current')
  result=self.build()
  if git(self.repo,'rev-parse','HEAD')!=before_head or git(self.repo,'branch','--show-current')!=before_branch:
   raise StopNight('Builder changed HEAD/branch outside controller; preserve work for manager inspection')
  self.status(builder=result,next_task=result['next_task'])
  if result['outcome']=='blocked':raise Deferred('Builder blocked: '+result['summary'])
  head=self.commit_work(result);base=self.state['base'];files=changed(self.repo,base)
  if not files:
   self.review(base,head,False)
   self.state['history'].append({'at':now(),'round':self.state['round'],'research':result['summary']})
   self.status(phase='round_complete',last_error=None,consecutive_errors=0);return
  if any(not allowed(p)for p in files):raise Deferred('Candidate includes files outside allowed app/docs scope')
  with self.acquire('publication.lock'):
   if not (ROOT/'PUBLICATION-HALTED.json').exists():self.reconcile_publication()
   git(self.repo,'fetch','origin','master');base=git(self.repo,'rev-parse','origin/master')
   if git(self.repo,'merge-base','HEAD',base)!=base:
    git(self.repo,'merge','--no-edit',base)
   head=git(self.repo,'rev-parse','HEAD');self.status(base=base)
   files=changed(self.repo,base);verdict=self.review(base,head,True)
   if not review_valid(verdict,head,base,any(p.startswith('services/shuttle-v2/')for p in files)):
    self.status(phase='changes_requested',last_error=verdict['summary'],next_task=verdict['next_task']);return
   if (ROOT/'PUBLICATION-HALTED.json').exists():
    self.state['history'].append({'at':now(),'round':self.state['round'],'reviewed_local_candidate':head,'branch':git(self.repo,'branch','--show-current'),'reason':'publication halted; preserved for manager'})
    self.status(phase='round_complete',last_error='Publication halted; reviewed candidate saved locally');return
   self.publish(base,head,verdict,files)
 def main(self):
  if self.state.get('phase')=='finished' and self.state.get('resume_phase'):
   self.state['phase']=self.state['resume_phase']
  self.status(running=True,deadline=self.a.until,pid=os.getpid(),team=self.a.team,repo=str(self.repo))
  while not STOP and time.time()<self.until:
   try:self.cycle()
   except StopNight as e:self.status(last_error=str(e));break
   except Exception as e:
    n=self.state.get('consecutive_errors',0)+1
    self.status(phase='retry_pending',last_error=str(e),consecutive_errors=n)
    try:self.pause(min(900,60*2**min(n-1,4)))
    except StopNight:break
   else:
    try:self.pause(30)
    except StopNight:break
  self.status(running=False,resume_phase=self.state.get('phase'),phase='finished',finished_at=now())
  save(self.dir/'MORNING-REPORT.json',self.state)

def main():
 p=argparse.ArgumentParser();p.add_argument('--team',choices=['eta','ux'],required=True);p.add_argument('--repo',required=True);p.add_argument('--until',required=True)
 p.add_argument('--builder-seconds',type=int,default=1500);p.add_argument('--reviewer-seconds',type=int,default=1200);a=p.parse_args()
 expected=ROOT.parent/f'overnight-{a.team}-2026-09-17'
 if pathlib.Path(a.repo).resolve()!=expected.resolve():raise SystemExit('Unexpected team worktree')
 signal.signal(signal.SIGTERM,stop_handler);signal.signal(signal.SIGINT,stop_handler)
 with (ROOT/(a.team+'.lock')).open('a')as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise SystemExit('Team already running')
  Team(a).main()
if __name__=='__main__':main()
