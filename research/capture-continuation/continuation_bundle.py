"""Hosted-only creation of a reviewable immutable bundle; installs nothing."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import shlex
import shutil
from continuation_common import validate_plan,encoded,digest,require

HERE=Path(__file__).resolve().parent
TOOLS=('continuation_common.py','continuation_control.py','continuation_stitch.py','reference/capture_decoder.py','reference/recorder.py','reference/PROVENANCE.json')
def build(source_commit,output):
    require(re.fullmatch('[0-9a-f]{40}',source_commit),'full source commit required')
    plan=validate_plan(json.loads((HERE/'plan.json').read_text()));output=Path(output);require(not output.exists(),'review output already exists')
    output.mkdir(parents=True);bundle=output/'bundle';bundle.mkdir();hashes={}
    for name in TOOLS:
        target=bundle/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(HERE/name,target);hashes[name]=digest(target.read_bytes())
    provenance=json.loads((bundle/'reference/PROVENANCE.json').read_text())
    for name,info in provenance.items():
        if isinstance(info,dict):require(hashes['reference/'+name]==info['sha256'],'pinned dependency changed')
    runtime=Path(plan['evidenceRoot'])/'capture-tools'/('continuation-'+source_commit)
    manifest=dict(schema=1,sourceCommit=source_commit,builtAt=dt.datetime.now(dt.timezone.utc).isoformat(),plan=plan,toolHashes=hashes,
                  bundleRoot=str(runtime),auditRoot=str(Path(plan['evidenceRoot'])/('capture-continuation-audit-'+source_commit)),
                  bodyAccess='Controller metadata only; actual stitched body decoding remains separately gated')
    raw=encoded(manifest);(bundle/'deployment-manifest.json').write_bytes(raw);manifest_sha=digest(raw)
    units=output/'units';units.mkdir();made=[]
    def save(name,body):
        (units/name).write_text(body);made.append(name)
    control=runtime/'continuation_control.py';manifest_path=runtime/'deployment-manifest.json'
    for part in plan['parts'][1:]:
        day=part['primaryFrom'][:10].replace('-','');stem=part['unit'][:-8];handoff=f'shuttle-public-fleet-handoff-{day}'
        def command(action):return ' '.join(shlex.quote(x) for x in ['/usr/bin/python3',str(control),action,'--part',part['id'],'--manifest',str(manifest_path),'--sha256',manifest_sha])
        save(part['unit'],f'''[Unit]
Description=Frozen public shuttle capture part {part['id']}
[Service]
Type=simple
ExecStart={command('launch')}
Restart=no
Nice=15
CPUWeight=10
CPUQuota=25%
RuntimeMaxSec=8d
TimeoutStopSec=20s
''')
        def calendar(value):return value.replace('T',' ').replace('Z',' UTC')
        save(stem+'.timer',f'''[Unit]
Description=One fixed start for public capture part {part['id']}
[Timer]
OnCalendar={calendar(part['launchAt'])}
AccuracySec=1s
RandomizedDelaySec=0
Persistent=true
Unit={part['unit']}
[Install]
WantedBy=timers.target
''')
        save(handoff+'.service',f'''[Unit]
Description=Metadata-only fixed capture handoff to part {part['id']}
[Service]
Type=oneshot
ExecStart={command('handoff')}
Restart=no
Nice=15
CPUWeight=10
CPUQuota=25%
TimeoutStartSec=180s
TimeoutStopSec=20s
''')
        save(handoff+'.timer',f'''[Unit]
Description=One fixed metadata handoff to capture part {part['id']}
[Timer]
OnCalendar={calendar(part['primaryFrom'])}
AccuracySec=1s
RandomizedDelaySec=0
Persistent=true
Unit={handoff}.service
[Install]
WantedBy=timers.target
''')
    timers=[name for name in made if name.endswith('.timer')]
    commands=f'''#!/usr/bin/env bash
set -euo pipefail
# REVIEW ONLY until root approves this exact bundle. Run from its extracted root.
# Source/bundle bytes are pinned by review-seal.json and GitHub artifact digest.
test ! -e {shlex.quote(str(runtime))}
/usr/bin/python3 - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('.')
seal=json.loads((root/'review-seal.json').read_text())
for relative,sha in seal['files'].items():
    path=root/relative
    assert path.is_file() and not path.is_symlink()
    assert hashlib.sha256(path.read_bytes()).hexdigest()==sha,relative
PY
'''
    for name in made:commands+=f'test ! -e "$HOME/.config/systemd/user/{name}"\n'
    commands+=f'mkdir -p {shlex.quote(str(runtime.parent))}\ncp -a bundle {shlex.quote(str(runtime))}\nmkdir -p "$HOME/.config/systemd/user"\n'
    for name in made:commands+=f'install -m 0644 {shlex.quote("units/"+name)} "$HOME/.config/systemd/user/{name}"\n'
    commands+='systemctl --user daemon-reload\n'
    commands+='systemctl --user enable --now '+' '.join(map(shlex.quote,timers))+'\n'
    commands+='systemctl --user list-timers --all '+' '.join(map(shlex.quote,timers))+'\n'
    commands+='# No service is started now; only the fixed future timers are enabled.\n'
    (output/'INSTALL-REVIEW-ONLY.sh').write_text(commands)
    files={str(p.relative_to(output)):digest(p.read_bytes()) for p in output.rglob('*') if p.is_file()}
    seal=dict(schema=1,sourceCommit=source_commit,deploymentManifestSha256=manifest_sha,files=files,
              approval='Root approved scope; exact installation awaits final review; build installed nothing',maximumParts=3,maximumAggregateBytes=9*1024**3)
    (output/'review-seal.json').write_bytes(encoded(seal));return seal

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source-commit',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    print(json.dumps(build(a.source_commit,a.output),indent=2))
