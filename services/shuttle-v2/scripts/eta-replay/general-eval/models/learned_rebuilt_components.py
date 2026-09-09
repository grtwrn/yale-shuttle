"""Requery all frozen development library fits; do not train or select a winner."""
import argparse, collections, datetime as dt, gzip, hashlib, json, math, pathlib, time
import joblib
import numpy as np
from threadpoolctl import threadpool_limits
from learned_benchmark import encode
from learned_distribution import atom_remaining_quantiles
from learned_features import LEVELS, cell, day_start, duration, known_at, read_episodes
from learned_runtime import FrozenRuntime, profile_key

ROOT=pathlib.Path("scripts/.eta-replay/overnight-2026-09-08")
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def read(p):
    opener=gzip.open if str(p).endswith(".gz") else open
    with opener(p,"rt") as f: return [json.loads(s) for s in f if s.strip()]
def dump(p,x): pathlib.Path(p).write_text(json.dumps(x,indent=2,allow_nan=False)+"\n")

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input",type=pathlib.Path,default=ROOT/"rebuilt-component-development-v1")
    args=p.parse_args(); out=args.input; learned=ROOT/"learned"
    cohort=json.loads((out/"query-manifest.json").read_text())
    if cohort["day"]!="2026-09-04": raise ValueError("Development only; no reserved queries permitted")
    if (out/"library-prediction-manifest.json").exists(): raise ValueError("Refusing to overwrite frozen library predictions")
    for name in ["episode-queries.jsonl","component-labels.jsonl"]:
        if sha(out/name)!=cohort["files"][name]: raise ValueError("Query cohort changed after registration")
    model_names=[f"{family}_{feature}_{capacity}" for family in ["duration","remaining"]
                 for feature in ["basic","history"] for capacity in ["small","medium"]]
    model_names.append("remaining_history_medium_normalized")
    paths={name:learned/f"dev-{name}.joblib" for name in model_names}
    profiles=learned/"dev-profiles.json"; profile=json.loads(profiles.read_text())
    reference=next((file for file in paths.values() if sha(file)==profile["model_sha256"]),None)
    if reference is None: raise ValueError("Original frozen profile's model is missing")
    runtime=FrozenRuntime(reference,profiles)
    if profile["training_days"]!=["2026-09-03"] or profile["fit_cutoff"]!=day_start("2026-09-04"):
        raise ValueError("Wrong original training profile")
    registration={"registeredAt":dt.datetime.now(dt.timezone.utc).isoformat(),"cohortManifestSha256":sha(out/"query-manifest.json"),
        "modelHashes":{name:sha(file) for name,file in paths.items()},"originalProfilesSha256":sha(profiles),
        "decoderSha256":sha(pathlib.Path(__file__).with_name("learned_distribution.py")),"runnerSha256":sha(__file__),
        "trainingChanged":False,"historicalFeaturesChanged":False,"decoder":"Previously declared atom-preserving coherent duration law; direct remaining unchanged",
        "selectionPerformed":False,"scoringPerformed":False,"scope":"All frozen development fits, descriptive corrected-label cohort"}
    dump(out/"library-registration.json",registration)
    queries=read(out/"episode-queries.jsonl"); by_id={q["id"]:q for q in queries}
    # Each current query's observed pin changes, but its previous rows and their
    # duration labels remain the ORIGINAL archived records supplied by TS.
    features={q["id"]:runtime.features(q) for q in queries}
    labels=read(out/"component-labels.jsonl")
    row_index={q["id"]:i for i,q in enumerate(queries)}
    indices=np.asarray([row_index[r["episodeId"]] for r in labels])
    initial=np.asarray([features[q["id"]] for q in queries])
    expanded=initial[indices].copy(); expanded[:,5]=[r["elapsedSec"] for r in labels]
    train=read_episodes(ROOT/"dataset-v2",["2026-09-03"])
    by_cell=collections.defaultdict(list); pooled=[]
    for row in train:
        value=duration(row)
        if known_at(row)<profile["fit_cutoff"] and row["departedAt"] is not None and row["departedAt"]<profile["fit_cutoff"] and row.get("patternResolved") is not False and value is not None and value>0:
            by_cell[cell(row)].append(value); pooled.append(value)
    pooled_median=float(np.median(pooled)) if pooled else 1.
    def scale(q):
        values=by_cell[(q["routePatternId"],q["stopId"],q["stopIndex"])]; n=len(values)
        return max(1.,n/(n+20)*(float(np.median(values)) if values else pooled_median)+20/(n+20)*pooled_median)
    scales=np.asarray([scale(q) for q in queries])
    old=read_episodes(ROOT/"dataset-v2",["2026-09-04"]); old_by_id={r["id"]:r for r in old}
    old_groups=collections.defaultdict(list)
    for r in old: old_groups[(cell(r),r["busKey"])].append(r)
    def old_query(e):
        return {"id":e["id"],"routeId":e["routeId"],"routePatternId":e["routePatternId"],"stopId":e["stopId"],"stopIndex":e["stopIndex"],
            "busKey":e["busKey"],"serviceDay":e["day"],"patternResolved":e.get("patternResolved",True),
            "visitStartMs":e["pinnedAt"],"issuedAt":e["pinnedAt"],"priorDepartures":old_groups[(cell(e),e["busKey"]) ]}
    def predict_raw(model,x):
        encoded=encode(x,model["categories"])
        with threadpool_limits(limits=2):
            return np.sort(np.maximum(0,np.column_stack([m.predict(encoded) for m in model["models"]])),axis=1)
    files={}; controls={}; start=time.monotonic()
    for name,file in paths.items():
        model=joblib.load(file); normalized=model["config"]["features"]=="history_normalized"
        # Reproduce deterministic original first-query controls before making
        # corrected queries. This catches a changed historical feature profile.
        old_predictions=[r for r in read(learned/f"dev-{name}-predictions.jsonl.gz") if r["elapsedSec"]==0]
        control=old_predictions[::max(1,len(old_predictions)//64)][:64]
        cq=[old_query(old_by_id[r["episodeId"]]) for r in control]
        cx=np.asarray([runtime.features(q) for q in cq])
        cs=np.asarray([scale(q) for q in cq])
        if normalized: cx=np.column_stack([cx,cs])
        cx=cx[:,:len(model["features"])]; expected=np.asarray([r["quantilesSec"] for r in control])
        actual=predict_raw(model,cx)
        if normalized: actual*=cs[:,None]
        delta=float(np.max(np.abs(actual-expected))) if len(control) else 0.
        controls[name]={"originalFirstQueries":len(control),"maxAbsoluteDifferenceSec":delta,
            "originalPredictionSha256":sha(learned/f"dev-{name}-predictions.jsonl.gz")}
        dump(out/"library-original-controls.json",controls)
        if delta>1e-6: raise ValueError(f"Original frozen predictions changed for {name}: {delta}")
        if model["config"]["family"]=="duration":
            raw=predict_raw(model,initial[:,:len(model["features"])])
            predictions=np.asarray([atom_remaining_quantiles(raw[i],r["elapsedSec"]) for i,r in zip(indices,labels)])
        else:
            x=np.column_stack([expanded,scales[indices]]) if normalized else expanded[:,:len(model["features"])]
            predictions=predict_raw(model,x)
            if normalized: predictions*=scales[indices,None]
        dest=out/f"library-{name}.jsonl.gz"
        with gzip.open(dest,"wt") as f:
            for label,q in zip(labels,predictions):
                f.write(json.dumps({**label,"model":name,"quantileLevels":LEVELS.tolist(),"quantilesSec":q.tolist()},allow_nan=False,separators=(",",":"))+"\n")
        if sha(file)!=registration["modelHashes"][name]: raise ValueError("Model artifact mutated during prediction")
        files[name]={"path":str(dest),"sha256":sha(dest),"points":len(labels),"episodes":len(queries)}
        print(json.dumps({"emitted":name,"points":len(labels),"originalControlMaxAbs":delta}),flush=True)
    dump(out/"library-prediction-manifest.json",{**registration,"completedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
        "seconds":time.monotonic()-start,"files":files,"controls":controls})
    print(json.dumps({"out":str(out),"manifestWritten":True,"scoringPerformed":False}),flush=True)

if __name__=="__main__": main()
