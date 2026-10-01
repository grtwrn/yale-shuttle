import base64,json,pathlib,subprocess
out=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/recordings17.json')
code="""const DB=require('/app/node_modules/better-sqlite3');const d=new DB('/data/shuttle-v2.db',{readonly:true,fileMustExist:true});const lo=Date.parse('2026-09-17T04:00:00Z');const rows=(t,k)=>d.prepare('SELECT * FROM '+t+' WHERE route_id=3 AND '+k+'>=? ORDER BY '+k).all(lo);console.log(JSON.stringify({capturedAt:Date.now(),stop_visits:rows('stop_visits','anchored_at'),legs:rows('legs','departed_at'),arrivals:rows('arrivals','arrived_at'),raw_positions:rows('raw_positions','collected_at')}));d.close();"""
b64=base64.b64encode(code.encode()).decode()
cmd="node -e \"eval(Buffer.from('"+b64+"','base64').toString())\""
p=subprocess.run(['/home/gwarren/.fly/bin/flyctl','ssh','console','-a','yale-shuttle','--machine','91854406a779d8','-C',cmd],text=True,capture_output=True,check=True)
x=json.loads(p.stdout[p.stdout.index('{'):]);out.write_text(json.dumps(x)+'\n');print({k:len(v)if isinstance(v,list)else v for k,v in x.items()})
