"""Development-only clock audit; never fits or changes a model."""
import bisect, collections, gzip, json, math, pathlib, statistics

ROOT = pathlib.Path("scripts/.eta-replay/overnight-2026-09-08")
def read(file):
    with gzip.open(file, "rt") as f: return [json.loads(s) for s in f]
def distance(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    h = math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b["lon"]-a["lon"])/2)**2
    return 12742000*math.asin(min(1,math.sqrt(h)))
episodes = {r["id"]: r for r in read(ROOT/"dataset-v2/2026-09-04/episodes.jsonl.gz")}
topology = json.loads((ROOT/"dataset-v2/topology.json").read_text())
stops = {s["id"]: s for s in topology["stops"]}
arms = []
for file in ["client-general-baseline-dev.stands.jsonl.gz", "client-analytic-dev.stands.jsonl.gz"]:
    first = {}
    for r in read(ROOT/file):
        if r["routeId"] != 15 or r.get("shown") is None: continue
        if r["episodeId"] not in first: first[r["episodeId"]] = r
    arms.append(first)
positions = collections.defaultdict(list)
for p in read(ROOT/"dataset-v2/2026-09-04/positions.jsonl.gz"):
    if p["route_id"] == 15: positions[p["bus_name"]].append(p)
for ps in positions.values(): ps.sort(key=lambda p:p["collected_at"])
times = {k:[p["collected_at"] for p in v] for k,v in positions.items()}
rows = []
for id in sorted(arms[0].keys() & arms[1].keys()):
    a,b,e = arms[0][id],arms[1][id],episodes[id]
    if a["id"] != b["id"]: continue
    origin = a["issuedAt"]-a["elapsedSec"]*1000
    ps = positions[e["busKey"]]; ts=times[e["busKey"]]
    # Include the last fix known at the browser origin, but never the first
    # post-pin fix: that would count later motion as pre-pin displacement.
    window = ps[max(0,bisect.bisect_right(ts,origin)-1):bisect.bisect_right(ts,e["pinnedAt"])]
    marker = stops[e["stopId"]]
    pinned = (e["departedAt"]-e["pinnedAt"])/1000
    observed = (e["departedAt"]-origin)/1000
    pa,pb = a["shown"]["typicalSec"],b["shown"]["typicalSec"]
    rows.append({"episodeId":id,"busKey":e["busKey"],"stopId":e["stopId"],"pinnedAt":e["pinnedAt"],
        "departedAt":e["departedAt"],"browserOrigin":origin,"issuedAt":a["issuedAt"],
        "firstScoredAfterBrowserStartSec":a["elapsedSec"],"clockLeadSec":(e["pinnedAt"]-origin)/1000,
        "pinnedDurationSec":pinned,"observedDurationSec":observed,"baseline":pa,"candidate":pb,
        "changed":abs(pa-pb)>1e-6,"pinnedMaeDelta":abs(pb-pinned)-abs(pa-pinned),
        "observedMaeDelta":abs(pb-observed)-abs(pa-observed),"windowPolls":len(window),
        "maxDisplacementFromOriginM":max([distance(window[0],p) for p in window],default=0),
        "markerDistanceAtOriginM":distance(window[0],marker) if window else None,
        "markerDistanceAtPinM":distance(window[-1],marker) if window else None,
        "movingStepsAbove15M":sum(distance(x,y)>15 for x,y in zip(window,window[1:])),
        "originFix":window[0] if window else None,"pinnedFix":window[-1] if window else None})
def summarize(rs):
    return {"visits":len(rs),"meanClockLeadSec":statistics.mean(r["clockLeadSec"] for r in rs) if rs else None,
        "meanPinnedMaeDelta":statistics.mean(r["pinnedMaeDelta"] for r in rs) if rs else None,
        "meanObservedMaeDelta":statistics.mean(r["observedMaeDelta"] for r in rs) if rs else None,
        "leadAbove60Sec":sum(r["clockLeadSec"]>60 for r in rs),
        "leadAbove15Sec":sum(r["clockLeadSec"]>15 for r in rs),
        "leadAbove15SecAndDisplacementAbove75M":sum(r["clockLeadSec"]>15 and r["maxDisplacementFromOriginM"]>75 for r in rs),
        "leadAbove15SecAndAllFixesWithin15M":sum(r["clockLeadSec"]>15 and r["maxDisplacementFromOriginM"]<=15 for r in rs)}
out={"scope":"September4 Gold development only; fixed existing model predictions", "all":summarize(rows),
     "changed":summarize([r for r in rows if r["changed"]]),"byStop":{s:summarize([r for r in rows if r["stopId"]==s]) for s in sorted(set(r["stopId"] for r in rows))},"rows":rows}
(ROOT/"analytic/gold-clock-audit.json").write_text(json.dumps(out,indent=2)+"\n")
print(json.dumps({k:v for k,v in out.items() if k!="rows"},indent=2))
