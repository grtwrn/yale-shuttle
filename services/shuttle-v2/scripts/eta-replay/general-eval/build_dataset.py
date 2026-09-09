#!/usr/bin/env python3
"""Freeze source hashes, canonical episodes and independent physical-arrival labels.

This extractor is deliberately model-free. Reserved outcomes are written for the
sealed scorer, but stdout and the manifest contain only coverage/counts.
"""
from __future__ import annotations
import argparse, bisect, collections, datetime as dt, gzip, hashlib, json, math, pathlib, sqlite3
from inventory import ROOT, OUT, ET, day, sha, lines, archive_files

SPLITS = {"2026-09-03": "train", "2026-09-04": "validation", "2026-09-05": "reserved_confirmation",
          "2026-09-06": "reserved_confirmation", "2026-09-07": "reserved_partial", "2026-09-08": "regression"}
RADIUS = 50; RESET_RADIUS = 120; MAX_GAP = 30_000; AVAILABILITY_LAG = 120_000
POSITION_KEYS = ["bus_id", "bus_name", "route_id", "lat", "lon", "heading", "last_stop_id", "collected_at"]

def compact(obj): return json.dumps(obj, separators=(",", ":"), sort_keys=True)
def ident(*parts): return hashlib.sha256(compact(parts).encode()).hexdigest()[:24]

def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as f:
            for row in rows: f.write((compact(row) + "\n").encode())
    return {"path": str(path), "rows": len(rows), "sha256": sha(path), "bytes": path.stat().st_size}

