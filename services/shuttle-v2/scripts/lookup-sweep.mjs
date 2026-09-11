#!/usr/bin/env node
/**
 * lookup-sweep — which real campus places can a rider NOT find?
 *
 * A rider searched for the Chaplain's Office and got nothing. That was found
 * the expensive way: somebody filed a report. "Chaplain" appears nowhere in
 * OpenStreetMap either, so no external provider could ever have answered it —
 * only a curated entry in `src/server/landmarks.ts` can. This script finds the
 * next one of those before a rider does, and keeps the ones we fix fixed.
 *
 *   node scripts/lookup-sweep.mjs [--sample=N] [--seed=N] [--local-only]
 *                                 [--json] [--all] [--limit=N]
 *                                 [--max-unfindable=N] [--cache] [--refresh]
 *
 * ── The one thing to get right ──────────────────────────────────────────────
 *
 * **"Found" means found by the pipeline a rider actually hits.** The first cut
 * of this measurement scored names against `geocode()` alone — the curated list
 * plus stop names — and reported 213 of 311 Yale places missing. That number
 * was wrong, and dangerously so: production does not stop at the local layer.
 * `geocodeV1` falls through to Photon and then Nominatim, and those know every
 * object Overpass just handed us, because it all came out of OSM in the first
 * place. Sampled against the real stack, 16 of 18 supposed misses were
 * findable. A harness that invents 200 gaps would send somebody off to curate
 * 200 entries — and `landmarks.ts` warns in its own header that padding the
 * list dilutes ranking. So the scorer here is `geocodeV1` with a REAL external
 * geocoder, and the local-only score is reported beside it, never instead.
 *
 * Three buckets, because they mean three different things:
 *
 *   curated    the local layer answers it. Ranks first, costs no external
 *              call, and cannot be taken away by a third party having a bad
 *              afternoon. The goal state.
 *   uncurated  only Photon/Nominatim answer it. NOT a defect — the rider does
 *              find the place. Curating it still buys rank, latency and a
 *              better label, but that is an improvement, not a bug.
 *   UNFINDABLE neither layer answers it. This is the defect, and a curated
 *              entry is the only possible fix.
 *
 * ── The rest of the method ──────────────────────────────────────────────────
 *
 *  - **The truth set comes from OpenStreetMap, not from us.** A list we wrote
 *    ourselves would only hold places we had already thought of, which is
 *    exactly the blind spot. Note the corollary: the sweep is blind to places
 *    OSM does not name — the Chaplain's Office included. Search analytics
 *    (`GET /api/stats/searches`) is the instrument for those, and the two
 *    together are the loop.
 *  - **A hit counts when it lands within {@link HIT_RADIUS_M} of the real
 *    place and ranks in the top {@link TOP_N}.** Name equality is the wrong
 *    test ("Yale University" matches a dozen labels) and rank matters because
 *    the dropdown is short.
 *  - **Only places within the planner's `MAX_WALK_M` of a stop are judged.**
 *    Past it no trip exists, so a landmark would answer a search with a
 *    journey the app cannot plan.
 *  - **A miss whose OSM id we ALREADY curate is an alias, not a new entry** —
 *    `landmarks.ts` records the id as the trailing comment on each line, so
 *    the script reads it back and says so.
 *
 * ── Rate limits ─────────────────────────────────────────────────────────────
 *
 * The external path is throttled to one outbound request every 1.1 s BY
 * DESIGN, to keep our egress IP off Nominatim's block list. This script calls
 * `geocodeV1` in-process, so that throttle applies to it exactly as it applies
 * to the server, and lookups are strictly sequential. A full sweep therefore
 * takes minutes and says so before it starts; `--sample=N` is the quick check.
 *
 * Calling `geocodeV1` directly rather than a server's `/api/geocode` is also
 * what keeps the sweep out of the rider data: that route records every query
 * in `search_terms`, the table that exists to say what RIDERS looked for, and
 * a few hundred synthetic OSM names would be indistinguishable from demand.
 * Those rows carry no id by design, so nothing could clean up after us.
 *
 * Exit codes
 *   0  swept cleanly (and, with --max-unfindable, within budget)
 *   1  more unfindable places than --max-unfindable allows
 *   2  the harness itself broke (Overpass down, no live payload, import failed)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { register } from "tsx/esm/api";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// -- CLI ----------------------------------------------------------------------
// Read first: a couple of the constants below take a command-line override.

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit === undefined ? undefined : hit.slice(f.length + 1);
};

// -- Tuning -------------------------------------------------------------------

/**
 * How close a suggestion has to be to count as the place the rider meant.
 * 250 m is about the block-and-a-half a curated landmark may sit from its
 * serving stop; tighter, and a correct answer pinned to a building entrance
 * rather than to the courtyard would read as a miss.
 */
