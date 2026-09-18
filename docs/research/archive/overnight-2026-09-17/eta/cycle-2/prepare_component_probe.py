"""Generate an artifact-only observer copy. Never edits imported application files."""
import hashlib
import json
import re
from pathlib import Path

OUT=Path(__file__).resolve().parent
APP=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2')
source=APP/'web/src/eta/arrival.ts'
text=source.read_text()
# Preserve implementation verbatim except absolute import paths and an observer.
text=re.sub(r"(from\s+)([\"'])(\.[^\"']+)\2",lambda m:m[1]+m[2]+str((source.parent/m[3]).resolve())+'.ts'+m[2],text)
marker='  const out: StopArrival[] = [];'
assert text.count(marker)==1
observer='''
  componentObserver = [];
  const win = stops.indexOf(11), division = stops.indexOf(48), rose = stops.indexOf(4);
  for (const c of chains.filter(c => c.sit.leg === lead.sit.leg)) {
    if (!c.sampled) throw Error('Expected current Red sampled future path');
    const hw = (win - c.leg + N) % N || N;
    const hd = (division - c.leg + N) % N || N;
    const hr = (rose - c.leg + N) % N || N;
    if (!(hw < hd && hd < hr)) throw Error('Probe requires Union before Winchester/Division/Rosenkranz');
    const drive = termDraws(tables.hops[win]!.drive, 2 * win + 1);
    const preWin = Array.from(c.sampled[hw]!);
    const wait = preWin.map((x,k) => c.sampled![hw+1]![k]! - x - drive[k]!);
    const postDivision = preWin.map((x,k) => c.sampled![hd]![k]! - x - wait[k]!);
    const postRose = preWin.map((x,k) => c.sampled![hr]![k]! - x - wait[k]!);
    componentObserver.push({ mass:c.sit.mass, standing:c.sit.standing, leg:c.leg, isLead:c===lead,
      rawSecondDivisionMedian:Float64Array.from(c.sampled[hd+N]!).sort()[K>>1],
      rawSecondRoseMedian:Float64Array.from(c.sampled[hr+N]!).sort()[K>>1],
      preWin, wait, postDivision, postRose,
      totalDivision:Array.from(c.sampled[hd]!), totalRose:Array.from(c.sampled[hr]!) });
  }
'''
text=text.replace(marker,observer+marker)
text+='\nexport let componentObserver: any[] = [];\n'
(OUT/'arrival-observer.generated.mts').write_text(text)

# Replay only to obtain exact existing belief snapshots. New output files;
# first trace/metadata remain frozen and independently reusable.
replay=(OUT/'trace_current.mts').read_text()
replay=replay.replace("import fs from 'node:fs';", "import fs from 'node:fs';\nimport { serialize } from 'node:v8';\nconst captured: any[] = []; const capturedIds = new Set();")
old="const windows = cases.map((c: any) => ({ sourceId: c.sourceId, bus: c.visit.bus_name, start: c.visit.pinned_at - 600000, end: Math.max(...c.journeys.map((j: any) => j.targetArrivedAt)) }));"
new="const windows = cases.filter((c:any)=>c.sourceStop===121).map((c: any) => ({ sourceId: c.sourceId, bus: c.visit.bus_name, start: c.visit.departed_at + 60000, end: c.visit.departed_at + 75000 }));"
assert old in replay
replay=replay.replace(old,new).replace("if (!contexts.length) continue;", "if (!contexts.length || capturedIds.has(contexts[0])) continue;\n      capturedIds.add(contexts[0]);")
marker="      const state = b ?"
assert marker in replay
replay=replay.replace(marker,"      captured.push({ sourceId:contexts[0], at, bus, entry:structuredClone(entry), payload, forecasts:arrivals.filter((a:any)=>a.busName===bus.bus_name.replace('#','')) });\n"+marker)
replay=replay.replace("'/current-trace.jsonl'","'/component-snapshot-trace.jsonl'").replace("'/current-trace-meta.json'","'/component-snapshot-meta.json'")
replay+="\nif(captured.length!==5) throw Error('Missing snapshot');\nfs.writeFileSync(out+'/component-snapshots.v8',serialize(captured));\n"
(OUT/'capture_components.generated.mts').write_text(replay)
(OUT/'COMPONENT_PROBE_PLAN.json').write_text(json.dumps(dict(
    purpose='Observer-only additive sample means for current-code Union departure+60 at five fixed selected cases; no candidate or intervention.',
    accounting='Per-sample time before Winchester, future Winchester wait, and subsequent travel/intermediate stops to each endpoint. Weighted mixture means add; displayed quantile differences do not.',
    validation='Compare every observer priceRoute output to untouched current priceRoute on identical warm states, plus current displayed outputs; check per-sample additive identity.',
    source=str(source),sourceSHA256=hashlib.sha256(source.read_bytes()).hexdigest(),
    generatedObserverSHA256=hashlib.sha256(text.encode()).hexdigest()),indent=2)+'\n')
print('Generated two artifact-only probes; application source untouched.')
