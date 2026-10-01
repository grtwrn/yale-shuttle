import http from 'node:http';
import fs from 'node:fs';
const template=JSON.parse(fs.readFileSync('/tmp/wait-label-live-02.json','utf8'));
const start=Date.now();
http.createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.url.startsWith('/api/buses')) {
  const p=structuredClone(template), now=Date.now(),at=start+Math.floor((now-start)/5000)*5000;
  const delta=at-template.server_eta.at;
  p.server_eta.at=at;p.server_eta.servedAt=now;
  for(const b of p.buses) {b.observed_at=at;for(const k of ['at_stop_since','stationary_since','last_moved_at'])if(b[k])b[k]=new Date(Date.parse(b[k]+'Z')+delta).toISOString().replace('Z','');}
  for(const b of p.server_eta.buses)if(b[3])b[3].standingSec+=(at-start)/1000;
  const source=fs.readFileSync(process.cwd()+'/src/server/app.ts','utf8');
  const cache=source.slice(source.indexOf('app.get("/api/buses"')).match(/c.header\("Cache-Control", "([^"]+)"\)/)[1];
  res.setHeader('Cache-Control',cache);
  res.end(JSON.stringify(p));return;
 }
 if(req.url.startsWith('/api/geocode'))return res.end(JSON.stringify({results:[{display_name:'VA Hospital',lat:'41.2845',lon:'-72.9577',type:'hospital',class:'amenity'}]}));
 res.end('{}');
}).listen(8092,'127.0.0.1');
