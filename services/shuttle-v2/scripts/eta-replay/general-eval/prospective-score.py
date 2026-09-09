#!/usr/bin/env python3
"""Delayed, local-only report from immutable prospective forecasts and GPS.

Never calls a model, fits parameters, fetches an endpoint, or sends a message.
"""
from __future__ import annotations
import argparse, bisect, collections, datetime as dt, gzip, json, math, pathlib, shutil, subprocess, sys, time
from build_dataset import physical_arrivals, write_jsonl, distance
from compare_rebuilt_stands import associate_displays, has_display
from compare_stands import forecast as stand_forecast, point_only
from score import read, file_hash, validate, score_pairs, first_forecast_ids
from served_targets import ServedTargets

HERE = pathlib.Path(__file__).resolve().parent
SERVICE = HERE.parents[2]
ARMS = ("baseline-production-live", "actual-served-context")
DAY = "2026-09-09"
SOURCES = [HERE / f for f in ["prospective-score.py", "prospective-labels.ts", "rebuild-labels.ts", "build_dataset.py", "inventory.py", "served_targets.py", "compare_rebuilt_stands.py", "compare_stands.py", "score.py"]]
SOURCES += [SERVICE / f for f in ["src/collector/detector.ts", "src/collector/departure.ts", "src/network/TransitNetwork.ts", "src/network/geo.ts", "src/network/alignStops.ts", "src/network/legs.ts", "web/src/anchor.ts", "web/src/geo.ts", "web/src/eta/index.ts", "web/src/eta/ring.ts", "package-lock.json", "node_modules/kdbush/index.js"]]

def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")

def issue_key(row): return f'{row["routeId"]}:{row["busKey"]}:{row["issuedAt"]}'
def target_key(row): return f'{issue_key(row)}:{row["stopId"]}'

def integrity(row, inputs):
    source = inputs.get(issue_key(row))
    if source is None: return "missingUniqueCapturedQueryInput"
    if not source.get("stableGeometry",False): return "unstableOrUnresolvedCapturedGeometry"
    if row.get("routePatternId")!=source.get("routePatternId"): return "capturedPatternMismatch"
    if row.get("fixAt") != source["fixAt"] or row.get("tableSha") != source["tableSha"]: return "capturedInputClockOrTableMismatch"
    if not isinstance(row.get("recordedAt"), (int,float)) or row["recordedAt"] < row["issuedAt"]: return "invalidProspectiveRecordClock"
    if row["arm"] == ARMS[1] and row.get("servedContextSha") != source["servedContextSha"]: return "servedWireHashMismatch"
    if row["arm"] == ARMS[1] and source.get("futureContextClock"): return "futureContextClock"
    if isinstance(row.get("modelFitAt"), (int,float)) and row["modelFitAt"] > row["issuedAt"]: return "futureModelFitClock"
    return None

def pair_forecasts(rows, inputs, targets, served, stops):
    maps = {arm:{} for arm in ARMS}; counts = {arm:collections.Counter() for arm in ARMS}
    lookup = collections.defaultdict(list)
    for target in targets: lookup[target["routeId"],target["busKey"],target["stopId"]].append(target)
    for values in lookup.values(): values.sort(key=lambda r:r["arrivedAt"])
    for row in rows:
        arm=row.get("arm")
        if arm not in maps: continue
        c=counts[arm]; c["inputRows"]+=1
        reason=integrity(row,inputs)
        if reason: c[reason]+=1; continue
        source=inputs[issue_key(row)]; c["wireContextPresent" if source["contextPresent"] else "wireContextAbsent"]+=1
        stop=stops.get(row["stopId"])
        if stop is None: c["missingStableGeometry"]+=1; continue
        if distance(source,stop)<=50: c["alreadyWithin50m"]+=1; continue
        choices=lookup[row["routeId"],row["busKey"],row["stopId"]]
        i=bisect.bisect_right([t["arrivedAt"] for t in choices],row["issuedAt"])
        if i==len(choices): c["noObservedFutureTargetRightCensored"]+=1; continue
        target=choices[i]
        if row["issuedAt"]<target["trackStartAt"]: c["captureGapBeforeTarget"]+=1; continue
        if target["arrivedAt"]-row["issuedAt"]>1_800_000: c["beyond30min"]+=1; continue
        if row["recordedAt"]>=target["arrivedAt"]: c["recordedAfterTarget"]+=1; continue
        if source.get("appendUpperBoundAt") is None or source["appendUpperBoundAt"]>=target["arrivedAt"]:
            c["unprovenAppendBeforeTarget"]+=1; continue
        probe={**row,"targetArrivalId":target["id"]}
        label,reason=served.classify(probe)
        if reason: c[reason]+=1; continue
        key=target_key(row)
        prediction={**row,"id":key,"episodeId":target["id"],"targetArrivalId":target["id"],
                    "target":"physical_arrival","targetAt":target["arrivedAt"],"actualSec":(target["arrivedAt"]-row["issuedAt"])/1000,
                    "forecastRoutePatternId":row["routePatternId"],"routePatternId":label["servedRoutePatternId"],
                    "stopIndex":label["servedStopIndex"],"servedOccurrencesAhead":label["servedOccurrencesAhead"]}
        validate(prediction,displayed_intervals=True)
        if key in maps[arm]: raise ValueError("Multiple forecasts for the same rider query/physical target")
        maps[arm][key]=prediction; c["eligibleRows"]+=1
    common=maps[ARMS[0]].keys() & maps[ARMS[1]].keys()
    pairs=[]
    for key in sorted(common):
        a,b=maps[ARMS[0]][key],maps[ARMS[1]][key]
        for field in ("targetAt","episodeId","routePatternId","quantileLevels"):
            if a[field]!=b[field]: raise ValueError("Paired prospective target differs")
        pairs.append((a,b))
    for arm in ARMS:
        counts[arm]["unmatchedEligibleRows"]=len(maps[arm].keys()-common)
        counts[arm]["eligibleTargetArrivals"]=len({r["episodeId"] for r in maps[arm].values()})
    return pairs,maps,{arm:dict(c) for arm,c in counts.items()}

