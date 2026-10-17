import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps recorded production forecasts independent of earlier movement-cache callers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-cache-process-'));
  try {
    const script = path.join(directory, 'replay.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';import {createHash} from 'node:crypto';
const {ServerEta}=await import(${JSON.stringify(new URL('./serverEta.ts', import.meta.url).href)});
const {moveKernel}=await import(${JSON.stringify(new URL('../../web/src/eta/filter.ts', import.meta.url).href)});
const {ROUTE_LISTS}=await import(${JSON.stringify(new URL('../../web/src/routes.ts', import.meta.url).href)});
const cap=JSON.parse(fs.readFileSync(new URL(${JSON.stringify(new URL('./__fixtures__/live-frames.json', import.meta.url).href)}),'utf8'));
for(let bucket=6;bucket<400;bucket++)moveKernel(bucket/10+Number(process.argv[2]));
const engine=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});
const wires=cap.frames.slice(0,40).map(f=>engine.contribute({...cap.static,buses:structuredClone(f.buses)},f.t,f.t));
if(!wires.every(w=>w&&w.rows.length))throw Error('Replay did not produce forecasts');
process.stdout.write(createHash('sha256').update(JSON.stringify(wires)).digest('hex'));`);
    const run = (offset: string) => execFileSync(process.execPath,
      [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), script, offset],
      { encoding: 'utf8', timeout: 20000 });
    expect(run('0.049')).toBe(run('-0.049'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 45000);
