#!/usr/bin/env python3
"""Daily local fit, verified cache publication, and one controlled Fly restart.

No fitting runs on Fly. This runner requires production autofit to be disabled.
It never updates source or dependencies, resizes a VM, or prints credentials.
"""
from __future__ import annotations
import argparse, datetime as dt, fcntl, hashlib, json, os, pathlib, secrets
import shlex, signal, subprocess, sys, time, urllib.request
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
ET = ZoneInfo("America/New_York")
HELPER = ROOT / "scripts/standing-forecast-remote.mjs"


def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""): h.update(block)
    return h.hexdigest()


def dump(path, value):
    with open(path,"x") as f: json.dump(value,f,indent=2,sort_keys=True); f.write("\n")


def same_identity(a,b):
    for k in ("algorithm","policy","sourceHashes","dependencies","helperSha256"):
        if a[k]!=b[k]: raise RuntimeError("Local/remote model source or policy mismatch: "+k)


def choose_machine(rows):
    active=[r for r in rows if r.get("state")=="started"]
    if len(active)!=1: raise RuntimeError("Exactly one running production machine required")
    return active[0]["id"]


def publication_window(now=None):
    now=now or dt.datetime.now(ET)
    minutes=now.hour*60+now.minute
    return 30<=minutes<240


def validate_result(value, identity, snapshot):
    if value["algorithm"]!=identity["algorithm"] or value["policy"]!=identity["policy"]:
        raise RuntimeError("Fit fingerprint/policy mismatch")
    if value["request"]["cutoff"]!=snapshot["snapshotCutoff"] or value["fit"]["fittedAt"]!=snapshot["snapshotCutoff"]:
        raise RuntimeError("Fit did not use the frozen snapshot cutoff")
    if value["request"]["serviceDayCutoff"]!=snapshot["dayStart"] or value["diagnostics"]["serviceDayCutoff"]!=snapshot["dayStart"]:
        raise RuntimeError("Fit service-date mismatch")


def prune_owned_snapshots(state, keep=7):
    """Delete ONLY this runner's old successful snapshots; retain every receipt/fit."""
    candidates=[]
    for manifest in (state/"runs").glob("*/success.json"):
        try:
            value=json.loads(manifest.read_text()); snapshot=manifest.parent/"snapshot.db"
            if value.get("runner")!="standing-forecast-nightly-v1" or not snapshot.is_file(): continue
            if snapshot.is_symlink(): continue
            candidates.append((value["completedAt"],snapshot))
        except (OSError,ValueError,KeyError): continue
    for _,path in sorted(candidates,reverse=True)[keep:]: path.unlink()