def summarize_pairs(pairs, bootstrap):
    groups=collections.defaultdict(list)
    for pair in pairs: groups[str(pair[0]["routeId"])].append(pair)
    return {"all":score_pairs(pairs,bootstrap,bus_day=True),"byRoute":{k:score_pairs(v,min(bootstrap,1000)) for k,v in sorted(groups.items())}}

def paired_stands(rows, inputs, labels, bootstrap):
    raw={arm:{} for arm in ARMS}; duplicates=collections.Counter()
    for row in rows:
        if row.get("arm") not in raw: continue
        key=target_key(row)
        if key in raw[row["arm"]]: raise ValueError("Duplicate prospective stand query")
        raw[row["arm"]][key]={**row,"id":key}
    associated={}; coverage={}; initial={}; eligible={}
    for arm in ARMS:
        joined,counts,by_route,_=associate_displays(raw[arm],labels)
        associated[arm]=joined
        # Freeze original first displayed keys BEFORE causal/pairing exclusions.
        initial[arm]=first_forecast_ids(r for r in joined.values() if has_display(r))
        c=collections.Counter(counts); c["inputRows"]=len(raw[arm]); selected={}
        for key,row in joined.items():
            reason=integrity(row,inputs)
            if reason: c[reason]+=1; continue
            if row["recordedAt"]>=labels[row["episodeId"]]["departedAt"]: c["recordedAfterDeparture"]+=1; continue
            source=inputs[issue_key(row)]
            if source.get("appendUpperBoundAt") is None or source["appendUpperBoundAt"]>=labels[row["episodeId"]]["departedAt"]:
                c["unprovenAppendBeforeDeparture"]+=1; continue
            if not has_display(row): c["missingDisplay"]+=1; continue
            selected[key]=row
        eligible[arm]=selected; coverage[arm]={"counts":dict(c),"byRouteAssociation":by_route}
    common=eligible[ARMS[0]].keys() & eligible[ARMS[1]].keys()
    first=initial[ARMS[0]] & initial[ARMS[1]] & common
    for arm in ARMS:
        coverage[arm]["eligibleRows"]=len(eligible[arm]); coverage[arm]["unmatchedEligibleRows"]=len(eligible[arm].keys()-common)
        coverage[arm]["originalFirstDisplays"]=len(initial[arm]); coverage[arm]["firstDisplaysNotPaired"]=len(initial[arm]-first)
    changed=sum(any(eligible[ARMS[0]][key]["shown"][field]!=eligible[ARMS[1]][key]["shown"][field] for field in ("sec","typicalSec")) for key in common)
    result={"coverage":coverage,"pairedMoments":len(common),"pairedOriginalFirstDisplays":len(first),"changedPairedDisplays":changed}
    for mode,keys in (("remaining",common),("pinnedTotal",first),("observedClockTotal",first)):
        pairs=[]
        for key in sorted(keys):
            a,b=eligible[ARMS[0]][key],eligible[ARMS[1]][key]
            if a["episodeId"]!=b["episodeId"]: raise ValueError("Stand physical visit differs")
            e=labels[a["episodeId"]]; pairs.append((stand_forecast(a,e,mode),stand_forecast(b,e,mode)))
        result[mode]=point_only(summarize_pairs(pairs,bootstrap))
    return result,associated

