#!/usr/bin/env python3
import json,pathlib,datetime
root=pathlib.Path(__file__).resolve().parent
for name in ('eta','ux'):
 p=root/name/'status.json'
 if not p.exists():print(name+': not started');continue
 s=json.loads(p.read_text()); print(f"{name}: {s.get('phase')} | running={s.get('running')} | round={s.get('round')} | heartbeat={s.get('heartbeat')}")
 print('  Deadline:',s.get('deadline'),'Model PID:',s.get('model_pid'))
 if s.get('pr_url'):print('  PR:',s['pr_url'])
 if s.get('last_error'):print('  Last error:',s['last_error'])
 print('  Completed records:',len(s.get('history',[])))
 if s.get('log'):print('  Current log:',s['log'])
for name in ('PENDING-PUBLICATION.json','PUBLICATION-HALTED.json'):
 if (root/name).exists():print('ATTENTION:',root/name)