class Runner:
    def __init__(self,args,run_dir):
        self.a=args;self.dir=run_dir;self.machine=None
        self.remote="/tmp/yale-standing-fit-"+run_dir.name
        self.install_receipt=None;self.installed=False;self.restarted=False
        self.install_attempted=False;self.rollback_confirmed=False

    def event(self,event,**fields):
        record={"at":dt.datetime.now(dt.timezone.utc).isoformat(),"event":event,**fields}
        with open(self.dir/"events.jsonl","a") as f:f.write(json.dumps(record)+"\n")
        print(json.dumps(record),flush=True)

    def call(self,label,args,timeout=180,json_output=False):
        started=time.monotonic()
        try:r=subprocess.run(args,cwd=ROOT,text=True,capture_output=True,timeout=timeout,check=False)
        except subprocess.TimeoutExpired as exc:raise RuntimeError(label+" exceeded timeout") from exc
        self.event(label,returnCode=r.returncode,elapsedSec=round(time.monotonic()-started,3))
        # CLI stderr is private diagnostic data; do not echo possible credential diagnostics.
        if r.stderr:
            with open(self.dir/(label+".stderr"),"a") as f:f.write(r.stderr)
        if r.returncode:raise RuntimeError(label+" failed; private stderr saved")
        if not json_output:return r.stdout
        for line in reversed(r.stdout.splitlines()):
            try:return json.loads(line)
            except ValueError:pass
        try:return json.loads(r.stdout)
        except ValueError as exc:raise RuntimeError(label+" returned no JSON") from exc

    def fly(self,*args):return [str(self.a.fly),*args,"--app",self.a.app]

    def ssh(self,label,argv,timeout=180):
        return self.call(label,self.fly("ssh","console","--machine",self.machine,"--command",shlex.join(argv)),timeout)

    def remote_helper(self,label,action,*args,timeout=180):
        output=self.ssh(label,["/app/node_modules/.bin/tsx",self.remote_helper_path,action,*args],timeout)
        for line in reversed(output.splitlines()):
            try:return json.loads(line)
            except ValueError:pass
        raise RuntimeError(label+" returned no JSON")

    def put(self,label,local,remote):
        self.call(label,self.fly("ssh","sftp","put",str(local),remote,"--machine",self.machine,"--mode","0600"),300)

    def get(self,label,remote,local):
        self.call(label,self.fly("ssh","sftp","get",remote,str(local),"--machine",self.machine),300)
        os.chmod(local,0o600)

    def prepare_remote(self):
        # A random, task-owned directory; mkdir cannot expose database data.
        self.ssh("prepare-remote",["mkdir","-p","-m","700",self.remote])
        self.remote_helper_path=self.remote+"/helper-"+secrets.token_hex(4)+".mjs"
        self.put("upload-helper",HELPER,self.remote_helper_path)

    def local_identity(self,label):
        return self.call(label,[self.a.node,"--import","tsx",str(HELPER),"identity","--root",str(ROOT)],json_output=True)

    def check_publication_window(self,label):
        if not publication_window():raise RuntimeError("Publication/restart allowed only00:30–04:00 America/New_York")
        with urllib.request.urlopen(self.a.health,timeout=10) as response:health=json.load(response)
        if health.get("ok") is not True or health.get("knownBuses")!=0:
            raise RuntimeError("Publication/restart requires healthy server with no known buses")
        if not publication_window():raise RuntimeError("Publication window ended during health check")
        dump(self.dir/(label+".json"),health)

    def cleanup_remote(self):
        # Literal task-owned paths only; never a general /tmp purge.
        code="const fs=require('fs');const p="+json.dumps(self.remote)+";if(!/^\\/tmp\\/yale-standing-fit-[A-Za-z0-9-]+$/.test(p))throw Error('path');fs.rmSync(p,{recursive:true,force:true});"
        try:self.ssh("cleanup-remote",["node","-e",code])
        except Exception:self.event("cleanup-remote-incomplete")

    def rollback(self):
        receipt_path=self.dir/"install-receipt.json"
        if not receipt_path.exists():
            try:self.get("recover-install-receipt",self.remote+"/install-receipt.json",receipt_path)
            except Exception:return
        try:
            receipt=json.loads(receipt_path.read_text())
            if receipt.get("action")!="installed":return
            self.prepare_remote()
            self.put("upload-rollback-receipt",receipt_path,self.remote+"/rollback-input.json")
            value=self.remote_helper("restore-cache","restore","--input",self.remote+"/rollback-input.json",
                                     "--sha",sha(receipt_path),"--receipt",self.remote+"/rollback-result.json")
            dump(self.dir/"rollback-result.json",value)
            self.rollback_confirmed=True
            # Loading the old row requires a restart only when the new one might already have loaded.
            if self.restarted:
                self.check_publication_window("before-rollback-restart-health")
                self.call("restart-restored-cache",self.fly("machine","restart",self.machine),300)
        except Exception as error:self.event("rollback-requires-review",error=str(error))

    def run(self):
        self.check_publication_window("before-run-health")
        local=self.local_identity("local-identity")
        machines=self.call("list-machines",self.fly("machine","list","--json"),json_output=True)
        self.machine=choose_machine(machines);self.prepare_remote()
        remote=self.remote_helper("remote-identity","identity")
        same_identity(local,remote)
        if not remote["autoFitDisabled"]:raise RuntimeError("Production autoFit must be disabled before daily fitting")
        if remote["machineId"]!=self.machine:raise RuntimeError("Unexpected remote machine identity")
        dump(self.dir/"identity.json",{"local":local,"remote":remote,"helperSha256":sha(HELPER),"runnerSha256":sha(__file__)})
        snapshot=self.remote_helper("snapshot-online-backup","backup","--output",self.remote+"/snapshot.db",timeout=600)
        same_identity(remote,snapshot);dump(self.dir/"snapshot.json",snapshot)
        self.get("download-snapshot",self.remote+"/snapshot.db",self.dir/"snapshot.db")
        if sha(self.dir/"snapshot.db")!=snapshot["snapshotSha256"]:raise RuntimeError("Downloaded snapshot hash mismatch")
        cutoff=dt.datetime.fromtimestamp(snapshot["snapshotCutoff"]/1000,dt.timezone.utc).isoformat()
        self.call("fit-local",[self.a.node,"--import","tsx",str(ROOT/"src/calibrator/standingForecast.fit.ts"),
                  "--db",str(self.dir/"snapshot.db"),"--at",cutoff,"--out",str(self.dir/"fit.json")],timeout=1900)
        value=json.loads((self.dir/"fit.json").read_text());validate_result(value,local,snapshot)
        same_identity(local,self.local_identity("local-identity-after-fit"))
        live=self.remote_helper("remote-identity-before-install","identity")
        same_identity(remote,live)
        if not live["autoFitDisabled"] or live["build"]!=remote["build"] or live["dayStart"]!=snapshot["dayStart"]:
            raise RuntimeError("Production environment/build/day changed during fit")
        # Provenance stays outside fitted statistics; the exact algorithm/math is untouched.
        value["offloadProvenance"]={"runner":"standing-forecast-nightly-v1","snapshotSha256":snapshot["snapshotSha256"],
            "snapshotCutoff":snapshot["snapshotCutoff"],"sourceHashes":local["sourceHashes"],"dependencies":local["dependencies"],
            "helperSha256":sha(HELPER),"originalFitSha256":sha(self.dir/"fit.json")}
        dump(self.dir/"execution-manifest.json",value["offloadProvenance"])
        value["diagnostics"]={**value["diagnostics"],"executionOrigin":"external daily runner",
            "executionProvenance":value["offloadProvenance"],"executionManifestSha256":sha(self.dir/"execution-manifest.json"),
            "publicationAuditId":self.dir.name}
        dump(self.dir/"install.json",value)
        self.check_publication_window("before-install-health")
        self.put("upload-fit",self.dir/"install.json",self.remote+"/install.json")
        self.install_attempted=True
        result=self.remote_helper("install-cache","install","--input",self.remote+"/install.json","--sha",sha(self.dir/"install.json"),"--receipt",self.remote+"/install-receipt.json")
        self.installed=True
        self.get("download-install-receipt",self.remote+"/install-receipt.json",self.dir/"install-receipt.json")
        if result["build"]!=remote["build"] or result["machineId"]!=self.machine:raise RuntimeError("Deployment changed at install")
        self.check_publication_window("before-restart-health")
        self.restarted=True
        self.call("restart-for-cache",self.fly("machine","restart",self.machine),300)
        deadline=time.monotonic()+180;health=None
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen(self.a.health,timeout=10) as response:health=json.load(response)
                if health.get("ok") and health.get("standingForecast",{}).get("fittedAt")==value["fit"]["fittedAt"] and not health["standingForecast"].get("fitting"):
                    break
            except Exception:pass
            time.sleep(5)
        else:raise RuntimeError("Restarted server did not confirm expected cached fit")
        dump(self.dir/"health.json",health)
        result={"runner":"standing-forecast-nightly-v1","completedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
                "day":dt.datetime.now(ET).date().isoformat(),"machineId":self.machine,"fitSha256":sha(self.dir/"fit.json"),
                "installSha256":sha(self.dir/"install.json"),"snapshotSha256":sha(self.dir/"snapshot.db"),
                "receiptSha256":sha(self.dir/"install-receipt.json"),"fittedAt":value["fit"]["fittedAt"],"build":health.get("build")}
        dump(self.dir/"success.json",result);dump(self.a.state/("success-"+result["day"]+".json"),result)
        try:prune_owned_snapshots(self.a.state,7)
        except OSError:self.event("snapshot-retention-incomplete")
        self.event("complete",fittedAt=result["fittedAt"],machineId=self.machine)

    def check(self):
        """Existing local snapshot -> unchanged fitter -> real in-memory loader; no Fly calls."""
        if not self.a.snapshot or not self.a.at:raise RuntimeError("--check requires --snapshot and its recorded --at cutoff")
        snapshot=self.a.snapshot.expanduser().resolve();before_hash=sha(snapshot)
        local=self.local_identity("local-identity")
        cutoff=dt.datetime.fromisoformat(self.a.at.replace('Z','+00:00'))
        if cutoff.tzinfo is None:raise RuntimeError("Snapshot cutoff must have an explicit timezone")
        self.call("check-local-fit",[self.a.node,"--import","tsx",str(ROOT/"src/calibrator/standingForecast.fit.ts"),
            "--db",str(snapshot),"--at",self.a.at,"--out",str(self.dir/"fit.json")],timeout=1900)
        same_identity(local,self.local_identity("local-identity-after-fit"))
        if sha(snapshot)!=before_hash:raise RuntimeError("Readonly snapshot changed during check")
        value=json.loads((self.dir/"fit.json").read_text())
        if value["fit"]["fittedAt"]!=int(cutoff.timestamp()*1000):raise RuntimeError("Wrong snapshot cutoff")
        result=self.call("check-real-cache-loader",[self.a.node,"--import","tsx",str(HELPER),"validate","--root",str(ROOT),
            "--input",str(self.dir/"fit.json"),"--sha",sha(self.dir/"fit.json")],json_output=True)
        report={"mode":"local-check-only","productionWrites":0,"networkCalls":0,"snapshot":str(snapshot),"snapshotSha256":before_hash,
            "fitSha256":sha(self.dir/"fit.json"),"identity":local,"cacheLoader":result}
        dump(self.dir/"check.json",report);self.event("check-complete",fittedAt=value["fit"]["fittedAt"])


