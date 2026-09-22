"""Hosted-only fixed arithmetic workload; no fleet or outcome input exists here."""
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

import capture_input as d
from streaming_input import spool

HERE = Path(__file__).resolve().parent
TOPOLOGY_SHA = 'eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc'
spec = importlib.util.spec_from_file_location('synthetic_recorder', HERE/'results'/'recorder.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class Response(io.BytesIO):
    def __init__(self, body):
        super().__init__(body)
        self.headers = {'Content-Type':'application/json', 'Content-Length':str(len(body))}

    def getcode(self):
        return 200


def encoded(value):
    return (json.dumps(value, separators=(',', ':'), allow_nan=False)+'\n').encode()


def payload(topology, tick, at):
    stops = {s['id']:s for s in topology['stops']}
    body = dict(buses=[], routes={}, stop_names={str(i):s['name'] for i,s in stops.items()},
                stop_coords={str(i):{'lat':s['lat'],'lon':s['lon']} for i,s in stops.items()},
                segments={}, dwells={}, dwells_by_bus={}, route_paths={}, route_hours={},
                route_active={}, route_peaks={}, model_params=None, announcements=[])
    wire, rows, distributions = [], [], []
    for route in topology['routes']:
        rid, ring = str(route['id']), route['stops']
        body['routes'][rid] = ring
        body['route_paths'][rid] = route['path']
        body['segments'][rid] = {f'{a}-{ring[(i+1)%len(ring)]}':{'avg':90,'sd':15,'n':100} for i,a in enumerate(ring)}
        body['dwells'][rid] = {str(i):{'avg':20,'sd':5,'n':100} for i in ring}
        for ordinal in range(2):
            index = (tick//4 + ordinal*7) % len(ring)
            bus_index = len(wire)
            name = str(90000+route['id']*10+ordinal)
            stop = stops[ring[index]]
            body['buses'].append(dict(bus_id=int(name), bus_name='#'+name, route_id=route['id'],
                                     lat=stop['lat'], lon=stop['lon'], heading=0, last_stop_id=ring[index],
                                     last_stop_departed_at=at-10000, observed_at=at, lap={}))
            wire.append([name,route['name'],index,None])
            for hop in range(1,2*len(ring)+1):
                point = 30 + 15*((tick+ordinal)%3) + 90*(hop-1)
                low, high = max(0,point-30), point+60
                rows.append([bus_index,ring[(index+hop)%len(ring)],point,low,high,hop,0,max(0,point-20),max(0,low-20)])
                distributions.append([low+(high-low)*j//49 for j in range(50)])
    body['server_eta'] = dict(v=2, at=at, servedAt=at, buses=wire, rows=rows, distributions=distributions)
    return body


def make(output, assets, start, seconds):
    output, assets = Path(output), Path(assets)
    d.require(not output.exists(), 'Synthetic destination already exists')
    raw = (HERE/'canonical-topology.json').read_bytes()
    d.require(d.digest(raw) == TOPOLOGY_SHA, 'Changed static topology')
    d.require(d.digest((HERE/'results'/'recorder.py').read_bytes()) == d.SCRIPT_SHA256, 'Changed recorder')
    topology = json.loads(raw)
    proof = json.loads((HERE/'INITIAL-SOURCE-PROOF.json').read_text())
    files = {}
    for name, expected in proof['files'].items():
        body = (assets/name).read_bytes()
        d.require(len(body) == expected['bytes'] and d.digest(body) == expected['sha256'], 'Unsupported rebuilt baseline asset')
        files[c.BASE+('/' if name == 'index.html' else '/'+name)] = body
    epoch = dt.datetime.fromisoformat(start.replace('Z','+00:00'))
    state = {'us':-60000000, 'fleet':None}
    utc = lambda: (epoch+dt.timedelta(microseconds=state['us'])).isoformat()
    def opened(request, timeout):
        state['us'] += 1
        url = request.full_url
        if url == c.BASE+'/healthz':
            body = encoded({'build':proof['source']})
        elif url == c.BASE+'/api/buses':
            body = state['fleet']
        else:
            body = files[url]
        return Response(body)
    output.mkdir(parents=True)
    with patch.object(c,'utc',side_effect=utc), patch.object(c.time,'monotonic',side_effect=lambda:1000+state['us']/1000000):
        capture = c.Capture(output/'source', dt.datetime(2099,1,1,tzinfo=dt.timezone.utc), 8*1024**3, 0)
        with patch.object(capture.opener,'open',side_effect=opened):
            capture.release()
            for tick in range(seconds//15+1):
                state['us'] = tick*15000000+700000
                at = int(epoch.timestamp()*1000)+tick*15000+700
                if tick%4 == 0:
                    capture.release()
                data = payload(topology,tick,at)
                if seconds == 60 and tick == 2:
                    # Fixed large-legal-body integration stress, never used to
                    # change the full-schedule workload or physical forecasts.
                    data['research_synthetic_padding'] = ''
                    padding = 15*1024**2//2-len(encoded(data))
                    d.require(padding > 0, 'Static workload exceeds stress target')
                    data['research_synthetic_padding'] = 'x'*padding
                state['fleet'] = encoded(data)
                d.require(len(state['fleet']) <= d.BODY_LIMIT, 'Synthetic body exceeds recorder bound')
                capture.request(c.BASE+'/api/buses','fleet')
            capture.manifest.update(status='stopped',stopReason='synthetic-end',finishedAt=utc())
            capture.save()
        seal = d.freeze_prefix(output/'source',output/'prefix',capture.sequence)
    marker = dict(syntheticOnly=True, outcomes=False, generatorSha256=d.digest(Path(__file__).read_bytes()),
                  topologySha256=TOPOLOGY_SHA,start=start,seconds=seconds,
                  routes=14,busesPerRoute=2,cycles=2,distributionPoints=50,cadenceSeconds=15)
    (output/'prefix'/'synthetic-input.json').write_bytes(encoded(marker))
    result = spool(output/'prefix',seal,output/'spool',[proof])
    (output/'generation.json').write_text(json.dumps(dict(marker=marker,prefixSha256=seal,spool=result),indent=2)+'\n')
    return result


if __name__ == '__main__':
    output, assets, start, seconds = sys.argv[1:]
    result = make(output,assets,start,int(seconds))
    print(json.dumps({key:result[key] for key in ('captureId','events','distinctFleetBodies','coverage')}))
