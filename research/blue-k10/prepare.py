import collections, datetime as dt, gzip, hashlib, json, math
from pathlib import Path
from zoneinfo import ZoneInfo
HERE=Path(__file__).resolve().parent
OUT=HERE/'results'; OUT.mkdir(exist_ok=True)
TZ=ZoneInfo('America/New_York')
CUTOFF=int(dt.datetime(2026,9,16,tzinfo=TZ).timestamp()*1000)
ROUTES={r['id']:r for r in json.loads((HERE/'data/topology.json').read_text())['routes']}
def date(ms):return dt.datetime.fromtimestamp(ms/1000,TZ).strftime('%Y-%m-%d')
def read(p):
    with gzip.open(p,'rt') as f:return [json.loads(l) for l in f if l.strip()]
def write(name,rows):
    with gzip.open(OUT/(name+'.jsonl.gz'),'wt') as f:
        for r in rows:f.write(json.dumps(r,separators=(',',':'))+'\n')
def quantile(v,p):
    v=sorted(v); x=(len(v)-1)*p
    return v[math.floor(x)]*(1-x%1)+v[math.ceil(x)]*(x%1)
def main():
    manifest=json.loads((HERE/'data/manifest.json').read_text())
    for s in manifest['sources']:assert hashlib.sha256((HERE/'data'/s['path']).read_bytes()).hexdigest()==s['sha256']
    tables={}; counts={}
    for table in ('raw_positions','stop_visits','legs','predictions_log'):
        rows=[]
        for file in sorted((HERE/'data').glob('*/'+table+'.jsonl.gz')):rows+=read(file)
        # Retain all route assignments in GPS to detect route changes of a Blue bus.
        if table!='raw_positions':rows=[r for r in rows if r['route_id'] in ROUTES]
        if table=='predictions_log':rows=[r for r in rows if r['surface'] in ('trip','ride','card')]
        tables[table]=rows;counts[table]=dict(collections.Counter(r['route_id'] for r in rows))
        write(table,rows)
    grouped=collections.defaultdict(list); mismatches=collections.Counter()
    for v in tables['stop_visits']:
        seq=ROUTES[v['route_id']]['stops'];i=v['stop_index']
        if not (0<=i<len(seq) and seq[i]==v['stop_id']):mismatches[v['route_id']]+=1;continue
        if v['departed_at'] is None or v['departed_at']>=CUTOFF or v['how']=='gap' or v['outcome'] not in ('passed','stopped') or v['stand_sec'] is None:continue
        grouped[v['route_id'],i].append(v)
    stats=[];waits={rid:[] for rid in ROUTES}
    for (rid,i),vs in grouped.items():
        days=len(set(date(v['arrived_at']) for v in vs)); q75=quantile([v['stand_sec'] for v in vs],.75)
        major=len(vs)>=30 and days>=3 and q75>=180
        stats.append(dict(route=rid,index=i,stop=ROUTES[rid]['stops'][i],n=len(vs),days=days,p75=q75,major=major))
        if major:waits[rid].append(i)
    for v in waits.values():v.sort()
    audit=dict(counts=counts,topologyMismatches=mismatches,waitStats=stats,waits=waits,cutoff=CUTOFF)
    (OUT/'preparation.json').write_text(json.dumps(audit,indent=2))
    print(json.dumps(dict(counts=counts,topologyMismatches=mismatches,waits=waits)))
if __name__=='__main__':main()