const HIT_RADIUS_M = 250;

/** The dropdown is short — an answer at rank 8 is not an answer. */
const TOP_N = 3;

/** Campus and everything the Downtowner's core loops reach. */
const BBOX = process.env.SWEEP_BBOX ?? "41.29,-72.95,41.34,-72.90";

const OVERPASS =
  process.env.SWEEP_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

/** Where the live stop list comes from. Read-only, and sent without an
 *  `x-anon-id`, so the sweep is not counted as a rider. */
const BASE = (
  val("--base") ??
  process.env.SWEEP_BASE_URL ??
  "https://yale-shuttle.fly.dev"
).replace(/\/+$/, "");

/** Two OSM objects this close under one name are one place (a POI node inside
 *  its own building way), not two. */
const DUPE_M = 150;

/** `GEOCODE_MIN_INTERVAL_MS` in src/server/v1compat.ts — used only to quote an
 *  honest ETA before a long run. The real pacing is that constant itself,
 *  enforced inside the geocoder this script calls. */
const THROTTLE_MS = 1100;

/** Overpass answers 406 to Node's default UA, and it is a free service run by
 *  volunteers — say who is calling. */
const UA = "yale-shuttle-lookup-sweep/1.0 (+https://yale-shuttle.fly.dev)";

/** Overpass sheds load with a 504; one retry is worth it, a storm is not. */
const OVERPASS_ATTEMPTS = 2;

const CACHE = resolve(HERE, ".cache/lookup-sweep-overpass.json");
const CACHE_MAX_AGE_MIN = 60;

// -- Options ------------------------------------------------------------------

/** A mistyped threshold must not read as "no threshold" and pass silently. */
const num = (name) => {
  const v = val(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`lookup-sweep: ${name} wants a non-negative number, got "${v}"`);
    process.exit(2);
  }
  return n;
};
const OPT = {
  json: flag("--json"),
  all: flag("--all"),
  localOnly: flag("--local-only"),
  sample: num("--sample"),
  seed: num("--seed"),
  limit: num("--limit"),
  maxUnfindable: num("--max-unfindable"),
  cache: flag("--cache"),
  refresh: flag("--refresh"),
};

/**
 * --local-only cannot tell "findable by Photon" from "findable by nobody" —
 * that conflation IS the mistake this harness exists to stop repeating, so the
 * gate refuses to be armed on a number that does not mean what it says.
 */
if (OPT.localOnly && OPT.maxUnfindable !== undefined) {
  console.error(
    "lookup-sweep: --max-unfindable needs the full pipeline. --local-only\n" +
      "  cannot separate \"only Photon finds it\" from \"nobody finds it\", and\n" +
      "  gating on the conflated number is how 213 false gaps got reported.",
  );
  process.exit(2);
}

/**
 * Progress and diagnostics on stderr — ALWAYS, `--json` included. stdout is
 * what gets piped, so silencing stderr under --json bought nothing and left a
 * five-minute run with no sign of life.
 */
const log = (...a) => console.error(...a);

/** The report itself — stdout, in both modes. */
const out = (...a) => console.log(...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- Overpass -----------------------------------------------------------------

/**
 * `out center` gives a way its centroid, so a building and a POI node arrive in
 * the same shape. `operator` catches what Yale runs under another name (the
 * health centre, the golf course); `place_of_worship` is the class the
 * Chaplain's Office belongs to, and the one riders reach for by function
 * rather than by name.
 */
function overpassQuery(bbox) {
  return `[out:json][timeout:90];
(
  node["name"~"Yale",i](${bbox});
  way["name"~"Yale",i](${bbox});
  node["operator"~"Yale",i](${bbox});
  way["operator"~"Yale",i](${bbox});
  node["amenity"="place_of_worship"](${bbox});
  way["amenity"="place_of_worship"](${bbox});
);
out center tags;`;
}

async function fetchOverpass() {
  if (OPT.cache && !OPT.refresh && existsSync(CACHE)) {
    const ageMin = (Date.now() - statSync(CACHE).mtimeMs) / 60_000;
    if (ageMin < CACHE_MAX_AGE_MIN) {
      log(`overpass: cached (${ageMin.toFixed(0)} min old)`);
      return JSON.parse(readFileSync(CACHE, "utf8"));
    }
  }
  log(`overpass: querying ${OVERPASS} for ${BBOX} …`);
  // The public instance sheds load with a 504 under a slot shortage and is
  // fine seconds later; one retry turns a routine hiccup back into a run.
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(OVERPASS, {
      method: "POST",
      // Overpass wants the query form-encoded under `data`, and answers 406 to
      // Node's default User-Agent — naming ourselves is the fix and the polite
      // thing to do on somebody else's free service.
      body: new URLSearchParams({ data: overpassQuery(BBOX) }),
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok || attempt === OVERPASS_ATTEMPTS) break;
    log(`overpass: ${res.status} ${res.statusText}, retrying in 10 s …`);
    await sleep(10_000);
  }
  if (!res.ok) throw new Error(`overpass ${res.status} ${res.statusText}`);
  const body = await res.json();
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(body));
  } catch {
    // A cache we cannot write is not a reason to fail the sweep.
  }
  return body;
}

