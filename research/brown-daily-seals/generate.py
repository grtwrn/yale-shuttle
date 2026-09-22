"""Checked I/O/schedule substitutions; original reducers and fitting code untouched."""
import json
from pathlib import Path
from contract import *

REPLAY_SHA='da6a9f9acb6f150cb67e6735f3565d744cc4509448137fc48d838b84e58ef934'
BUILD_SHA='6ad396cb99ef26c8d00450d7a43b651d381bd91faf27a907c1cc78f352720638'

def replace(text,old,new,count=1):
    require(text.count(old)==count,'unrecognized original source selector: '+old[:60])
    return text.replace(old,new)

def cutoffs(config):
    return sorted({1789531200000,1789963200000,1790006400000,config['trainBefore']-86400000,config['trainBefore']-43200000})

def replay_source(config):
    path=ROOT/'research/brown-rolling-seal/replay.ts';require(file_sha(path)==REPLAY_SHA,'changed original replay')
    source=path.read_text()
    source=replace(source,"Date.parse('2026-09-22T04:00:00Z')",str(config['trainBefore']))
    old="[Date.parse('2026-09-16T04:00:00Z'),\n Date.parse('2026-09-21T04:00:00Z'),Date.parse('2026-09-21T16:00:00Z')]"
    source=replace(source,old,json.dumps(cutoffs(config)))
    return source

def build_source(config,source_files):
    path=ROOT/'research/brown-rolling-seal/build.py';require(file_sha(path)==BUILD_SHA,'changed original builder')
    source=path.read_text()
    source=replace(source,'CUTOFF = 1790049600000',f"CUTOFF = {config['trainBefore']}\nVALID_FROM = {config['validFrom']}")
    source=replace(source,'END = VALID_FROM + 86400000',f"END = {config['validUntil']}")
    source=replace(source,"assert len(gate['prefixChecks']) == 6",f"assert len(gate['prefixChecks']) == {2*len(cutoffs(config))}")
    source=replace(source,'range(VALID_FROM, VALID_FROM+7*86400000+1, 3600000)','range(1790136000000, 1790136000000+7*86400000+1, 3600000)')
    source=replace(source,"(HERE/'data/raw-provenance.json','raw-provenance.json')","(HERE/'input/daily-raw-provenance.json','raw-provenance.json')")
    source=replace(source,'    for name in SOURCE_FILES:',f'    for name in {repr(tuple(source_files))}:')
    source=replace(source,"assert gate['baselineCanonicalIdentity'] and gate['nonBrownEventIdentity']",
        "assert gate['baselineCanonicalIdentity'] and gate['nonBrownEventIdentity']\n    assert all(r['known_at'] < CUTOFF for r in read(REPLAY/'baseline-visits.jsonl.gz'))")
    source=replace(source,'prospectiveObservationsRead=0,performanceLabelsRead=0',
        f"trainingRawDays={repr(config['rawDays'])},prospectivePerformanceLabelsRead=0,performanceLabelsRead=0")
    source=replace(source,"scope='Sep23 rolling Brown K5 pools only; no candidate launch or outcome claim'",
        f"scope='{config['day']} rolling Brown K5 pools only; no candidate launch or outcome claim'")
    # Verify the actual serialized source/pools against all queries BEFORE final
    # manifest/builtAt creation. Post-seal load checks manifest identity only.
    marker="    manifest=dict(schema=1,kind='sealed',training='rolling',K=5,trainBefore=CUTOFF,"
    verification="    serialized,_ = from_pools((OUT/'source/research/k-sweep/evaluate.py').read_text(), json.loads((OUT/'paths.json').read_bytes()),cutoff=CUTOFF,K=5)\n    for q in queries:\n        assert serialized.fit(*q)==original.fit(*q)\n"
    source=replace(source,marker,verification+marker)
    source=replace(source,'    for q in queries:\n        assert final.fit(*q)==original.fit(*q)\n','')
    return source

def write_sources(config,source_files):
    folder=ROOT/'research/brown-rolling-seal'
    replay=folder/'__daily-replay.generated.ts';builder=folder/'__daily-build.generated.py'
    require(not replay.exists() and not builder.exists(),'generated source already exists')
    replay.write_text(replay_source(config))
    builder.write_text(build_source(config,[*source_files,str(replay.relative_to(ROOT)),str(builder.relative_to(ROOT))]))
    return replay,builder
