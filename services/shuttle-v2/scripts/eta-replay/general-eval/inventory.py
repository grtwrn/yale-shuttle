#!/usr/bin/env python3
"""Inventory only: counts, time bounds, schemas and hashes; never label-value summaries."""
from __future__ import annotations
import argparse, collections, datetime as dt, gzip, hashlib, json, os, pathlib, sqlite3
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "scripts/.eta-replay/overnight-2026-09-08"
ET = ZoneInfo("America/New_York")
TABLE_CLOCKS = {"raw_positions": "collected_at", "stop_visits": "anchored_at", "legs": "departed_at",
                "arrivals": "arrived_at", "segments": "started_at", "predictions_log": "predicted_at",
                "upstream_etas": "sampled_at"}

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""): h.update(part)
    return h.hexdigest()

def day(ms):
    return dt.datetime.fromtimestamp(ms / 1000, ET).date().isoformat()

def lines(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            if line.strip(): yield json.loads(line)

def describe_rows(rows, clock):
    n = 0; lo = hi = None; days = collections.Counter(); routes = collections.Counter(); columns = set()
    for r in rows:
        n += 1; columns.update(r)
        t = r.get(clock)
        if not isinstance(t, (int, float)):
            for fallback in ("issued_at", "predicted_at", "collected_at", "sampled_at", "at"):
                if isinstance(r.get(fallback), (int, float)): t = r[fallback]; break
        if isinstance(t, (int, float)):
            lo = t if lo is None else min(lo, t); hi = t if hi is None else max(hi, t); days[day(t)] += 1
        if r.get("route_id") is not None: routes[str(r["route_id"])] += 1
    return {"rows": n, "minAt": lo, "maxAt": hi, "days": dict(sorted(days.items())),
            "routes": dict(sorted(routes.items())), "columns": sorted(columns)}

def archive_files():
    roots = [pathlib.Path("/home/gwarren/shuttle-archive"), ROOT / "scripts/.eta-replay/red-today-archive"]
    for root in roots:
        if root.exists():
            yield from sorted(root.glob("????-??-??/*.jsonl.gz"))

def main():
    p = argparse.ArgumentParser(); p.add_argument("--out", type=pathlib.Path, default=OUT / "inventory.json")
    p.add_argument("--skip-databases", action="store_true"); args = p.parse_args()
    files = []; archive_roots = set()
    for path in archive_files():
        table = path.name.removesuffix(".jsonl.gz"); archive_roots.add(path.parent)
        item = {"path": str(path), "kind": "archive", "table": table, "bytes": path.stat().st_size, "sha256": sha(path)}
        item.update(describe_rows(lines(path), TABLE_CLOCKS.get(table, "scored_at")))
        manifest = json.loads((path.parent / "manifest.json").read_text()); m = manifest.get("tables", {}).get(table, {})
        item["archive"] = {"day": manifest["day"], "generatedAt": manifest["generatedAt"], "build": manifest.get("build"),
                           "transportComplete": m.get("complete"), "expectedHashMatches": m.get("sha256") == item["sha256"]}
        files.append(item)
    captures = sorted(pathlib.Path("/home/gwarren/shuttle-captures").glob("*.jsonl"))
    scratch = pathlib.Path("/tmp/claude-1000/-home-gwarren-yale-shuttle/f257f79c-ae61-4a88-8421-ba9846255709/scratchpad")
    captures += [scratch / "raw_positions_today.jsonl"] if (scratch / "raw_positions_today.jsonl").exists() else []
    for path in captures:
        item = {"path": str(path), "kind": "capture", "bytes": path.stat().st_size, "sha256": sha(path)}
        try: item.update(describe_rows(lines(path), "collected_at"))
        except (ValueError, TypeError) as e: item["parseError"] = str(e)
        files.append(item)
    databases = []
    if not args.skip_databases:
        paths = list((ROOT / "store").glob("*.db"))
        for branch in pathlib.Path("/home/gwarren/yale-shuttle-wt").iterdir():
            service = branch / "services/shuttle-v2"
            paths += list((service / "store").glob("*.db"))
            paths += list((service / "scripts/.reestimate").glob("*.db"))
            paths += list((service / "scripts/.eta-replay").glob("*/*.db"))
        seen = {}
        for path in sorted(paths):
            digest = sha(path); wal = pathlib.Path(str(path) + "-wal")
            item = {"path": str(path), "bytes": path.stat().st_size, "sha256": digest,
                    "walBytes": wal.stat().st_size if wal.exists() else 0}
            if item["walBytes"]: item["walSha256"] = sha(wal); item["canonicalEligible"] = False
            if digest in seen: item["duplicateOf"] = seen[digest]
            else:
                seen[digest] = str(path)
                db = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
                names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}; item["tables"] = {}
                for table, clock in TABLE_CLOCKS.items():
                    if table not in names: continue
                    cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
                    if clock not in cols: clock = next((c for c in ("issued_at", "predicted_at", "at") if c in cols), None)
                    stats = {"columns": cols, "rows": db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]}
                    if clock:
                        stats["minAt"], stats["maxAt"] = db.execute(f"SELECT MIN({clock}),MAX({clock}) FROM {table}").fetchone()
                    item["tables"][table] = stats
                db.close()
            databases.append(item)
    report = {"schemaVersion": 1, "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "notes": ["Inventory contains no outcome-duration or model-score summaries.",
                        "Transport completeness means a response ended correctly, not complete service coverage.",
                        "SQLite hashes with nonempty WAL are not frozen database snapshots.",
                        "Shared old v1 arrival/segment history extends before split-visit recording; definitions differ."],
              "files": files, "databases": databases}
    args.out.parent.mkdir(parents=True, exist_ok=True); args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"out": str(args.out), "files": len(files), "databases": len(databases),
                      "uniqueDatabases": len([d for d in databases if "duplicateOf" not in d])}))

if __name__ == "__main__": main()
