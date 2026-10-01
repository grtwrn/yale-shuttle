#!/usr/bin/env python3
"""Dedicated Red rider extractor: what the app showed a rider waiting at Division /
Prospect, and when the bus actually came.

  python rider_extract.py [--src DIR] [--out DIR]

Input (read-only): the dedicated Red rider's artifacts (journeys.jsonl, events.jsonl,
samples.jsonl; default the watcher checkout's scripts/.rider-watcher-red). Output:
  <out>/rider-journeys.jsonl          one row per journey (boarding truth, bus, wait)
  <out>/rider-waiting-samples.jsonl   one row per 10-s waiting sample: the displayed
                                      "Board in" window, followed bus, Winchester hold
                                      display, and how the window compared with boarding
  <out>/rider-summary.json            coverage, early/late misses, error, overall and
                                      while the followed bus was held at 344 Winchester
Rows are merged by key into the existing output files, so history survives rotation of
the rider's own files. Boarding truth is the rider's boarded event (GPS within the
board radius of Division / Prospect); when the archive day exists, the production
arrivals row of that bus at stop 48 is joined as a second truth.
"""
import argparse, datetime, gzip, hashlib, json, os, re, sys
from zoneinfo import ZoneInfo

DEFAULT_SRC = "/Users/grtwrn/projects/yale-shuttle-watcher/services/shuttle-v2/scripts/.rider-watcher-red"
DEFAULT_OUT = "/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments/rider"
ARCHIVE = os.environ.get("RED_EXP_ARCHIVE", "/Users/grtwrn/shuttle-archive")
DIV, WIN = 48, 11
TOL_S = 30  # the card shows whole minutes; half a minute of rounding either side

BOARD_RE = re.compile(r"Board in \(min\)\tArrive at\n[^\n]*\t\n([^\n]+)\n\t([^\n]*)")
FOLLOW_RE = re.compile(r"🚌 (#\d+) · (\d+) stops? away")
STAND_RE = re.compile(r"Stopped (\d+):(\d\d) · usual ~(\d+)m total")
NOW_STOP_RE = re.compile(r"🚌([^\n⏸]+?)⏸ ?(\d+):(\d\d)")


def ms(iso):
    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def minutes(tok):
    tok = tok.strip().lstrip("~")
    if tok.startswith("<"):
        return 0.0
    try:
        return float(tok)
    except ValueError:
        return None


def parse_board(cell):
    """'~2 (<1 – 5)' -> (2, 0, 5); '<1 (<1 – 1)' -> (0, 0, 1); 'At stop' -> (0, 0, 0)."""
    c = cell.strip()
    if c.lower().startswith("at stop") or c.lower().startswith("now"):
        return 0.0, 0.0, 0.0
    m = re.match(r"(\S+)\s*\(([^–-]+)[–-]([^)]+)\)", c)
    if m:
        return minutes(m.group(1)), minutes(m.group(2)), minutes(m.group(3))
    p = minutes(c.split()[0]) if c else None
    return p, p, p


def text_of(sample):
    t = sample.get("text") or ""
    if t.startswith('"'):
        try:
            t = json.loads(t)
        except ValueError:
            pass
    return t


def buses_of(sample):
    b = sample.get("buses")
    if isinstance(b, str):
        try:
            b = json.loads(b)
        except ValueError:
            b = None
    return b or []


