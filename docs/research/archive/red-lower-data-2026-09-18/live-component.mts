import fs from 'node:fs';
import {releaseDist,releaseResidual} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/release.ts';
const f=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-lower-data-2026-09-18/live-followup.json','utf8'));
const b=f.buses.find((b:any)=>b.bus_name==='#309'),pin=Date.parse(b.at_stop_since+'Z'),elapsed=(f.server_eta.at-pin)/1000,lap=b.lap['11']-elapsed;
const d=releaseDist(f.dwells['3']['11'].release,pin,lap)!; const residual=releaseResidual(d,elapsed);
console.log(JSON.stringify({pin,elapsed,lap,quantiles:Object.fromEntries([.01,.05,.1,.25,.5,.75,.9,.95].map(q=>[q,residual(q)]))}));