def main():
    p=argparse.ArgumentParser();mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run",action="store_true");mode.add_argument("--run",action="store_true");mode.add_argument("--check",action="store_true")
    p.add_argument("--snapshot",type=pathlib.Path);p.add_argument("--at")
    p.add_argument("--app",default="yale-shuttle");p.add_argument("--fly",type=pathlib.Path,default=pathlib.Path.home()/".fly/bin/flyctl")
    p.add_argument("--node",default="/usr/bin/node");p.add_argument("--health",default="https://yale-shuttle.fly.dev/healthz")
    p.add_argument("--state",type=pathlib.Path,default=pathlib.Path.home()/".local/state/yale-standing-forecast")
    a=p.parse_args();os.umask(0o077)
    if a.dry_run:
        print(json.dumps({"mode":"dry-run","networkCalls":0,"productionWrites":0,"source":str(ROOT),"state":str(a.state),
          "schedule":"00:30 America/New_York; publication/restart only before04:00 with healthy server and zero known buses","requires":"existing Fly login; deployed autofit disabled; matching local/deployed sources",
          "steps":["exclusive local lock","check local/remote identity","online readonly backup","download+hash","unchanged local worker fit","repeat identity checks","atomic verified cache install with rollback receipt","restart one machine","verify health cached fit","retain seven successful private snapshots"],
          "runnerSha256":sha(__file__),"helperSha256":sha(HELPER)},indent=2));return 0
    def interrupted(signum,_frame):raise RuntimeError("Runner interrupted by signal "+str(signum))
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    a.state=a.state.expanduser().resolve();a.state.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(a.state,0o700)
    lock=open(a.state/"runner.lock","a+")
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:print('{"event":"already-running"}');return 0
    day=dt.datetime.now(ET).date().isoformat()
    if not a.check and (a.state/("success-"+day+".json")).exists():print('{"event":"already-completed-today"}');return 0
    run_dir=a.state/"runs"/(dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+secrets.token_hex(4))
    run_dir.mkdir(parents=True,mode=0o700);runner=Runner(a,run_dir)
    try:
        if a.check:runner.check()
        else:runner.run()
        return 0
    except Exception as error:
        runner.event("failed",error=str(error))
        if runner.install_attempted:runner.rollback()
        return 1
    finally:
        if runner.machine:
            if not runner.install_attempted or runner.rollback_confirmed or (run_dir/"success.json").exists():runner.cleanup_remote()
            else:runner.event("remote-audit-preserved",directory=runner.remote,reason="Cache install or rollback outcome uncertain")
        if not (run_dir/"success.json").exists() and (run_dir/"snapshot.db").exists():(run_dir/"snapshot.db").unlink()


if __name__=="__main__":raise SystemExit(main())