/** OSM's own vocabulary for what a place is, best tag first. For the report
 *  only — a human triaging the list wants to tell a chapel from a car park
 *  without opening OSM. */
function kindOf(tags) {
  // `building=yes` says nothing; a named building type does. Undefined rather
  // than false, so the ?? chain below actually falls through it.
  const building =
    typeof tags.building === "string" && tags.building !== "yes" ? tags.building : undefined;
  return (
    tags.amenity ??
    tags.leisure ??
    tags.tourism ??
    tags.shop ??
    tags.office ??
    tags.healthcare ??
    tags.historic ??
    tags.landuse ??
    building ??
    ""
  );
}

function placesFrom(overpass, distance) {
  const raw = [];
  for (const el of overpass.elements ?? []) {
    const tags = el.tags ?? {};
    const name = typeof tags.name === "string" ? tags.name.trim() : "";
    if (name.length === 0) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    raw.push({ name, lat, lon, kind: kindOf(tags), id: `${el.type[0].toUpperCase()}${el.id}` });
  }
  // A named POI node inside its own building way is one place. Same name
  // within DUPE_M collapses; the same name far away (two Willoughby's) stays.
  const kept = [];
  for (const p of raw) {
    const key = p.name.toLowerCase();
    if (!kept.some((k) => k.name.toLowerCase() === key && distance(k, p) < DUPE_M)) {
      kept.push(p);
    }
  }
  kept.sort((a, b) => a.name.localeCompare(b.name));
  return kept;
}

/**
 * Every OSM object id the curated list has already been verified against —
 * `landmarks.ts` records it as the trailing comment on each entry's line.
 * Reading it back sharpens the miss list: a miss whose id we ALREADY curate is
 * not a missing place, it is a missing ALIAS. OSM calls it "Yale Police
 * Department"; our label is "Yale Police (101 Ashmun)", and the matcher scores
 * that pair at zero. One line to fix, and not a new entry.
 */
function curatedOsmIds() {
  const src = readFileSync(resolve(ROOT, "src/server/landmarks.ts"), "utf8");
  const byId = new Map();
  for (const line of src.split("\n")) {
    const label = /label:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    const osm = /\/\/\s*OSM\s+([NWR]\d+)/i.exec(line);
    if (label && osm) byId.set(osm[1].toUpperCase(), label[1]);
  }
  return byId;
}

// -- The live network ---------------------------------------------------------

/**
 * `/api/buses` is the v1-shaped payload the frontend polls: `stop_coords` and
 * `stop_names` keyed by id, `routes` as id → stop-id sequence. Rebuilt into the
 * `TransitNetwork` the server's own geocoder gets, so the stop half of the
 * matcher is graded on the live 172 stops rather than a fixture that can age.
 */
