"""Audit saved Red arrival labels against the immutable captured GPS/feed.
Does not call ETA code or use predicted arrival times as truth.
"""
import sys,json,math,collections,bisect,hashlib,sqlite3
capture,waits,db,out=sys.argv[1:5]
tracks=collections.defaultdict(list);seen={};audit=collections.Counter();digest=hashlib.sha256()
for line in open(capture,'rb'):
 digest.update(line);r=json.loads(line);audit['capture_rows']+=1
 if r['route_id']!=3:continue
 if not all(isinstance(r.get(k),(int,float)) and math.isfinite(r[k]) for k in ('lat','lon','collected_at')) or not(-90<=r['lat']<=90 and -180<=r['lon']<=180):audit['invalid_rows']+=1;continue
 key=(r['bus_id'],r['collected_at'])
 if key in seen:
  if seen[key]!=r:raise ValueError('Conflicting duplicate GPS observation')
  audit['duplicate_rows']+=1;continue
 seen[key]=r;tracks[r['bus_name'].lstrip('#')].append(r)
conn=sqlite3.connect('file:'+db+'?mode=ro',uri=True)
coords={sid:(lat,lon) for sid,lat,lon in conn.execute('select id,lat,lon from stops')};conn.close()
for rows in tracks.values():rows.sort(key=lambda r:r['collected_at'])
def distance(r,c):
 lat,lon=map(math.radians,c);a,b=map(math.radians,(r['lat'],r['lon']));h=math.sin((a-lat)/2)**2+math.cos(a)*math.cos(lat)*math.sin((b-lon)/2)**2;return 6371000*2*math.asin(min(1,math.sqrt(h)))
flips={};times={}
for bus,rows in tracks.items():
 times[bus]=[r['collected_at'] for r in rows];prev=None;events=[]
 for r in rows:
  stop=r.get('last_stop_id')
  if stop is not None:
   if prev is not None and prev!=stop:events.append((r['collected_at'],stop))
   prev=stop
 flips[bus]=events
records=[json.loads(l) for l in open(waits) if l.strip()];labels={};waitcounts=collections.Counter();valid=[]
for w in records:
 if w['outcome']!='arrived' or w['arrivedAt'] is None:continue
 bus=(w.get('arrivedBus') or '').lstrip('#');t=w['arrivedAt'];stop=w['boardStopId'];key=(bus,stop,t)
 if key not in labels:
  ts=times.get(bus,[]);i=bisect.bisect_left(ts,t);rows=tracks.get(bus,[])
  exact=i<len(ts) and ts[i]==t
  d=distance(rows[i],coords[stop]) if exact and stop in coords else None
  gap=(ts[i]-ts[i-1])/1000 if exact and i>0 else None
  served=any(s==stop and t-120000<=ft<=t+300000 for ft,s in flips.get(bus,[]))
  category='curb_and_served' if exact and d<=45 and served else 'feed_only' if exact and served else 'unsupported'
  if gap is None or gap>30:category='capture_boundary_or_gap'
  labels[key]={'bus':bus,'stop':stop,'at':t,'distance_m':d,'preceding_gap_sec':gap,'category':category}
 cat=labels[key]['category'];waitcounts[cat]+=1
 if cat=='curb_and_served':valid.append(w['id'])
result={'capture':capture,'capture_sha256':digest.hexdigest(),'waits':waits,'audit':dict(audit),'distinct_arrivals':len(labels),'arrival_categories':dict(collections.Counter(x['category'] for x in labels.values())),'wait_categories':dict(waitcounts),'valid_ids':valid,'arrivals':list(labels.values()),'limits':'Strict subset requires exact GPS poll, preceding gap <=30s, <=45m curb and served-stop transition. Feed-only cases may be genuine mis-sited stops; excluded for sensitivity, not declared false. GPS and served stop are from one upstream source, not independent physical truth.'}
open(out,'w').write(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ('valid_ids','arrivals')},indent=2))
