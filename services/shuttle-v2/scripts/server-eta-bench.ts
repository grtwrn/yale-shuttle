/**
 * How long does the server-side belief block the event loop?
 *
 * The number that matters is NOT total CPU per poll (35 ms every 5 s is 0.7%
 * of a core). It is the longest UNINTERRUPTED synchronous run, because that is
 * head-of-line blocking on the loop that serves /api/buses at ~40 req/s.
 *
 * So this measures two things per poll:
 *   - `total`  — wall clock from the first byte of work to the last.
 *   - `block`  — the LONGEST single synchronous stretch inside that, which is
 *                what a request queued behind it actually waits.
 *
 * For the synchronous engine the two are the same by construction. For the
 * chunked one they are not, and the difference is the whole point.
 *
 * Usage: nice -n 10 npx tsx scripts/server-eta-bench.ts [--runs N]
 */
import fs from "node:fs";

import { registerRoutePaths } from "../web/src/anchor.js";
import { ServerEta, SLICE_BUDGET_MS as SLICE_BUDGET, type EtaPayloadView } from "../src/server/serverEta.js";
import { ROUTE_LISTS } from "../web/src/routes.js";

const CAP = JSON.parse(fs.readFileSync(
  new URL("../src/server/__fixtures__/live-frames.json", import.meta.url), "utf8",
)) as {
  static: { routes: Record<string, number[]>; route_paths: Record<string, [number, number][]>;
    stop_coords: Record<number, { lat: number; lon: number }>; segments: any; dwells: any };
  frames: { t: number; buses: any[] }[];
};

const ALL = ROUTE_LISTS.map((c) => c.label);
const payloadFor = (f: { buses: any[] }): EtaPayloadView => ({
  buses: f.buses, routes: CAP.static.routes, stop_coords: CAP.static.stop_coords as any,
  segments: CAP.static.segments, dwells: CAP.static.dwells, route_paths: CAP.static.route_paths,
});

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 3;

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
function report(name: string, totals: number[], blocks: number[], cpu: number[]) {
  const f = (x: number) => x.toFixed(1);
  console.log(
    `${name.padEnd(8)} n=${totals.length}  total ms p50=${f(pct(totals, 0.5))} p90=${f(pct(totals, 0.9))} max=${f(Math.max(...totals))}` +
    `\n           BLOCK wall ms p50=${f(pct(blocks, 0.5))} p90=${f(pct(blocks, 0.9))} max=${f(Math.max(...blocks))}` +
    `\n           BLOCK cpu  ms p50=${f(pct(cpu, 0.5))} p90=${f(pct(cpu, 0.9))} max=${f(Math.max(...cpu))}`,
  );
}

/**
 * Both arms, INTERLEAVED frame by frame in one process.
 *
 * The Pi runs the canary's browsers alongside everything else, so an arm
 * measured on its own is measured under whatever load happened to be there.
 * Interleaving makes the two arms share that load, which is the only way a
 * before/after on this machine means anything.
 *
 *  - `sync` is the SAME pass with `sliceBudgetMs: Infinity`, i.e. one
 *    uninterrupted slice — exactly what the engine did before chunking.
 *  - `chunk` is the shipped budget.
 *
 * Frame 0 is reported separately: it builds every ring and every stand table
 * from scratch, a one-time cost per process that no amount of chunking of the
 * per-bus loop can divide below one ring.
 */
async function bench(): Promise<void> {
  const arms = [
    { name: "sync", budget: Infinity, totals: [] as number[], blocks: [] as number[], cpu: [] as number[], first: [] as number[] },
    { name: "chunked", budget: SLICE_BUDGET, totals: [] as number[], blocks: [] as number[], cpu: [] as number[], first: [] as number[] },
  ];
  for (let r = 0; r < runs; r++) {
    registerRoutePaths(null);
    const engines = arms.map((a) => new ServerEta({ routes: ALL, sliceBudgetMs: a.budget }));
    for (let i = 0; i < CAP.frames.length; i++) {
      const f = CAP.frames[i]!;
      for (let a = 0; a < arms.length; a++) {
        const arm = arms[a]!;
        const slices: number[] = [], cpus: number[] = [];
        const t0 = performance.now();
        await engines[a]!.step(payloadFor(f), r * 1000 + i, f.t, (ms, cpu) => { slices.push(ms); cpus.push(cpu); });
        const total = performance.now() - t0;
        const block = slices.length ? Math.max(...slices) : total;
        if (i === 0) arm.first.push(block);
        else { arm.totals.push(total); arm.blocks.push(block); arm.cpu.push(Math.max(...cpus)); }
      }
    }
  }
  for (const a of arms) {
    report(a.name, a.totals, a.blocks, a.cpu);
    console.log(`  first poll (rings + tables built) block ms: ${a.first.map((x) => x.toFixed(0)).join(", ")}`);
  }
}

const main = async () => {
  await bench();
  registerRoutePaths(null);
};
void main();