async function fetchNetwork(TransitNetwork) {
  const res = await fetch(`${BASE}/api/buses`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${BASE}/api/buses → ${res.status}`);
  const payload = await res.json();
  const stops = Object.entries(payload.stop_coords ?? {}).map(([id, c]) => ({
    id: Number(id),
    name: payload.stop_names?.[id] ?? `Stop ${id}`,
    lat: c.lat,
    lon: c.lon,
  }));
  if (stops.length === 0) throw new Error("/api/buses returned no stops");
  const routes = Object.entries(payload.routes ?? {}).map(([id, stopIds]) => ({
    id: Number(id),
    name: `Route ${id}`,
    shortName: String(id),
    color: "#000000",
    stops: Array.isArray(stopIds) ? stopIds.map(Number) : [],
  }));
  return { network: TransitNetwork.build(stops, routes), stops };
}

// -- The sweep ----------------------------------------------------------------

function nearestStop(p, stops, distance) {
  let best = null;
  for (const s of stops) {
    const m = distance(p, s);
    if (best === null || m < best.meters) best = { name: s.name, meters: m };
  }
  return best;
}

/** Deterministic PRNG, so `--sample` is reproducible with `--seed`. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleOf(places, n, seed) {
  const rnd = mulberry32(seed);
  const pool = places.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).sort((a, b) => a.name.localeCompare(b.name));
}

const humanDuration = (ms) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `~${Math.round(ms / 60_000)} min`;

async function main() {
  register();
  const { TransitNetwork } = await import(resolve(ROOT, "src/network/TransitNetwork.ts"));
  const { distanceMeters } = await import(resolve(ROOT, "src/network/geo.ts"));
  const { geocode, LANDMARKS } = await import(resolve(ROOT, "src/server/geocode.ts"));
  const { geocodeV1, createExternalGeocoder } = await import(
    resolve(ROOT, "src/server/v1compat.ts")
  );
  const { MAX_WALK_M } = await import(resolve(ROOT, "web/src/walk.ts"));

  const [overpass, live] = await Promise.all([fetchOverpass(), fetchNetwork(TransitNetwork)]);
  const { network, stops } = live;
  const curated = curatedOsmIds();

  let places = placesFrom(overpass, distanceMeters);
  const total = places.length;
  if (OPT.limit !== undefined) places = places.slice(0, OPT.limit);

  // A place the planner cannot route to is not worth curating either way, so
  // it is set aside BEFORE any lookup is spent on it — not judged and then
  // filtered out of the report.
  const withStop = places.map((p) => {
    const s = nearestStop(p, stops, distanceMeters);
    return { ...p, stop: s && { name: s.name, meters: Math.round(s.meters) } };
  });
  const outOfReach = withStop.filter((p) => !p.stop || p.stop.meters > MAX_WALK_M);
  let judged = withStop.filter((p) => p.stop && p.stop.meters <= MAX_WALK_M);

  if (OPT.sample !== undefined && OPT.sample < judged.length) {
    judged = sampleOf(judged, OPT.sample, OPT.seed ?? 1);
  }

  log(
    `swept ${judged.length} of ${total} OSM places ` +
      `(${outOfReach.length} beyond ${MAX_WALK_M} m from any stop) against ` +
      `${LANDMARKS.length} landmarks + ${stops.length} stops`,
  );

  const external = OPT.localOnly ? { lookup: async () => [] } : createExternalGeocoder();
  if (!OPT.localOnly) {
    // The external path is deliberately throttled to protect our egress IP.
    // Saying so up front is the difference between "slow" and "hung".
    log(
      `full pipeline: Photon/Nominatim are throttled to one lookup per ` +
        `${THROTTLE_MS} ms, so this takes up to ${humanDuration(judged.length * THROTTLE_MS)}. ` +
        `--sample=N is the quick check; --local-only skips the network.`,
    );
  }

  const rows = [];
  let done = 0;
  for (const place of judged) {
    // Local layer: what the curated list and the stop names answer on their
    // own. This is the layer an edit to landmarks.ts moves.
    const localHits = geocode(network, place.name).slice(0, TOP_N);
    const localHit = localHits.find(
      (h) => distanceMeters(place, { lat: h.lat, lon: h.lon }) <= HIT_RADIUS_M,
    );
    // Full pipeline: exactly what /api/geocode returns, ranked and filtered the
    // same way, so "found" means found by a rider. Only asked when the local
    // layer already failed — a local hit is a strictly better outcome, and
    // every skipped call is 1.1 s of somebody else's rate limit unspent.
    let fullHit = null;
    if (!localHit && !OPT.localOnly) {
      const full = (await geocodeV1(network, place.name, external)).slice(0, TOP_N);
      fullHit =
        full.find(
          (h) =>
            distanceMeters(place, { lat: Number(h.lat), lon: Number(h.lon) }) <= HIT_RADIUS_M,
        ) ?? null;
    }
    // In --local-only there is no external answer to have been asked for, so
    // the third bucket is "not answered locally" and nothing stronger.
    const verdict = localHit ? "curated" : fullHit ? "uncurated" : "unfindable";
    rows.push({
      ...place,
      verdict,
      via: localHit?.label ?? fullHit?.display_name ?? null,
      rank: localHit ? localHits.indexOf(localHit) + 1 : null,
      top: localHits[0]?.label ?? null,
      // Set when we already have this exact OSM object under another label.
      curatedAs: curated.get(place.id) ?? null,
    });
    if (!OPT.localOnly && ++done % 25 === 0) log(`  … ${done}/${judged.length}`);
  }

  const of = (v) => rows.filter((r) => r.verdict === v);
  const byStop = (a, b) => a.stop.meters - b.stop.meters;
  const unfindable = of("unfindable").sort(byStop);
  const uncurated = of("uncurated").sort(byStop);
  const needAlias = rows.filter((r) => r.verdict !== "curated" && r.curatedAs !== null).sort(byStop);

  const summary = {
    bbox: BBOX,
    scoredAgainst: OPT.localOnly
      ? "local matcher only (--local-only: uncurated cannot be told from unfindable)"
      : "geocodeV1 — local + Photon/Nominatim, the rider's own pipeline",
    hitRadiusM: HIT_RADIUS_M,
    topN: TOP_N,
    maxWalkM: MAX_WALK_M,
    landmarks: LANDMARKS.length,
    stops: stops.length,
    osmPlaces: total,
    outOfReach: outOfReach.length,
    judged: judged.length,
    curated: of("curated").length,
    uncurated: uncurated.length,
    unfindable: unfindable.length,
    needAlias: needAlias.length,
  };

  if (OPT.json) {
    out(
      JSON.stringify(
        { summary, unfindable, needAlias, ...(OPT.all ? { uncurated, curated: of("curated") } : {}) },
        null,
        2,
      ),
    );
  } else {
    report(summary, unfindable, needAlias, uncurated);
  }

  if (OPT.maxUnfindable !== undefined && unfindable.length > OPT.maxUnfindable) {
    log(`FAIL: ${unfindable.length} unfindable > --max-unfindable=${OPT.maxUnfindable}`);
    return 1;
  }
  return 0;
}

const line = (r, note = "") =>
  `   ${String(r.stop.meters).padStart(5)} m  ${r.stop.name.padEnd(30)}  ` +
  `${r.name}${r.kind ? ` [${r.kind}]` : ""}  ${r.id}${note}`;

function report(s, unfindable, needAlias, uncurated) {
  const pct = (n) => (s.judged === 0 ? "0.0" : ((100 * n) / s.judged).toFixed(1));
  const n4 = (v) => String(v).padStart(4);
  out("");
  out(`  scored against   ${s.scoredAgainst}`);
  out(`  OSM places in ${s.bbox}   ${s.osmPlaces}`);
  out(`    beyond ${s.maxWalkM} m from any stop   ${s.outOfReach}   (no trip exists; not judged)`);
  out(`  judged   ${s.judged}`);
  out(`    curated   (local, rank ≤${s.topN})   ${n4(s.curated)}   ${pct(s.curated)}%`);
  if (OPT.localOnly) {
    // Deliberately NOT called unfindable. Most of these are answered by Photon
    // in production; calling them gaps is the error this harness was rebuilt
    // around, and a label is the only thing standing between the two readings.
    out(
      `    not answered locally        ${n4(s.unfindable)}   ${pct(s.unfindable)}%` +
        `   — UNCLASSIFIED: most are answered by Photon in production`,
    );
    out("");
    out("  Drop --local-only for the real unfindable list. Below is every place");
    out("  the curated list and stop names miss, external layer NOT consulted:");
  } else {
    out(
      `    uncurated (external only)   ${n4(s.uncurated)}   ${pct(s.uncurated)}%` +
        `   — findable; curating buys rank + latency, it is not a bug`,
    );
    out(
      `    UNFINDABLE                  ${n4(s.unfindable)}   ${pct(s.unfindable)}%` +
        `   — the defect; only a curated entry fixes it`,
    );
    out("");
    out("  UNFINDABLE — no layer answers these by name (nearest stop first):");
  }
  if (unfindable.length === 0) out("   (none)");
  for (const r of unfindable) out(line(r));
  out("");
  out(`  Already curated under another label — add an alias, not an entry (${needAlias.length}):`);
  if (needAlias.length === 0) out("   (none)");
  for (const r of needAlias) out(line(r, `  → have it as "${r.curatedAs}"`));
  if (OPT.all) {
    out("");
    out(`  Findable but uncurated (${uncurated.length}):`);
    for (const r of uncurated) out(line(r));
  }
  out("");
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`lookup-sweep: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
}
