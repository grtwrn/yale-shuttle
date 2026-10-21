import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {gzipSync,gunzipSync} from 'node:zlib';
import {witnessSHA} from '../../src/collector/witnessCodec.ts';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),MiB=1024*1024;
export const POLICY=Object.freeze({maxBytes:256*MiB,maxAgeMs:30*86400000,minFreeBytes:128*MiB});
export class HistoryHold extends Error{}
export class HistoryStore{
 constructor(directory,{policy={}}={}){
  this.directory=directory;this.policy={...POLICY,...policy};for(const[k,v]of Object.entries(this.policy))if(!Number.isSafeInteger(v)||v<(k==='minFreeBytes'?0:1))throw Error('Invalid history policy');if(this.policy.maxBytes<12*MiB)throw Error('History budget is too small');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink()||!fs.lstatSync(directory).isDirectory())throw Error('Invalid history directory');this.file=path.join(directory,'history.sqlite');
  if(fs.existsSync(this.file)&&(!fs.lstatSync(this.file).isFile()||fs.lstatSync(this.file).isSymbolicLink()))throw Error('Invalid history database');
  this.db=new DatabaseSync(this.file);try{
   fs.chmodSync(this.file,0o600);this.db.exec('PRAGMA busy_timeout=500;PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA fullfsync=ON');
   const version=this.db.prepare('PRAGMA user_version').get().user_version,exists=this.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n;if(version!==1&&(version!==0||exists))throw Error('Unsupported history schema');
   if(!exists)this.db.exec(`PRAGMA auto_vacuum=FULL;CREATE TABLE meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE chunks(id TEXT PRIMARY KEY,at INTEGER NOT NULL,last_at INTEGER NOT NULL,raw_sha TEXT NOT NULL,payload BLOB NOT NULL);CREATE INDEX chunk_age ON chunks(at);CREATE TABLE topologies(sha TEXT PRIMARY KEY,bytes INTEGER NOT NULL,payload BLOB NOT NULL);CREATE TABLE chunk_topologies(chunk TEXT REFERENCES chunks(id) ON DELETE CASCADE,topology TEXT REFERENCES topologies(sha),PRIMARY KEY(chunk,topology));PRAGMA user_version=1;`);
   if(this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum!==1||this.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Invalid history integrity/vacuum');const size=this.db.prepare('PRAGMA page_size').get().page_size;this.databaseLimit=Math.floor(this.policy.maxBytes/3/size)*size;this.db.exec('PRAGMA max_page_count='+this.databaseLimit/size);if(this.usedBytes()>this.databaseLimit)throw new HistoryHold('History exceeds configured budget');
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 usedBytes(){return this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size;}
 state(){const r=this.db.prepare("SELECT json FROM meta WHERE key='state'").get();return r?JSON.parse(r.json):{};}
 disk(){let bytes=0,unknown=false;for(const name of fs.readdirSync(this.directory)){const st=fs.lstatSync(path.join(this.directory,name));bytes+=Math.max(st.size,(st.blocks??0)*512);if(!st.isFile()||st.isSymbolicLink()||!['history.sqlite','history.sqlite-journal','storage.lock','status.json','retention.json','watcher.log'].includes(name)&&!/^watcher\.log\.\d+\.gz$/.test(name))unknown=true;}const s=fs.statfsSync(this.directory);return{bytes,unknown,freeBytes:s.bavail*s.bsize};}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){try{this.db.exec('ROLLBACK');}catch{}throw e;}}
 maintain(now=Date.now(),reserve=0){
  const disk=this.disk();if(disk.unknown)throw new HistoryHold('Unknown history files require review');if(disk.freeBytes<this.policy.minFreeBytes+this.databaseLimit+reserve)throw new HistoryHold('History free-space reserve exhausted');let deleted=0;
  this.transaction(()=>{for(const row of this.db.prepare('SELECT id FROM chunks WHERE last_at<? ORDER BY last_at,id').all(now-this.policy.maxAgeMs)){this.db.prepare('DELETE FROM chunks WHERE id=?').run(row.id);deleted++;}this.db.exec('DELETE FROM topologies WHERE sha NOT IN(SELECT topology FROM chunk_topologies)');});
  // FULL auto-vacuum shrinks only when the cleanup transaction commits.
  while(this.usedBytes()+reserve>this.databaseLimit){const row=this.db.prepare('SELECT id FROM chunks ORDER BY last_at,id LIMIT 1').get();if(!row)throw new HistoryHold('History batch exceeds budget');this.transaction(()=>{this.db.prepare('DELETE FROM chunks WHERE id=?').run(row.id);this.db.exec('DELETE FROM topologies WHERE sha NOT IN(SELECT topology FROM chunk_topologies)');});deleted++;}
  const after=this.disk();if(after.bytes+this.databaseLimit+reserve>this.policy.maxBytes)throw new HistoryHold('History physical reserve exhausted');return{bytes:after.bytes,maxBytes:this.policy.maxBytes,maxAgeDays:this.policy.maxAgeMs/86400000,deleted,chunks:this.db.prepare('SELECT count(*) n FROM chunks').get().n};
 }
 commit({records,state,topologies=new Map(),now=Date.now()}){
  const stateJSON=JSON.stringify(state);if(Buffer.byteLength(stateJSON)>512*1024)throw new HistoryHold('History projection context exceeds bound');
  // A cold two-hour capture can exceed one chunk. All bounded subchunks and
  // the cursor still commit in ONE transaction; no partial batch is visible.
  const groups=[];let group=[],groupBytes=32,totalBytes=0;
  for(const record of records){const bytes=Buffer.byteLength(JSON.stringify(record))+1;if(bytes>4*MiB)throw new HistoryHold('History record exceeds bound');totalBytes+=bytes;if(totalBytes>32*MiB)throw new HistoryHold('History projection batch exceeds bound');if(groupBytes+bytes>4*MiB){groups.push(group);group=[];groupBytes=32;}group.push(record);groupBytes+=bytes;}if(group.length)groups.push(group);
  const chunks=groups.map((rows,i)=>{const json=JSON.stringify({v:1,records:rows}),rawSHA=witnessSHA(json);return{rows,json,rawSHA,payload:gzipSync(json),id:witnessSHA(JSON.stringify([witnessSHA(stateJSON),i,rawSHA]))};});
  const required=new Set(records.flatMap(r=>[r.collector?.topologySha256,r.header?.topologySha256]).filter(Boolean));
  const dictionary=[...required].map(s=>{const t=topologies.get(s);if(!t)return null;if(witnessSHA(t.json)!==s||Buffer.byteLength(t.json)!==t.bytes)throw Error('History topology commitment differs');return{...t,payload:gzipSync(t.json)};}).filter(Boolean);
  // Unknown model-source topologies remain explicitly absent; no later route
  // geometry is substituted for a missing capture-time dictionary.
  const reserve=262144+3*(chunks.reduce((s,c)=>s+c.payload.length,0)+dictionary.reduce((s,t)=>s+t.payload.length,0)+Buffer.byteLength(stateJSON));const retention=this.maintain(now,reserve);
  this.transaction(()=>{for(const t of dictionary)this.db.prepare('INSERT OR IGNORE INTO topologies VALUES(?,?,?)').run(t.sha256,t.bytes,t.payload);for(const c of chunks){const times=c.rows.map(r=>r.at).filter(Number.isFinite);this.db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?,?,?,?)').run(c.id,Math.min(...times),Math.max(...times),c.rawSHA,c.payload);for(const t of dictionary)this.db.prepare('INSERT OR IGNORE INTO chunk_topologies VALUES(?,?)').run(c.id,t.sha256);}
   this.db.prepare("INSERT INTO meta VALUES('state',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(stateJSON);});
  const disk=this.disk();if(disk.bytes>this.policy.maxBytes)throw Error('History physical budget violated');return{...retention,bytes:disk.bytes,chunks:this.db.prepare('SELECT count(*) n FROM chunks').get().n,committedRecords:records.length,id:chunks[0]?.id??null,chunkIds:chunks.map(c=>c.id),chunkSHA256:chunks.map(c=>c.rawSHA),rawProjectionBytes:totalBytes};
 }
 read(id){const row=this.db.prepare('SELECT * FROM chunks WHERE id=?').get(id);if(!row)throw Error('History chunk unavailable');const raw=gunzipSync(row.payload,{maxOutputLength:8*MiB}).toString();if(witnessSHA(raw)!==row.raw_sha)throw Error('History projection commitment differs');return JSON.parse(raw);}
}