def source_hashes(): return {str(p.relative_to(SERVICE)):file_hash(p) for p in SOURCES}

def pending_doc(path, out, state):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text("# Morning prospective check — September 9, 2026\n\n"+state+"\n\n"
        "Primary arms: recorded baseline versus the recorded actual served context. Local inferred-history shadows are research arms and will not enter this primary comparison. No forecasts will be regenerated, models refitted, or parameters selected from morning outcomes.\n\n"
        "Independent GPS crossing and stop-duration labels will use the frozen geometry, continuity, identity, censoring, and served-occurrence rules. Missing targets and unmatched first displays remain coverage losses.\n\n"
        f"Artifacts and immutable registration: `{out}`.\n")

def main():
    p=argparse.ArgumentParser(); p.add_argument("--input",type=pathlib.Path,required=True); p.add_argument("--out",type=pathlib.Path,required=True)
    p.add_argument("--doc",type=pathlib.Path,required=True); p.add_argument("--run-at",default="2026-09-09T14:05:00Z")
    p.add_argument("--register-only",action="store_true"); p.add_argument("--snapshot-test",action="store_true")
    p.add_argument("--bootstrap",type=int,default=2000); args=p.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    registration_path=args.out/"registration.json"; hashes=source_hashes()
    registration={"registeredAt":dt.datetime.now(dt.timezone.utc).isoformat(),"runAt":args.run_at,"day":DAY,
        "input":str(args.input.resolve()),"writerManifestSha256":file_hash(args.input/"writer-manifest.json"),"sourceHashes":hashes,
        "deploymentEventsPath":str((args.input.parent/"deployment-events.jsonl").resolve()),
        "arms":list(ARMS),"bootstrap":args.bootstrap,"modelRefit":False,"forecastRegeneration":False,
        "policy":{"primary":"Exact recorded served-context versus recorded baseline; inferred-history shadow arms excluded",
          "target":"First future50m GPS crossing, current GPS outside50m, same continuous track, unique corroborated served occurrence1..5, horizon1800sec",
          "labels":"Frozen production reducer,75m pin,30sec gaps, global identity ambiguity/route/discontinuous handoff breaks, initial/end censoring",
          "geometry":"Exact captured geometry; whole route unresolved if it changes during bounded capture",
          "firstDisplay":"Original first display chosen before causal/pairing exclusions, never replace with a later shared row",
          "context":"Keep absent/fallback contexts in primary; report delivery and output differences, not an invented acceptance flag",
          "causality":"Validate exact received input/table/fix/wire context hash and model/context clocks<=issue; append completion bounded by next captured poll or final completed writer status must precede target",
          "interval":"Preserve published conformal bounds, including negative lower bounds; point/coverage metrics only, no3-quantile CRPS claim"}}
    if registration_path.exists():
        frozen=json.loads(registration_path.read_text())
        for k in ("sourceHashes","writerManifestSha256","arms","bootstrap","runAt"):
            if frozen[k]!=registration[k]: raise ValueError(f"Registered {k} changed; refuse automatic scoring")
    else: dump(registration_path,registration)
    if args.register_only:
        pending_doc(args.doc,args.out,"Pending: the automatic read-only report is registered for 10:05 a.m. Eastern after the capture ends. No prospective accuracy result is available yet.")
        print(json.dumps({"registered":str(registration_path),"runAt":args.run_at})); return
    run_at=dt.datetime.fromisoformat(args.run_at.replace("Z","+00:00")).timestamp()
    if not args.snapshot_test:
        while time.time()<run_at:
            dump(args.out/"job-status.json",{"status":"waiting","at":time.time(),"runAt":args.run_at})
            time.sleep(min(30,max(0,run_at-time.time())))
        if source_hashes()!=hashes: raise ValueError("Scoring source changed while waiting")
        if (args.input/"writer.lock").exists(): raise ValueError("Writer still active at scoring deadline; refuse racing its append files")
    snapshot=args.out/"snapshot"
    if snapshot.exists(): raise ValueError("Refusing to overwrite prospective scoring snapshot")
    snapshot.mkdir(); (snapshot/"tables").mkdir()
    for name in ("inputs.jsonl.gz","forecasts.jsonl.gz","stands.jsonl.gz","writer-manifest.json","arm-registry.jsonl","status.json","errors.jsonl"):
        source=args.input/name
        if source.exists():
            before=file_hash(source); shutil.copyfile(source,snapshot/name)
            if not args.snapshot_test and (before!=file_hash(source) or before!=file_hash(snapshot/name)): raise ValueError("Writer source changed during freeze")
        elif name.endswith(".jsonl.gz"):
            with gzip.open(snapshot/name,"wt") as f: pass
    for source in (args.input/"tables").glob("*.gz"): shutil.copyfile(source,snapshot/"tables"/source.name)
    deployment_events=args.input.parent/"deployment-events.jsonl"
    if deployment_events.exists(): shutil.copyfile(deployment_events,snapshot/"deployment-events.jsonl")
    dump(args.out/"snapshot-manifest.json",{"frozenAt":time.time(),"testOnly":args.snapshot_test,
        "files":{str(f.relative_to(snapshot)):file_hash(f) for f in snapshot.rglob("*") if f.is_file()}})
    dataset=args.out/"labels"
    with (args.out/"label-build.log").open("w") as log:
        subprocess.run(["node","--import","tsx",str(HERE/"prospective-labels.ts"),"--input",str(snapshot),"--out",str(dataset),"--day",DAY],cwd=SERVICE,stdout=log,stderr=subprocess.STDOUT,check=True)
    topology=json.loads((dataset/"topology.json").read_text()); routes={r["id"]:r for r in topology["routes"]}; stops={r["id"]:r for r in topology["stops"]}
    targets=[]; crossing_counts=collections.Counter()
    for track in read(dataset/"position-tracks.jsonl.gz"):
        arrivals,counts=physical_arrivals(track["positions"],routes,stops)
        targets.extend(arrivals); crossing_counts.update(counts)
    targets.sort(key=lambda r:(r["arrivedAt"],r["id"]))
    if len({r["id"] for r in targets})!=len(targets): raise ValueError("Duplicate independently rebuilt physical target")
    write_jsonl(dataset/DAY/"physical-arrivals.jsonl.gz",targets)
    input_rows=read(dataset/"query-inputs.jsonl.gz")
    inputs={r["key"]:r for r in input_rows}
    if len(inputs)!=len(input_rows): raise ValueError("Duplicate query-input keys; refuse silent identity overwrite")
    labels={r["id"]:r for r in read(dataset/DAY/"episodes.jsonl.gz")}
    # Labels are now complete/frozen; only now are the stored forecasts read.
    served=ServedTargets(dataset,DAY)
    forecast_rows=read(snapshot/"forecasts.jsonl.gz")
    pairs,maps,coverage=pair_forecasts(forecast_rows,inputs,targets,served,stops)
    for arm in ARMS:
        common={a["id"] for a,b in pairs}
        write_jsonl(args.out/f"{arm}.matched.jsonl.gz",[maps[arm][k] for k in sorted(common)])
        write_jsonl(args.out/f"{arm}.unmatched.jsonl.gz",[v for k,v in maps[arm].items() if k not in common])
    standing,associated=paired_stands(read(snapshot/"stands.jsonl.gz"),inputs,labels,args.bootstrap)
    for arm in ARMS: write_jsonl(args.out/f"{arm}.associated-stands.jsonl.gz",list(associated[arm].values()))
    eta=summarize_pairs(pairs,args.bootstrap)
    guards={}
    for name,scores in (("eta",eta),("remainingStand",standing["remaining"]),("firstTotal",standing["pinnedTotal"])):
        guards[name]=[{"routeId":k,"visits":v["episodes"],"baselineMae":v["baseline"]["mae"],"candidateMae":v["candidate"]["mae"]}
                     for k,v in scores["byRoute"].items() if v["episodes"]>=30 and v["delta"]["mae"]>10 and v["candidate"]["mae"]>1.1*v["baseline"]["mae"]]
    result={"status":"complete" if pairs or standing["pairedMoments"] else "insufficient_observed_outcomes",
            "createdAt":dt.datetime.now(dt.timezone.utc).isoformat(),"testOnly":args.snapshot_test,
            "registrationSha256":file_hash(registration_path),"snapshotManifestSha256":file_hash(args.out/"snapshot-manifest.json"),
            "sourceHashes":hashes,"labelManifest":json.loads((dataset/"manifest.json").read_text()),"physicalCrossings":len(targets),
            "crossingDiagnostics":dict(crossing_counts),"servedTargetPolicy":served.policy(),"forecastCoverage":coverage,
            "eta":eta,"standing":standing,"materialRouteRegressions":guards,
            "wireContextDelivery":{"queryInputs":len(inputs),"withContext":sum(r["contextPresent"] for r in inputs.values()),
                                   "futureContextClocks":sum(r["futureContextClock"] for r in inputs.values()),
                                   "acceptance":"Wire delivery is observed; the writer did not record per-context acceptance. Absent or rejected contexts remain in the primary query population."},
            "captureHealth":{"writerStatus":json.loads((snapshot/"status.json").read_text()),
                             "errors":read(snapshot/"errors.jsonl") if (snapshot/"errors.jsonl").exists() else []},
            "operationalProvenanceEvents":read(snapshot/"deployment-events.jsonl") if (snapshot/"deployment-events.jsonl").exists() else [],
            "ignoredResearchArms":dict(collections.Counter(r.get("arm") for r in forecast_rows if r.get("arm") not in ARMS)),
            "limitations":["Morning-only local client computation from actual served wire, not a recorded rider phone session.",
                           "Captured payload establishes table availability; legacy table training-cutoff metadata is not exposed.",
                           "recordedAt is assigned before batch append; primary rows additionally require the next-poll/final-status append upper bound before the target label clock.",
                           "Capture-end/missing arrivals are censored; no success or zero error is imputed.",
                           "Model parameters and old training-label quality are unchanged; no promotion or tuning is automated."]}
    result["changedPairedEtaForecasts"] = sum(a["quantilesSec"]!=b["quantilesSec"] for a,b in pairs)
    result["evidenceState"] = "observed_context_effect" if result["changedPairedEtaForecasts"] or standing["changedPairedDisplays"] else "no_observed_context_effect"
    dump(args.out/"report.json",result); dump(args.out/"job-status.json",{"status":result["status"],"finishedAt":time.time()})
    lines=["# Morning prospective check — September 9, 2026","",f"Status: **{result['status']}**; **{result['evidenceState']}**."+ (" This is a dry-run plumbing test, not prospective validation." if args.snapshot_test else ""),"",
           "The report compares predictions actually recorded from the served-context wire with their simultaneously recorded baseline. Independent GPS observations supply the outcome labels. No model was rerun or fitted, and the local inferred-history shadow arms are excluded.","",
           "| Recorded measure | Independent targets / visits | Baseline MAE, s | Served-context MAE, s |","|---|---:|---:|---:|"]
    for name,score in (("Future ETA",eta["all"]),("Remaining stand",standing["remaining"]["all"]),("First total stand",standing["pinnedTotal"]["all"])):
        if score["episodes"]: lines.append(f"|{name}|{score['episodes']}|{score['baseline']['mae']:.2f}|{score['candidate']['mae']:.2f}|")
        else: lines.append(f"|{name}|0|Unavailable|Unavailable|")
    lines += ["",f"Observed wire contexts: {result['wireContextDelivery']['withContext']} of {len(inputs)} unique fresh query inputs. Delivery does not by itself prove a context was accepted; absent/fallback contexts remain in the primary denominator.","",
              f"Capture recorded {len(result['captureHealth']['errors'])} request failures. Their timestamps remain in the JSON; missing observations do not become successful or zero-error targets.","",
              "Coverage, unmatched forecasts and original first displays, capture censoring, both directions of >120-second error, interval coverage, route guards, and clustered uncertainty are in the JSON report. Published conformal bounds are preserved; no CRPS is claimed from only three displayed bounds.","",
              f"[Full JSON report]({(args.out/'report.json').resolve()})", "", *[f"- {x}" for x in result["limitations"]],""]
    args.doc.write_text("\n".join(lines)); print(json.dumps({"report":str(args.out/"report.json"),"status":result["status"],"pairedEta":len(pairs),"pairedStands":standing["pairedMoments"]}))

if __name__=="__main__":
    try: main()
    except Exception as error:
        # A durable failure record is preferable to inventing a validation result.
        arguments=sys.argv
        if "--out" in arguments:
            target=pathlib.Path(arguments[arguments.index("--out")+1]); target.mkdir(parents=True,exist_ok=True)
            dump(target/"job-status.json",{"status":"failed","at":time.time(),"reason":str(error)})
        if "--doc" in arguments:
            document=pathlib.Path(arguments[arguments.index("--doc")+1]); document.parent.mkdir(parents=True,exist_ok=True)
            document.write_text("# Morning prospective check — September 9, 2026\n\nAutomatic scoring stopped: "+str(error)+".\n\nNo prospective validation result is claimed. The capture and failure artifacts remain available for review; no model or production state was changed.\n")
        raise
