import {afterEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {ServerEta, DEFAULT_SERVER_ETA_ROUTES} from '../../../src/server/serverEta';
import {applyModelParams, resetModelParams} from './params';
import {registerRoutePaths} from '../anchor';
import {ringForBus} from './index';
import captured from '../__fixtures__/purple-completed-curb-20261025.json';

afterEach(() => {resetModelParams();registerRoutePaths(undefined);});
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

describe('a departed curb after the bus establishes another road pause', () => {
  it('keeps the completed call closed while retaining the genuine at-curb call and future returns', () => {
    const compressed=Buffer.from(captured.data,'base64');
    expect(compressed.length).toBe(captured.bytes);
    expect(sha(compressed)).toBe(captured.sha256);
    const raw=brotliDecompressSync(compressed);
    expect(raw.length).toBe(captured.rawBytes);
    expect(sha(raw)).toBe(captured.rawSHA256);
    const {seed,frames}=JSON.parse(raw.toString());
    const engine=new ServerEta({routes:DEFAULT_SERVER_ETA_ROUTES,onServedForecasts:()=>{}});
    // Fork only the original empty common past, then compute every original
    // observation with this engine's own belief and display memory.
    expect(engine.restoreEvaluation(Buffer.from(seed.history.data,'base64'),'history',seed.at,Number.MAX_SAFE_INTEGER)).toBe(true);
    const atCurb=new Set([57,65]),afterDeparture=new Set(captured.completedCurb.closedVisitSequences);
    let present=0,closed=0;
    for(const frame of frames){
      expect(sha(frame.json)).toBe(frame.sha256);
      expect(sha(frame.contextJson)).toBe(frame.contextSha256);
      const body=JSON.parse(frame.json),context=JSON.parse(frame.contextJson);
      expect(applyModelParams(body.model_params)).toBe(true);
      expect(engine.useEvaluationContext(context)).toBe(true);
      const wire=engine.contribute(body,frame.at,frame.at,true);
      expect(engine.stats().failures).toBe(0);
      if(!atCurb.has(frame.seq)&&!afterDeparture.has(frame.seq))continue;
      const slot=wire!.buses.findIndex(b=>b[0]==='332'&&b[1]==='Purple');
      expect(slot).toBeGreaterThanOrEqual(0);
      const rows=wire!.rows.filter(r=>r[0]===slot&&r[1]===9).sort((a,b)=>a[5]-b[5]);
      if(atCurb.has(frame.seq)){
        present++;
        expect(rows[0]![2]).toBe(0);
        expect(rows[0]![5]).toBe(0);
      }else{
        closed++;
        // The bus is driving beyond the completed curb. The next two
        // in-horizon arrivals are future traversals, even if an old standing branch
        // remains held while a new pause is attributed elsewhere.
        const stopCount=ringForBus({route_id:10},body.routes['10'],body.stop_coords)!.N;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]![5]).toBe(stopCount);
        expect(rows[0]![2]).toBeGreaterThan(0);
        if(rows[1]){
          expect(rows[1][5]).toBe(2*stopCount);
          expect(rows[1][2]).toBeGreaterThan(rows[0]![2]);
        }
        for(const row of rows){
          const index=wire!.rows.indexOf(row),law=wire!.distributions![index]!;
          expect(law).toHaveLength(50);
          expect(law).toEqual([...law].sort((a,b)=>a-b));
          expect(row[3]).toBeLessThanOrEqual(row[2]);
          expect(row[4]).toBeGreaterThanOrEqual(row[2]);
        }
        const next=wire!.rows.find(r=>r[0]===slot&&r[1]===1&&r[5]===1);
        expect(next).toBeDefined();
        expect(next![2]).toBeGreaterThan(0);
      }
    }
    expect(present).toBe(2);
    expect(closed).toBe(afterDeparture.size);
  });
});
