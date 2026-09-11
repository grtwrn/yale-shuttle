/** Does the replay's time-travelled dwell match what production served? */
import fs from "node:fs";
import { DAY_MS, loadNet, fmtEt } from "./common.js";
import { median, percentile } from "../../src/calibrator/shrinkage.js";
const net = loadNet(); const { db } = net;
const live = JSON.parse(fs.readFileSync(process.env.LIVE!, "utf8"));
const at = Number(process.env.AT ?? (db.prepare("SELECT MAX(arrived_at) m FROM arrivals").get() as any).m);
console.log("comparing at", fmtEt(at));
const DW = 14 * DAY_MS;
const rows = db.prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ?`).all(at - DW - 3_600_000, at) as any[];
const g = new Map<string, any[]>();
for (const x of rows) { const k = `${x.r}:${x.s}`; let l = g.get(k); if (!l) g.set(k, (l = [])); l.push(x); }
const d0 = new Date(at); const dow = d0.getDay();
const hours = new Set([(d0.getHours()+23)%24, d0.getHours(), (d0.getHours()+1)%24]);
let n=0, medOk=0, lowOk=0; const medErr:number[]=[]; const lowErr:number[]=[];
for (const rid of Object.keys(live.dwells)) for (const sid of Object.keys(live.dwells[rid])) {
  const served = live.dwells[rid][sid];
  const l = g.get(`${rid}:${sid}`); if (!l) continue;
  const all:number[]=[]; const win:number[]=[];
  for (const x of l) { if (x.a < at - DW || x.a + x.d*1000 > at) continue; all.push(x.d); if (x.dow===dow && hours.has(x.hour)) win.push(x.d); }
  if (!all.length) continue;
  const low = all.length >= 5 ? percentile(all, 0.35) : undefined;
  const med = win.length ? median(win) : median(all);
  n++;
  const dm = Math.abs(med - served.med); medErr.push(dm); if (dm <= 1) medOk++;
  if (served.low !== undefined && low !== undefined) { const dl = Math.abs(Math.min(low,med) - served.low); lowErr.push(dl); if (dl <= 1) lowOk++; }
}
const p=(a:number[],q:number)=>{a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length*q)]??NaN};
console.log(`compared ${n} (route,stop) dwell entries`);
console.log(`med within 1 s: ${medOk}/${n} = ${(100*medOk/n).toFixed(1)}%   median |diff| ${p(medErr,0.5).toFixed(1)}s  p90 ${p(medErr,0.9).toFixed(1)}s`);
console.log(`low within 1 s: ${lowOk}/${lowErr.length} = ${(100*lowOk/lowErr.length).toFixed(1)}%   median |diff| ${p(lowErr,0.5).toFixed(1)}s  p90 ${p(lowErr,0.9).toFixed(1)}s`);