def read_jsonl(path, want=None):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if want and want not in line:
                continue
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def archive_arrival(bus, near_ms):
    """Production arrivals row of this bus at Division within 5 min before / 2 min after
    the rider's boarding, if that day is archived (selected manifest, SHA-256 checked)."""
    day = datetime.datetime.fromtimestamp(near_ms / 1000, ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    mpath = os.path.join(ARCHIVE, day, "manifest.json")
    if not os.path.exists(mpath):
        return None
    t = json.load(open(mpath))["tables"].get("arrivals")
    if not t or not t.get("complete"):
        return None
    raw = open(os.path.join(ARCHIVE, day, t["file"]), "rb").read()
    if t.get("sha256") and hashlib.sha256(raw).hexdigest() != t["sha256"]:
        return None
    best = None
    for line in gzip.decompress(raw).decode().splitlines():
        if f'"{bus}"' not in line:
            continue
        r = json.loads(line)
        if r["route_id"] == 3 and r["stop_id"] == DIV and r["bus_name"] == bus:
            if near_ms - 300_000 <= r["arrived_at"] <= near_ms + 120_000:
                if best is None or abs(r["arrived_at"] - near_ms) < abs(best - near_ms):
                    best = r["arrived_at"]
    return best


def merge(path, rows, key):
    old = {key(r): r for r in read_jsonl(path)}
    for r in rows:
        old[key(r)] = r
    out = sorted(old.values(), key=key)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return out


def run(src, out):
    os.makedirs(out, exist_ok=True)
    journeys = {j["id"]: j for j in read_jsonl(os.path.join(src, "journeys.jsonl"))}
    events = read_jsonl(os.path.join(src, "events.jsonl"))
    boarded = {}
    for e in events:
        if e.get("kind") == "boarded":
            d = e.get("detail") or {}
            boarded[e["runId"]] = {"at": ms(e["at"]), "bus": d.get("bus"), "distance_m": d.get("observedDistanceM")}
    finished = {e["runId"]: e.get("detail") for e in events if e.get("kind") == "journey-finished"}
    started = {e["runId"]: ms(e["at"]) for e in events if e.get("kind") == "journey-started"}

    jrows = []
    for rid in sorted(set(started) | set(journeys)):
        j = journeys.get(rid, {})
        b = boarded.get(rid)
        if b is None and j.get("boardedAt"):
            b = {"at": ms(j["boardedAt"]), "bus": j.get("busName"), "distance_m": j.get("lastBoardDistanceM")}
        st = started.get(rid) or (ms(j["startedAt"]) if j.get("startedAt") else None)
        row = {"run": rid, "started_at": st, "boarded_at": b and b["at"], "bus": b and b["bus"],
               "board_distance_m": b and b["distance_m"], "result": j.get("result") or finished.get(rid),
               "board_stop": j.get("boardStopId"), "exit_stop": j.get("exitStopId")}
        if b and b["bus"]:
            row["archive_arrival_48"] = archive_arrival(b["bus"], b["at"])
        jrows.append(row)
    jall = merge(os.path.join(out, "rider-journeys.jsonl"), jrows, key=lambda r: r["run"])
    jby = {r["run"]: r for r in jall}

    srows = []
    for s in read_jsonl(os.path.join(src, "samples.jsonl"), want='"waiting"'):
        if s.get("phase") != "waiting":
            continue
        t = text_of(s)
        at = ms(s["at"])
        row = {"run": s["runId"], "at": at, "feed_age_ms": s.get("feedAgeMs")}
        m = BOARD_RE.search(t)
        if m:
            row["board_text"], row["arrive_text"] = m.group(1).strip(), m.group(2).strip()
            row["point_min"], row["lo_min"], row["hi_min"] = parse_board(m.group(1))
        f = FOLLOW_RE.search(t)
        if f:
            row["followed"], row["stops_away"] = f.group(1), int(f.group(2))
        sd = STAND_RE.search(t)
        if sd:
            row["stand_display_s"] = int(sd.group(1)) * 60 + int(sd.group(2))
            row["stand_usual_min"] = int(sd.group(3))
        ns = NOW_STOP_RE.search(t)
        if ns:
            row["bus_stop_text"] = ns.group(1).strip()
            row["bus_stop_timer_s"] = int(ns.group(2)) * 60 + int(ns.group(3))
        fb = next((b for b in buses_of(s) if b.get("bus_name") == row.get("followed")), None)
        if fb:
            row["followed_at_stop"] = fb.get("at_stop_id")
            row["followed_stationary"] = fb.get("stationary")
        row["held_at_winchester"] = bool(
            (fb and fb.get("at_stop_id") == WIN and fb.get("stationary"))
            or ("Winchester" in (row.get("bus_stop_text") or "") and "Division" not in (row.get("bus_stop_text") or "")))
        j = jby.get(s["runId"])
        if j and j.get("boarded_at") and row.get("hi_min") is not None and j.get("bus") == row.get("followed"):
            actual = (j["boarded_at"] - at) / 1000
            row["actual_s"] = actual
            row["early"] = actual < row["lo_min"] * 60 - TOL_S
            row["late"] = actual > row["hi_min"] * 60 + TOL_S
            row["in_window"] = not (row["early"] or row["late"])
            row["point_error_s"] = actual - (row["point_min"] or 0) * 60
        srows.append(row)
    sall = merge(os.path.join(out, "rider-waiting-samples.jsonl"), srows, key=lambda r: (r["run"], r["at"]))

    def agg(rows):
        sc = [r for r in rows if "actual_s" in r]
        if not sc:
            return {"samples": len(rows), "scored": 0}
        errs = sorted(abs(r["point_error_s"]) for r in sc)
        return {"samples": len(rows), "scored": len(sc), "journeys": len({r["run"] for r in sc}),
                "in_window": round(sum(r["in_window"] for r in sc) / len(sc), 3),
                "early": round(sum(r["early"] for r in sc) / len(sc), 3),
                "late": round(sum(r["late"] for r in sc) / len(sc), 3),
                "median_abs_point_error_s": errs[len(errs) // 2],
                "mean_window_width_min": round(sum(r["hi_min"] - r["lo_min"] for r in sc) / len(sc), 2)}

    summary = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "src": src, "journeys": len(jall), "boarded": sum(1 for r in jall if r.get("boarded_at")),
        "with_archive_truth": sum(1 for r in jall if r.get("archive_arrival_48")),
        "all_waiting": agg(sall),
        "while_held_at_winchester": agg([r for r in sall if r.get("held_at_winchester")]),
        "not_held": agg([r for r in sall if not r.get("held_at_winchester")]),
        "note": "Samples are 10 s apart within a journey and strongly correlated; journeys are the independent unit. "
                "Truth is the rider's boarded event (GPS within the board radius), not a door event.",
    }
    with open(os.path.join(out, "rider-summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps({k: summary[k] for k in ("journeys", "boarded", "all_waiting", "while_held_at_winchester")}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.environ.get("RED_RIDER_SRC", DEFAULT_SRC))
    ap.add_argument("--out", default=os.environ.get("RED_RIDER_OUT", DEFAULT_OUT))
    a = ap.parse_args()
    if not os.path.isdir(a.src):
        sys.exit(f"rider source not found: {a.src}")
    run(a.src, a.out)
