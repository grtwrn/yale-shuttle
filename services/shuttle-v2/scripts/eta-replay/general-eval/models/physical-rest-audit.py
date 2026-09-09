"""Model-blind, development-only physical stop-zone audit.

Rules come from the existing collector's geometric/rest definitions, not model
errors: 75m entry, 150m confirmed exit, >=14s exact-coordinate rest, <=30s feed
gap. Geometric events are constructed before any stored visit is consulted.
"""
import bisect, collections, gzip, hashlib, json, math, pathlib, statistics

ROOT = pathlib.Path("scripts/.eta-replay/overnight-2026-09-08")
DAY = "2026-09-04"
def read(path):
    with gzip.open(path,"rt") as f: return [json.loads(s) for s in f]
def distance(a,b):
    lat1,lat2=math.radians(a["lat"]),math.radians(b["lat"])
    h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b["lon"]-a["lon"])/2)**2
    return 12742000*math.asin(min(1,math.sqrt(h)))
topology=json.loads((ROOT/"dataset-v2/topology.json").read_text())
routes={r["id"]:list(dict.fromkeys(r["stops"])) for r in topology["routes"]}
stops={s["id"]:s for s in topology["stops"]}
positions=read(ROOT/f"dataset-v2/{DAY}/positions.jsonl.gz")
name_time=collections.Counter((p["bus_name"],p["collected_at"]) for p in positions)
groups=collections.defaultdict(list)
for p in positions: groups[p["route_id"],p["bus_name"]].append(p)
events=[]; coverage=collections.Counter()
for (rid,bus),ps in groups.items():
    if rid not in routes: continue
    ps.sort(key=lambda p:p["collected_at"])
    segments=[]; segment=[]
    for p in ps:
        if name_time[p["bus_name"],p["collected_at"]]>1:
            if segment: segments.append(segment); segment=[]
            coverage["ambiguousIdentityPositions"]+=1; continue
        if segment and p["collected_at"]-segment[-1]["collected_at"]>30000:
            segments.append(segment); segment=[]; coverage["trackGaps"]+=1
        segment.append(p)
    if segment: segments.append(segment)
    for segment in segments:
        runs=[]
        for p in segment:
            if runs and p["lat"]==runs[-1]["lat"] and p["lon"]==runs[-1]["lon"]:
                runs[-1]["end"]=p["collected_at"]; runs[-1]["polls"]+=1
            else: runs.append({"lat":p["lat"],"lon":p["lon"],"start":p["collected_at"],"end":p["collected_at"],"polls":1})
        for run in runs:
            run["near"]=[sid for sid in routes[rid] if sid in stops and distance(run,stops[sid])<=75]
        for sid in routes[rid]:
            if sid not in stops: continue
            current=None
            for i,run in enumerate(runs):
                d=distance(run,stops[sid])
                if current is None and d<=75:
                    current={"routeId":rid,"busKey":bus,"stopId":sid,"entryAt":run["start"],
                        "leftCensored":i==0,"firstRestAt":None,"finalRestAt":None,"restPlateaus":0,
                        "ambiguousStop":False,"frozenSec":0,"trackStartAt":segment[0]["collected_at"]}
                if current is None: continue
                if d>=150:
                    if current["firstRestAt"] is not None:
                        current["exitedAt"]=run["start"]; current["departureAt"]=current.pop("finalRestAt")
                        events.append(current)
                    current=None; continue
                if d<=75 and run["end"]-run["start"]>=14000:
                    if current["firstRestAt"] is None: current["firstRestAt"]=run["start"]
                    current["finalRestAt"]=run["end"]; current["restPlateaus"]+=1
                    current["frozenSec"]+=(run["end"]-run["start"])/1000
                    current["ambiguousStop"] |= len(run["near"])>1
            if current and current["firstRestAt"] is not None: coverage["rightCensoredPhysicalRests"]+=1

# Matching is strictly subsequent to model-free physical event construction.
visits=read(ROOT/f"dataset-v2/{DAY}/episodes.jsonl.gz")
labels=collections.defaultdict(list)
for v in visits:
    if v["departedAt"] is not None: labels[v["routeId"],v["busKey"],v["stopId"]].append(v)
for vs in labels.values(): vs.sort(key=lambda v:v["departedAt"])
rows=[]
for e in events:
    coverage["physicalEvents"]+=1
    if e["leftCensored"]: coverage["leftCensoredPhysicalEvents"]+=1; continue
    if e["ambiguousStop"]: coverage["ambiguousNearbyStopEvents"]+=1; continue
    vs=labels[e["routeId"],e["busKey"],e["stopId"]]
    matches=[v for v in vs if abs(v["departedAt"]-e["departureAt"])<=30000]
    if len(matches)!=1: coverage["missingOrAmbiguousDepartureMatch"]+=1; continue
    v=matches[0]
    if v["pinnedAt"] is None: coverage["matchingVisitUnpinned"]+=1; continue
    rows.append({**e,"episodeId":v["id"],"labelPinnedAt":v["pinnedAt"],"labelDepartedAt":v["departedAt"],
        "labelOutcome":v["outcome"],"entryDelaySec":(v["pinnedAt"]-e["entryAt"])/1000,
        "restStartDelaySec":(v["pinnedAt"]-e["firstRestAt"])/1000,
        "departureDifferenceSec":(v["departedAt"]-e["departureAt"])/1000,
        "physicalRestSpanSec":(e["departureAt"]-e["firstRestAt"])/1000,
        "labelDurationSec":(v["departedAt"]-v["pinnedAt"])/1000})
def summary(rs):
    return {"matchedEvents":len(rs),"medianEntryDelaySec":statistics.median(r["entryDelaySec"] for r in rs) if rs else None,
        "meanEntryDelaySec":statistics.mean(r["entryDelaySec"] for r in rs) if rs else None,
        "pinAfterConfirmedRestAbove30Sec":sum(r["restStartDelaySec"]>30 for r in rs),
        "pinAfterConfirmedRestAbove120Sec":sum(r["restStartDelaySec"]>120 for r in rs),
        "totalOmittedRestSecAbove30":sum(max(0,r["restStartDelaySec"]) for r in rs if r["restStartDelaySec"]>30),
        "labelPassDespitePhysicalRest":sum(r["labelOutcome"]=="passed" for r in rs)}
out={"day":DAY,"rules":{"entryRadiusM":75,"exitRadiusM":150,"restMinMs":14000,"maxGapMs":30000,"departureMatchToleranceMs":30000,
    "identity":"global same-name duplicate timestamps break tracks","nearbyStops":"exclude any rest plateau simultaneously within75m of multiple physical stops",
    "occurrences":"physical stop identity only; no repeated occurrence inferred from GPS proximity","selection":"no model predictions consulted"},
    "coverage":dict(coverage),"all":summary(rows),"strongRestAtLeast60Sec":summary([r for r in rows if r["frozenSec"]>=60]),
    "byRoute":{rid:summary([r for r in rows if r["routeId"]==rid]) for rid in sorted(routes)},"rows":rows,
    "scriptSha256":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
(ROOT/"analytic/physical-rest-development-audit.json").write_text(json.dumps(out,indent=2)+"\n")
print(json.dumps({k:v for k,v in out.items() if k!="rows"},indent=2))
