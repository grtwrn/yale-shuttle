import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {createGunzip,gunzipSync,gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {ExactForecastStream} from '../learning-loop/stream.ts';

const service=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=path.join(service,'scripts/learning-runtime/__fixtures__/own-recovery-20261029');
const output=path.resolve(process.env.RECOVERY_DIAGNOSTIC_OUTPUT);
const read=f=>JSON.parse(fs.readFileSync(f));
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=read(fixture+'/manifest.json');
assert.equal(manifest.originalMainActualExitCode,1);
assert.equal(process.version,'v22.23.4');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
assert.equal(sha(fs.readFileSync(process.execPath)),manifest.nodeBinarySHA256);
for(const row of manifest.files){const b=fs.readFileSync(fixture+'/'+row.file);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
for(const [file,h]of Object.entries(manifest.sourceInventory))assert.equal(sha(fs.readFileSync(service+'/'+file)),h,file);
const models=read(fixture+'/models.json'),seed=JSON.parse(gunzipSync(fs.readFileSync(fixture+'/seed.json.gz')));
const receipt=read(fixture+'/fork-runtime-receipt.json'),expected=read(fixture+'/future-packet-sha256.json');
const fresh=new ExactForecastStream(models.build,models.sourceKey,models.champion,models.candidate);
fresh.seed(seed,models.candidate.publishedAt);
const restored=new ExactForecastStream(models.build,models.sourceKey,models.champion,models.candidate);
restored.recover(fixture,receipt,models.seedSha256);
assert.equal(fresh.seedSha256,models.seedSha256);
assert.equal(restored.cursor,receipt.cursor);
const rowsFile=output+'/all-own-cdfs.jsonl.gz';
let found=false,futurePackets=0,futureFrames=0,totalFrames=0,compressedBytes=0;
const cdfRows={champion:0,challenger:0},withoutCDF={champion:0,challenger:0};
const digest=createHash('sha256');
function compare(boundary){
 const result={cursor:fresh.cursor,at:fresh.at,boundary,arms:{}};
 for(const name of ['champion','challenger']){
  const a=fresh.stores[name].engine.evaluationForecasts(),b=restored.stores[name].engine.evaluationForecasts();
  result.arms[name]={fresh:a,restored:b};
  for(const row of a){if(row.distribution){assert.equal(row.distribution.length,50);cdfRows[name]++;}else withoutCDF[name]++;}
 }
 const raw=JSON.stringify(result)+'\n',encoded=gzipSync(raw,{level:1});compressedBytes+=encoded.length;
 assert(compressedBytes<=192*1024*1024);fs.appendFileSync(rowsFile,encoded);
 for(const name of ['champion','challenger'])assert.equal(sha(JSON.stringify(result.arms[name].fresh)),sha(JSON.stringify(result.arms[name].restored)),name+' full own CDF rows');
 digest.update(raw);
}
for await(const line of readline.createInterface({input:fs.createReadStream(fixture+'/inputs.jsonl.gz').pipe(createGunzip()),crlfDelay:Infinity})){
 const packet=JSON.parse(line).source;
 totalFrames+=fresh.advance(packet);
 if(!found){if(fresh.cursor===receipt.cursor){found=true;assert.equal(fresh.chain,restored.chain);compare(true);}else assert(fresh.cursor<receipt.cursor);continue;}
 assert.equal(sha(JSON.stringify(packet)),expected[futurePackets]);
 futurePackets++;futureFrames+=restored.advance(packet);assert.equal(fresh.cursor,restored.cursor);compare(false);
}
assert(found);assert.equal(totalFrames,manifest.originalLiveFrames);
assert.equal(futurePackets,manifest.futurePackets);assert.equal(futurePackets,expected.length);
assert.equal(futureFrames,manifest.futureFrames);assert(futureFrames>=177);
assert(cdfRows.champion>0&&cdfRows.challenger>0);
const result={at:new Date().toISOString(),ok:true,node:process.version,platform:process.platform,arch:process.arch,nodeBinarySHA256:manifest.nodeBinarySHA256,totalFrames,futureFrames,futurePackets,cdfRows,withoutCDF,quantilesPerCDF:50,checkpointCursor:receipt.cursor,lastCursor:fresh.cursor,rowsFile:path.basename(rowsFile),rowsBytes:fs.statSync(rowsFile).size,rowsSHA256:sha(fs.readFileSync(rowsFile)),allOwnCDFsSHA256:digest.digest('hex'),sourceFilesVerified:Object.keys(manifest.sourceInventory).length,originalMainActualExitCode:1,noNewProductionRequests:true,originalMainNeverRerun:true,scope:manifest.scope};
fs.writeFileSync(output+'/result.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
