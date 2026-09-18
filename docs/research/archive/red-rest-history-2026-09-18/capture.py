"""Read-only immutable morning follow-up, no operational mutations."""
import base64, json, pathlib, subprocess
out=pathlib.Path(__file__).resolve().parent/'recordings.json'
assert not out.exists()
code="""const DB=require('/app/node_modules/better-sqlite3');const d=new DB('/data/shuttle-v2.db',{readonly:true,fileMustExist:true});const lo=Date.parse('2026-09-17T04:00:00Z');const snap=d.transaction(()=>({capturedAt:Date.now(),stop_visits:d.prepare('SELECT * FROM stop_visits WHERE anchored_at>=? ORDER BY anchored_at,id').all(lo),legs:d.prepare('SELECT * FROM legs WHERE route_id=3 AND departed_at>=? ORDER BY departed_at,id').all(lo),arrivals:d.prepare('SELECT id,bus_name,route_id,stop_id,arrived_at,departed_at FROM arrivals WHERE route_id=3 AND stop_id IN(11,121) AND departed_at IS NOT NULL AND departed_at>=? ORDER BY departed_at,id').all(Date.parse('2026-09-01T04:00:00Z')),raw_positions:d.prepare('SELECT * FROM raw_positions WHERE route_id=3 AND collected_at>=? ORDER BY collected_at,id').all(Date.parse('2026-09-18T04:00:00Z'))}))();console.log(JSON.stringify(snap));d.close();"""
b64=base64.b64encode(code.encode()).decode()
cmd="node -e \"eval(Buffer.from('"+b64+"','base64').toString())\""
p=subprocess.run(['/home/gwarren/.fly/bin/flyctl','ssh','console','-a','yale-shuttle','--machine','91854406a779d8','-C',cmd],capture_output=True,text=True,check=True)
data=json.loads(p.stdout[p.stdout.index('{'):]);out.write_text(json.dumps(data)+'\n')
print({k:len(v) if isinstance(v,list) else v for k,v in data.items()})