def distance(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1; dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 12_742_000 * math.asin(min(1, math.sqrt(h)))

def physical_arrivals(positions, routes, stops):
    groups = collections.defaultdict(list)
    for p in positions: groups[p["bus_name"], p["route_id"]].append(p)
    out = []; ambiguous = 0; long_gaps = 0
    for (bus, rid), ps in groups.items():
        route = routes.get(rid)
        if not route: continue
        occurrences = collections.defaultdict(list)
        for i, sid in enumerate(route["stops"]):
            if sid in stops: occurrences[sid].append(i)
        clocks = collections.Counter(p["collected_at"] for p in ps)
        state = {}; prev_t = None; track_start = None
        for p in ps:
            t = p["collected_at"]
            if clocks[t] > 1:
                ambiguous += 1; state.clear(); prev_t = None; track_start = None; continue
            if prev_t is not None and t - prev_t > MAX_GAP:
                long_gaps += 1; state.clear(); track_start = None
            if track_start is None: track_start = t
            for sid, indices in occurrences.items():
                d = distance(p, stops[sid]); previous = state.get(sid)
                armed = previous[2] if previous else False
                if previous and armed and previous[0] > RADIUS and d <= RADIUS:
                    old_d, old_t, _ = previous
                    frac = (old_d - RADIUS) / (old_d - d)
                    at = round(old_t + frac * (t - old_t))
                    out.append({"id": ident("physical50", bus, rid, sid, at), "routeId": rid,
                                "routePatternId": route["patternId"], "busKey": bus, "day": day(at), "stopId": sid,
                                "stopIndices": indices, "arrivedAt": at, "knownAt": t, "lowerBoundAt": old_t,
                                "upperBoundAt": t, "gapMs": t - old_t, "radiusM": RADIUS,
                                "trackStartAt": track_start, "trackSegmentId": ident("track", bus, rid, track_start)})
                    armed = False
                if d >= RESET_RADIUS: armed = True
                state[sid] = (d, t, armed)
            prev_t = t
    out.sort(key=lambda x: (x["arrivedAt"], x["routeId"], x["busKey"], x["stopId"]))
    return out, {"ambiguousBusNameTimestampRowsExcluded": ambiguous, "trackGapsOver30s": long_gaps}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--out", type=pathlib.Path, default=OUT / "dataset")
    parser.add_argument("--topology-db", type=pathlib.Path, default=ROOT / "store/snap3-split.db")
    args = parser.parse_args(); out = args.out
    out.mkdir(parents=True, exist_ok=True)
    if (out / "manifest.json").exists():
        raise SystemExit("Refusing to replace a frozen dataset. Choose a new --out directory.")
    db = sqlite3.connect(f"file:{args.topology_db}?mode=ro&immutable=1", uri=True); db.row_factory = sqlite3.Row
    routes = {}; stops = {r["id"]: dict(r) for r in db.execute("SELECT * FROM stops")}
    for r in db.execute("SELECT * FROM routes"):
        seq = json.loads(r["stops_json"]); pattern = f'{r["id"]}:{ident(seq)}'
        routes[r["id"]] = {"id": r["id"], "name": r["name"], "stops": seq, "path": json.loads(r["path_json"]) if r["path_json"] else None,
                           "patternId": pattern, "updatedAt": r["updated_at"]}
    db.close()
    topology = {"source": str(args.topology_db), "sha256": sha(args.topology_db), "routes": list(routes.values()), "stops": list(stops.values()),
                "caveat": "Geometry is the earliest local September3 snapshot, not an authenticated historical topology feed. No future fitted travel tables are copied."}
    (out / "topology.json").write_text(json.dumps(topology, indent=2) + "\n")
    sources = []; raw = {}; visits = {}; source_conflicts = collections.Counter(); auxiliary = collections.defaultdict(list)
    for path in archive_files():
        table = path.name.removesuffix(".jsonl.gz")
        manifest = json.loads((path.parent / "manifest.json").read_text())
        digest = sha(path); expected = manifest.get("tables", {}).get(table, {}).get("sha256")
        if expected and digest != expected: raise ValueError(f"Archive hash mismatch: {path}")
        observed = round(dt.datetime.fromisoformat(manifest["generatedAt"].replace("Z", "+00:00")).timestamp() * 1000)
        source = {"path": str(path), "sha256": digest, "manifestSha256": sha(path.parent / "manifest.json"), "table": table, "day": manifest["day"], "observedBy": observed,
                  "transportComplete": manifest["tables"][table].get("complete", False), "build": manifest.get("build")}
        sources.append(source)
        for r in lines(path):
            if table == "raw_positions":
                k = (r["bus_id"], r["collected_at"]); p = {key: r.get(key) for key in POSITION_KEYS}
                if k in raw and raw[k] != p: source_conflicts["positions"] += 1
                raw[k] = p
            elif table == "stop_visits":
                k = (r["route_id"], r["bus_name"], r["stop_index"], r["anchored_at"])
                if k in visits and visits[k][0] != r: source_conflicts["visits"] += 1
                if k not in visits or observed > visits[k][1]: visits[k] = (r, observed)
            elif table in ("legs", "arrivals", "predictions_log", "upstream_etas"):
                auxiliary[manifest["day"], table].append(r)
    scratch = pathlib.Path("/tmp/claude-1000/-home-gwarren-yale-shuttle/f257f79c-ae61-4a88-8421-ba9846255709/scratchpad") / "raw_positions_today.jsonl"
    if scratch.exists():
        sources.append({"path": str(scratch), "sha256": sha(scratch), "table": "raw_positions", "day": "2026-09-08", "source": "morning_capture"})
        for r in lines(scratch):
            k = (r["bus_id"], r["collected_at"]); p = {key: r.get(key) for key in POSITION_KEYS}
            if k in raw and raw[k] != p: source_conflicts["positions"] += 1
            raw.setdefault(k, p)
    positions = sorted(raw.values(), key=lambda p: (p["collected_at"], p["bus_id"]))
    arrivals, crossing_notes = physical_arrivals(positions, routes, stops)
    crossing_index = collections.defaultdict(list)
    for a in arrivals: crossing_index[a["busKey"], a["routeId"], a["stopId"]].append(a)
    episode_groups = collections.defaultdict(list)
    for r, observed in visits.values(): episode_groups[r["bus_name"], r["route_id"]].append((r, observed))
    # A day with repaired in-memory sequence indices is not the raw DB pattern.
    # Even a matching prefix cannot establish which pattern was active. Keep the
    # entire disputed day/route unresolved until a build-specific mapping exists.
    disputed_patterns = set()
    for r, _ in visits.values():
        route = routes.get(r["route_id"]); index = r["stop_index"]
        if not route or not 0 <= index < len(route["stops"]) or route["stops"][index] != r["stop_id"]:
            disputed_patterns.add((day(r["anchored_at"]), r["route_id"]))
    episodes = []; mismatches = collections.Counter()
    for (bus, rid), rows in episode_groups.items():
        rows.sort(key=lambda pair: (pair[0]["anchored_at"], pair[0]["id"]))
        for i, (r, observed) in enumerate(rows):
            route = routes.get(rid); index = r["stop_index"]; d = day(r["anchored_at"])
            resolved = bool(route and 0 <= index < len(route["stops"]) and route["stops"][index] == r["stop_id"]
                            and (d, rid) not in disputed_patterns)
            if not resolved: mismatches[str(rid)] += 1
            physical_end = max([x for x in (r.get("departed_at"), r.get("arrived_at"), r.get("pinned_at"), r["anchored_at"]) if x is not None])
            # Two later anchors and a fixed confirmation margin, conservatively beyond
            # the next visit's likely write. This is an explicit proxy, not invented exact insertion time.
            proxy = rows[i + 2][0]["anchored_at"] + AVAILABILITY_LAG if i + 2 < len(rows) else None
            choices = [(observed, "archive_observed_by")] if observed >= physical_end else []
            if proxy is not None and proxy >= physical_end: choices.append((proxy, "two_subsequent_anchors_plus_120s"))
            known, kind = min(choices) if choices else (None, "unresolved")
            next_index = (index + 1) % len(route["stops"]) if resolved else None
            next_sid = route["stops"][next_index] if next_index is not None else None
            target = None; censor = "no_departure" if r.get("departed_at") is None else "no_geometry" if not resolved else "no_observed_crossing"
            if r.get("departed_at") is not None and resolved:
                candidates = crossing_index.get((bus, rid, next_sid), [])
                times = [a["arrivedAt"] for a in candidates]
                k = bisect.bisect_left(times, r["departed_at"])
                # Never use a subsequent lap if the next recorded same-stop visit already began.
                horizon = r["departed_at"] + 1_800_000
                for later, _ in rows[i + 1:]:
                    if later["stop_index"] == index:
                        horizon = min(horizon, later["anchored_at"]); break
                if k < len(candidates) and candidates[k]["arrivedAt"] <= horizon and candidates[k]["trackStartAt"] <= r["departed_at"]:
                    target = candidates[k]; censor = "observed"
            episodes.append({"id": ident("visit", rid, bus, index, r["anchored_at"]), "routeId": rid,
                "routePatternId": route["patternId"] if resolved else f"{rid}:unresolved", "stopId": r["stop_id"], "stopIndex": index,
                "busKey": bus, "busId": r["bus_id"], "day": d, "split": SPLITS.get(d, "unassigned"), "patternResolved": resolved,
                "anchoredAt": r["anchored_at"], "pinnedAt": r.get("pinned_at"), "arrivedAt": r.get("arrived_at"),
                "departedAt": r.get("departed_at"), "outcome": r["outcome"], "knownAt": known, "availabilityKind": kind, "observedBy": observed,
                "nextStopId": next_sid, "nextStopIndex": next_index, "nextPhysicalArrivalAt": target["arrivedAt"] if target else None,
                "nextPhysicalArrivalKnownAt": target["knownAt"] if target else None, "nextPhysicalArrivalId": target["id"] if target else None,
                "targetCensoring": censor, "sourceVisitId": r["id"]})
    episodes.sort(key=lambda e: (e["anchoredAt"], e["routeId"], e["busKey"], e["stopIndex"]))
    artifacts = []; coverage = {}
    for d, split in SPLITS.items():
        ps = [p for p in positions if day(p["collected_at"]) == d]; es = [e for e in episodes if e["day"] == d]; ars = [a for a in arrivals if a["day"] == d]
        counts = collections.defaultdict(lambda: {"positions": 0, "episodes": 0, "physicalArrivals": 0})
        for p in ps: counts[str(p["route_id"])]["positions"] += 1
        for e in es: counts[str(e["routeId"])]["episodes"] += 1
        for a in ars: counts[str(a["routeId"])]["physicalArrivals"] += 1
        coverage[d] = {"split": split, "routes": dict(counts), "minPositionAt": ps[0]["collected_at"] if ps else None,
                       "maxPositionAt": ps[-1]["collected_at"] if ps else None, "targetCensoringCounts": dict(collections.Counter(e["targetCensoring"] for e in es))}
        for name, rs in [("positions", ps), ("episodes", es), ("physical-arrivals", ars)]:
            a = write_jsonl(out / d / f"{name}.jsonl.gz", rs); a.update(day=d, split=split, table=name); artifacts.append(a)
        for (ad, table), rs in auxiliary.items():
            if ad == d:
                a = write_jsonl(out / d / f"source-{table}.jsonl.gz", rs); a.update(day=d, split=split, table=table); artifacts.append(a)
    metadata = {"schemaVersion": 1, "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "sources": sources,
                "sourceConflicts": dict(source_conflicts), "topology": {"path": str(out / "topology.json"), "sha256": sha(out / "topology.json")},
                "splits": SPLITS, "coverage": coverage, "artifacts": artifacts, "routeOccurrenceMismatches": dict(mismatches),
                "unresolvedPatternGroups": [{"day": d, "routeId": rid} for d, rid in sorted(disputed_patterns)],
                "physicalLabelPolicy": {"arrivalRadiusM": RADIUS, "rearmRadiusM": RESET_RADIUS, "maxObservationGapMs": MAX_GAP,
                    "interpolation": "linear distance crossing; retain endpoint interval", "ambiguousRepeatedStops": "retain all indices; prediction must identify occurrence",
                    "initiallyInside": "left-censored; never invent arrival at capture start",
                    "sameContinuousTrack": "require issuedAt>=target.trackStartAt, so an earlier arrival cannot hide in a capture gap", **crossing_notes},
                "availabilityPolicy": {"exactHistoricalInsertionTimesRecorded": False, "proxy": "two subsequent same-bus same-route anchors +120s; capped by actual archive observedBy",
                    "fitRule": "label knownAt<=fit cutoff and physical end<=fit cutoff; use frozen prior-day fits for confirmation",
                    "positionsKnownAt": "collected_at", "physicalArrivalsKnownAt": "second crossing observation collected_at"},
                "splitPolicy": {"selectionAllowed": ["2026-09-03", "2026-09-04"], "alreadyInspectedRegression": ["2026-09-08"],
                    "reservedScoringRequiresFrozenCandidateHash": True, "globalUntouchedClaim": False,
                    "reason": "Sep3/4/8 already influenced project choices; Sep5/6/7 were used by historical reestimation but are reserved from current model selection.",
                    "prospectiveDay": "2026-09-09", "prospectiveFreezeBefore": "first scored observation; never tune after inspecting prospective labels"},
                "limitations": ["No observed service after Sep7 00:17 in that archive; do not treat it as a complete holiday/daytime test.",
                    "Sep3 capture starts late morning; left-censored tracks are retained as inputs but their initial arrivals are not labels.",
                    "Sep8 raw capture has a noon gap and ends early evening; it is regression evidence only.",
                    "Inferred stop-visit label availability is conservative but not exact; use raw replay emission times for strict online feature claims.",
                    "Current stop visit outcome, departure, later anchors and next arrival are labels, never current-visit features."]}
    (out / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"manifest": str(out / "manifest.json"), "sha256": sha(out / "manifest.json"), "positions": len(positions), "episodes": len(episodes),
                      "physicalArrivals": len(arrivals), "artifacts": len(artifacts), "routeOccurrenceMismatches": dict(mismatches)}))

if __name__ == "__main__": main()
