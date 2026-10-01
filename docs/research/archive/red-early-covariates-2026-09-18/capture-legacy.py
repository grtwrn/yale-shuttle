"""Saved exact read-only extraction used for legacy-followup.json.

The capture was originally executed inline; this file records that command's
query/provenance without recapturing or replacing the immutable result.
"""
import base64, json, pathlib, subprocess
out=pathlib.Path(__file__).resolve().parent/'legacy-followup.json'
assert not out.exists()
code="const DB=require('/app/node_modules/better-sqlite3');const d=new DB('/data/shuttle-v2.db',{readonly:true,fileMustExist:true});console.log(JSON.stringify({capturedAt:Date.now(),arrivals:d.prepare('SELECT id,bus_name,stop_id,arrived_at,departed_at FROM arrivals WHERE route_id=3 AND stop_id IN(11,121) AND departed_at IS NOT NULL AND departed_at>=? ORDER BY departed_at').all(Date.parse('2026-09-01T04:00:00Z'))}));d.close();"
b64=base64.b64encode(code.encode()).decode();cmd="node -e \"eval(Buffer.from('"+b64+"','base64').toString())\""
p=subprocess.run(['/home/gwarren/.fly/bin/flyctl','ssh','console','-a','yale-shuttle','--machine','91854406a779d8','-C',cmd],capture_output=True,text=True,check=True)
x=json.loads(p.stdout[p.stdout.index('{'):]);out.write_text(json.dumps(x));print('Legacy departures',len(x['arrivals']))
