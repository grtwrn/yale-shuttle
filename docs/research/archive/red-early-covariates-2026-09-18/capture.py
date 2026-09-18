import base64, json, pathlib, subprocess

root = pathlib.Path(__file__).resolve().parent
out = root / 'recordings-followup.json'
assert not out.exists(), 'Immutable capture already exists'
code = """const DB=require('/app/node_modules/better-sqlite3');const d=new DB('/data/shuttle-v2.db',{readonly:true,fileMustExist:true});const lo=Date.parse('2026-09-17T04:00:00Z');const snapshot=d.transaction(()=>({capturedAt:Date.now(),stop_visits:d.prepare('SELECT * FROM stop_visits WHERE anchored_at>=? ORDER BY anchored_at,id').all(lo),legs:d.prepare('SELECT * FROM legs WHERE route_id=3 AND departed_at>=? ORDER BY departed_at,id').all(lo)}))();console.log(JSON.stringify(snapshot));d.close();"""
b64 = base64.b64encode(code.encode()).decode()
cmd = "node -e \"eval(Buffer.from('" + b64 + "','base64').toString())\""
result = subprocess.run(['/home/gwarren/.fly/bin/flyctl', 'ssh', 'console', '-a', 'yale-shuttle', '--machine', '91854406a779d8', '-C', cmd], text=True, capture_output=True, check=True)
data = json.loads(result.stdout[result.stdout.index('{'):])
out.write_text(json.dumps(data) + '\n')
print({k: len(v) if isinstance(v, list) else v for k, v in data.items()})
