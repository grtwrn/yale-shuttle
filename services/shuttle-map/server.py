#!/usr/bin/env python3
"""
Yale Shuttle Map — Live web server.

Serves the transit map HTML and a JSON API for live bus positions.
The frontend is a single self-contained HTML file with inline SVG + CSS + JS.

Usage:
    shuttle-map              # start server + open browser
    shuttle-map --once       # just print the URL
"""

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

DB_PATH = os.environ.get(
    "SHUTTLE_DB",
    str(Path(__file__).resolve().parent.parent.parent / "store" / "shuttle.db"),
)
HTML_PATH = Path(__file__).resolve().parent / "index.html"
STATIC_DIR = Path(os.environ.get(
    "SHUTTLE_STATIC_DIR",
    str(Path(__file__).resolve().parent / "app" / "dist"),
))
PORT = int(os.environ.get("PORT", "8091"))


def get_bus_data():
    """Return live bus positions + route stop sequences."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return {"buses": [], "routes": {}}
    db.row_factory = sqlite3.Row
    try:
        # Get latest position for each bus, plus the position from ~3 minutes ago
        # to compute whether the bus is stationary (hasn't moved)
        rows = db.execute("""
            WITH latest AS (
                SELECT bus_id, bus_name, route_id, lat, lon, heading, last_stop_id,
                       ROW_NUMBER() OVER (PARTITION BY bus_id ORDER BY collected_at DESC) as rn
                FROM bus_positions WHERE collected_at > datetime('now', '-2 minutes')
            ),
            older AS (
                SELECT bus_id, lat as old_lat, lon as old_lon, collected_at as old_at,
                       ROW_NUMBER() OVER (PARTITION BY bus_id ORDER BY collected_at ASC) as rn
                FROM bus_positions WHERE collected_at > datetime('now', '-5 minutes')
                    AND collected_at < datetime('now', '-2 minutes')
            )
            SELECT l.bus_id, l.bus_name, l.route_id, l.lat, l.lon, l.heading, l.last_stop_id,
                   o.old_lat, o.old_lon
            FROM latest l
            LEFT JOIN older o ON o.bus_id = l.bus_id AND o.rn = 1
            WHERE l.rn = 1
        """).fetchall()

        buses = []
        for r in rows:
            bus = {k: r[k] for k in ["bus_id", "bus_name", "route_id", "lat", "lon", "heading", "last_stop_id"]}
            # Compute stationary flag: moved < ~30m in the last 3 minutes
            if r["old_lat"] is not None and r["old_lon"] is not None:
                dlat = (r["lat"] - r["old_lat"]) * 111000  # meters
                dlon = (r["lon"] - r["old_lon"]) * 111000 * 0.75  # roughly, at lat 41°
                dist = (dlat * dlat + dlon * dlon) ** 0.5
                bus["stationary"] = dist < 30
            else:
                bus["stationary"] = False
            buses.append(bus)

        # When did each bus last arrive at its current GPS-nearest stop?
        # Join onto latest gps_arrivals per bus so the client can render dwell countdowns.
        arr_rows = db.execute("""
            SELECT bus_id, stop_id, arrived_at
            FROM (
                SELECT bus_id, stop_id, arrived_at,
                       ROW_NUMBER() OVER (PARTITION BY bus_id ORDER BY arrived_at DESC) as rn
                FROM gps_arrivals
                WHERE arrived_at > datetime('now', '-2 hours')
            ) WHERE rn = 1
        """).fetchall()
        at_stop = {r["bus_id"]: {"at_stop_id": r["stop_id"], "at_stop_since": r["arrived_at"]} for r in arr_rows}
        for b in buses:
            state = at_stop.get(b["bus_id"])
            if state:
                b["at_stop_id"] = state["at_stop_id"]
                b["at_stop_since"] = state["at_stop_since"]

        # Get route stop sequences so frontend can compute next stop
        route_rows = db.execute(
            "SELECT id, stops_json FROM routes WHERE stops_json IS NOT NULL"
        ).fetchall()
        routes = {}
        for r in route_rows:
            stops = json.loads(r["stops_json"]) if r["stops_json"] else []
            routes[str(r["id"])] = stops

        # Get stop names for display
        stop_rows = db.execute("SELECT id, name, lat, lon FROM stops").fetchall()
        stop_names = {r["id"]: r["name"] for r in stop_rows}
        stop_coords = {r["id"]: {"lat": r["lat"], "lon": r["lon"]} for r in stop_rows}
    except Exception:
        buses, routes, stop_names, stop_coords = [], {}, {}, {}
    db.close()
    segments = get_segment_times()
    dwells = get_dwell_times()
    peaks = get_route_peaks()
    return {"buses": buses, "routes": routes, "stop_names": stop_names, "stop_coords": stop_coords, "segments": segments, "dwells": dwells, "route_peaks": peaks}


def get_route_peaks() -> dict:
    """Max concurrent bus count ever observed per route (persisted across
    bus_positions retention trims)."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return {}
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("SELECT route_id, peak_concurrent FROM route_peaks").fetchall()
    except Exception:
        rows = []
    db.close()
    return {str(r["route_id"]): r["peak_concurrent"] for r in rows}


def get_segment_times():
    """Return calibrated segment times for all routes."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return {}
    db.row_factory = sqlite3.Row
    try:
        day_of_week = time.localtime().tm_wday
        # Sunday=6 in Python, but SQLite stores as 0=Sun. Python: Mon=0..Sun=6. SQLite: Sun=0..Sat=6.
        # Convert: Python Mon=0 → SQLite 1, ... Python Sun=6 → SQLite 0
        sqlite_dow = (day_of_week + 1) % 7

        # Try day-specific first, fall back to all-days average
        rows = db.execute("""
            SELECT cs.route_id, cs.from_stop_id, cs.to_stop_id,
                   cs.avg_seconds, cs.stddev_seconds, cs.sample_count
            FROM calibrated_segments cs
            WHERE cs.day_of_week = ?
            UNION ALL
            SELECT sa.route_id, sa.from_stop_id, sa.to_stop_id,
                   sa.avg_seconds, sa.stddev_seconds, sa.sample_count
            FROM segment_averages sa
            WHERE NOT EXISTS (
                SELECT 1 FROM calibrated_segments cs2
                WHERE cs2.route_id = sa.route_id
                  AND cs2.from_stop_id = sa.from_stop_id
                  AND cs2.to_stop_id = sa.to_stop_id
                  AND cs2.day_of_week = ?
            )
        """, (sqlite_dow, sqlite_dow)).fetchall()
    except Exception:
        rows = []
    db.close()

    # Group by route_id
    result: dict = {}
    for r in rows:
        rid = str(r["route_id"])
        if rid not in result:
            result[rid] = {}
        key = f"{r['from_stop_id']}-{r['to_stop_id']}"
        result[rid][key] = {
            "avg": round(r["avg_seconds"], 1),
            "sd": round(r["stddev_seconds"] or 0, 1),
            "n": r["sample_count"],
        }
    return result


def get_dwell_times():
    """Return calibrated per-stop dwell times for all routes."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return {}
    db.row_factory = sqlite3.Row
    try:
        day_of_week = time.localtime().tm_wday
        sqlite_dow = (day_of_week + 1) % 7
        rows = db.execute("""
            SELECT cd.route_id, cd.stop_id,
                   cd.median_dwell_seconds, cd.stddev_dwell_seconds, cd.sample_count
            FROM calibrated_dwells cd
            WHERE cd.day_of_week = ?
            UNION ALL
            SELECT da.route_id, da.stop_id,
                   da.median_dwell_seconds, da.stddev_dwell_seconds, da.sample_count
            FROM dwell_averages da
            WHERE NOT EXISTS (
                SELECT 1 FROM calibrated_dwells cd2
                WHERE cd2.route_id = da.route_id
                  AND cd2.stop_id = da.stop_id
                  AND cd2.day_of_week = ?
            )
        """, (sqlite_dow, sqlite_dow)).fetchall()
    except Exception:
        rows = []
    db.close()

    result: dict = {}
    for r in rows:
        rid = str(r["route_id"])
        if rid not in result:
            result[rid] = {}
        result[rid][str(r["stop_id"])] = {
            "med": round(r["median_dwell_seconds"], 1),
            "sd": round(r["stddev_dwell_seconds"] or 0, 1),
            "n": r["sample_count"],
        }
    return result


# Industry-standard accuracy buckets (TransitApp / IBI Group methodology).
# Each prediction is bucketed by how long before the actual arrival it was made.
# Asymmetric thresholds: early is penalized more than late because early departures
# cause riders to miss the bus, while late ones only extend the wait.
#
# (bucket_label, min_horizon_sec, max_horizon_sec, early_tol_sec, late_tol_sec)
ACCURACY_BUCKETS = [
    ("0-3m",   0,        3 * 60,   30,   1.5 * 60),
    ("3-6m",   3 * 60,   6 * 60,   60,   2.5 * 60),
    ("6-10m",  6 * 60,   10 * 60,  60,   3.5 * 60),
    ("10-15m", 10 * 60,  15 * 60,  90,   4.5 * 60),
]


def _bucket_for_horizon(horizon_sec):
    for label, lo, hi, e, l in ACCURACY_BUCKETS:
        if lo <= horizon_sec < hi:
            return label, e, l
    return None, 0, 0


def get_accuracy_stats():
    """Compute ETA prediction accuracy bucketed by horizon.

    For every (prediction, arrival) pair within a 15-minute horizon and the last
    14 days, classify the prediction into a time-to-arrival bucket (0-3m, 3-6m,
    6-10m, 10-15m) and count it as "in range" using asymmetric early/late
    thresholds. The headline accuracy is an equally-weighted average of the four
    bucket accuracies — so close-in and far-out predictions contribute equally
    regardless of how many samples each bucket has.
    """
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception:
        return {"buckets": [], "stops": [], "overall": None}
    db.row_factory = sqlite3.Row
    try:
        # Every prediction that preceded an arrival within the last 14 days, up
        # to 15 minutes ahead. Crucially, each prediction only matches the NEXT
        # arrival of that (bus, stop) — stale predictions from a prior loop
        # that were superseded by an earlier arrival are excluded.
        rows = db.execute("""
            WITH next_arrival AS (
                SELECT
                    p.bus_id, p.to_stop_id, p.predicted_at, p.predicted_eta_sec,
                    (SELECT MIN(a.arrived_at)
                       FROM gps_arrivals a
                      WHERE a.bus_id = p.bus_id
                        AND a.stop_id = p.to_stop_id
                        AND a.arrived_at > p.predicted_at) AS arrived_at,
                    (SELECT a2.route_id
                       FROM gps_arrivals a2
                      WHERE a2.bus_id = p.bus_id
                        AND a2.stop_id = p.to_stop_id
                        AND a2.arrived_at > p.predicted_at
                      ORDER BY a2.arrived_at ASC
                      LIMIT 1) AS route_id
                FROM predictions p
                WHERE p.predicted_at > datetime('now', '-14 days')
            )
            SELECT to_stop_id AS stop_id, route_id, predicted_eta_sec,
                   (julianday(arrived_at) - julianday(predicted_at)) * 86400 AS actual_sec
            FROM next_arrival
            WHERE arrived_at IS NOT NULL
              AND (julianday(arrived_at) - julianday(predicted_at)) * 86400 <= 15 * 60
        """).fetchall()

        stop_names = {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM stops").fetchall()}
        route_colors = {r["id"]: (r["name"], r["color"]) for r in db.execute("SELECT id, name, color FROM routes").fetchall()}
    except Exception as e:
        print(f"accuracy query error: {e}")
        rows = []
        stop_names = {}
        route_colors = {}
    db.close()

    from collections import defaultdict

    # Per-bucket aggregates (fleet-wide)
    def fresh_bucket():
        return {"n": 0, "in_range": 0, "errors": [], "abs_errors": []}
    bucket_stats = {b[0]: fresh_bucket() for b in ACCURACY_BUCKETS}

    # Per-(stop, route) overall + per-(stop, route, bucket) detail
    stop_samples = defaultdict(fresh_bucket)
    stop_bucket_samples = defaultdict(fresh_bucket)  # key: (stop_id, route_id, bucket)

    for r in rows:
        horizon = r["actual_sec"]  # seconds between prediction and arrival
        bucket, early_tol, late_tol = _bucket_for_horizon(horizon)
        if bucket is None:
            continue
        # err = predicted - actual. err > 0 → bus arrived early vs prediction
        # (rider could miss it); err < 0 → bus late vs prediction (rider waits).
        err = r["predicted_eta_sec"] - horizon
        in_range = (-late_tol) <= err <= early_tol
        abs_err = abs(err)

        bs = bucket_stats[bucket]
        bs["n"] += 1
        bs["in_range"] += 1 if in_range else 0
        bs["errors"].append(err)
        bs["abs_errors"].append(abs_err)

        key = (r["stop_id"], r["route_id"])
        for sink in (stop_samples[key], stop_bucket_samples[(r["stop_id"], r["route_id"], bucket)]):
            sink["n"] += 1
            sink["in_range"] += 1 if in_range else 0
            sink["errors"].append(err)
            sink["abs_errors"].append(abs_err)

    # Per-bucket output
    buckets_out = []
    for (label, _, _, early_tol, late_tol) in ACCURACY_BUCKETS:
        bs = bucket_stats[label]
        n = bs["n"]
        if n == 0:
            buckets_out.append({
                "bucket": label, "n": 0,
                "in_range_pct": None, "mae_sec": None, "bias_sec": None,
                "early_tol_sec": early_tol, "late_tol_sec": late_tol,
            })
        else:
            buckets_out.append({
                "bucket": label, "n": n,
                "in_range_pct": round(100.0 * bs["in_range"] / n, 1),
                "mae_sec": round(sum(bs["abs_errors"]) / n, 1),
                "bias_sec": round(sum(bs["errors"]) / n, 1),
                "early_tol_sec": early_tol, "late_tol_sec": late_tol,
            })

    # Equally-weighted bucket average for the headline number.
    covered = [b for b in buckets_out if b["n"] > 0]
    if covered:
        headline_in_range = round(sum(b["in_range_pct"] for b in covered) / len(covered), 1)
        headline_mae = round(sum(b["mae_sec"] for b in covered) / len(covered), 1)
        headline_bias = round(sum(b["bias_sec"] for b in covered) / len(covered), 1)
        total_n = sum(b["n"] for b in buckets_out)
        overall = {
            "n": total_n,
            "in_range_pct": headline_in_range,
            "mae_sec": headline_mae,
            "bias_sec": headline_bias,
            "weighted": "equal per bucket (TransitApp / IBI methodology)",
        }
    else:
        overall = None

    # Per-stop output with per-bucket breakdown attached
    def bucket_entry(label, ss, early_tol, late_tol):
        n = ss["n"]
        if n == 0:
            return {"bucket": label, "n": 0, "in_range_pct": None,
                    "mae_sec": None, "bias_sec": None,
                    "early_tol_sec": early_tol, "late_tol_sec": late_tol}
        return {"bucket": label, "n": n,
                "in_range_pct": round(100.0 * ss["in_range"] / n, 1),
                "mae_sec": round(sum(ss["abs_errors"]) / n, 1),
                "bias_sec": round(sum(ss["errors"]) / n, 1),
                "early_tol_sec": early_tol, "late_tol_sec": late_tol}

    stops_out = []
    for (stop_id, route_id), ss in stop_samples.items():
        n = ss["n"]
        if n == 0:
            continue
        per_bucket = [
            bucket_entry(label,
                         stop_bucket_samples.get((stop_id, route_id, label), fresh_bucket()),
                         early_tol, late_tol)
            for (label, _, _, early_tol, late_tol) in ACCURACY_BUCKETS
        ]
        # Stop-level headline is also equal-bucket-weighted for consistency
        covered_b = [b for b in per_bucket if b["n"] > 0]
        if covered_b:
            stop_in_range = round(sum(b["in_range_pct"] for b in covered_b) / len(covered_b), 1)
            stop_mae = round(sum(b["mae_sec"] for b in covered_b) / len(covered_b), 1)
            stop_bias = round(sum(b["bias_sec"] for b in covered_b) / len(covered_b), 1)
        else:
            stop_in_range = stop_mae = stop_bias = 0.0
        stops_out.append({
            "stop_id": stop_id,
            "stop_name": stop_names.get(stop_id, f"Stop {stop_id}"),
            "route_id": route_id,
            "route_name": route_colors.get(route_id, (f"Route {route_id}", ""))[0],
            "route_color": route_colors.get(route_id, ("", "#888888"))[1],
            "n": n,
            "mae_sec": stop_mae,
            "bias_sec": stop_bias,
            "in_range_pct": stop_in_range,
            "buckets": per_bucket,
        })
    stops_out.sort(key=lambda s: -s["n"])

    return {"buckets": buckets_out, "stops": stops_out, "overall": overall}


# ── Geocoding (Nominatim proxy + cache) ────────────────────────────────────

import difflib

# In-process cache for geocode results. Keeps the client snappy and stays
# well within Nominatim's 1 req/sec policy. Entries expire after a day.
_GEOCODE_CACHE: dict[str, tuple[float, list]] = {}
_GEOCODE_TTL = 24 * 60 * 60

# New Haven viewbox biases results toward the shuttle service area.
# left,top,right,bottom (lon_min, lat_max, lon_max, lat_min)
_VIEWBOX = "-73.08,41.40,-72.80,41.22"

# Curated Yale campus landmarks with common aliases. Matched before we hit
# external geocoders so typos like "rozenkranz" or partial names like "SOM"
# resolve reliably. Keep keys lowercase. Aliases share the target's coords.
# display_name is what shows in the picker.
_YALE_LANDMARKS: list[dict] = [
    # Residential colleges
    {"name": "Benjamin Franklin College",  "lat": 41.3247, "lon": -72.9224, "aliases": ["bf", "franklin college"]},
    {"name": "Pauli Murray College",       "lat": 41.3241, "lon": -72.9230, "aliases": ["pauli murray", "murray college"]},
    {"name": "Silliman College",           "lat": 41.3127, "lon": -72.9259, "aliases": ["silliman"]},
    {"name": "Timothy Dwight College",     "lat": 41.3126, "lon": -72.9241, "aliases": ["td", "dwight college"]},
    {"name": "Berkeley College",           "lat": 41.3108, "lon": -72.9289, "aliases": ["berkeley"]},
    {"name": "Branford College",           "lat": 41.3105, "lon": -72.9291, "aliases": ["branford"]},
    {"name": "Saybrook College",           "lat": 41.3101, "lon": -72.9293, "aliases": ["saybrook"]},
    {"name": "Davenport College",          "lat": 41.3107, "lon": -72.9298, "aliases": ["davenport", "dport"]},
    {"name": "Pierson College",            "lat": 41.3105, "lon": -72.9307, "aliases": ["pierson"]},
    {"name": "Trumbull College",           "lat": 41.3119, "lon": -72.9283, "aliases": ["trumbull"]},
    {"name": "Morse College",              "lat": 41.3132, "lon": -72.9292, "aliases": ["morse"]},
    {"name": "Ezra Stiles College",        "lat": 41.3134, "lon": -72.9297, "aliases": ["stiles"]},
    {"name": "Jonathan Edwards College",   "lat": 41.3089, "lon": -72.9295, "aliases": ["je", "jonathan edwards", "je college"]},
    {"name": "Grace Hopper College",       "lat": 41.3100, "lon": -72.9268, "aliases": ["hopper", "grace hopper", "calhoun"]},

    # Libraries / cultural
    {"name": "Sterling Memorial Library",  "lat": 41.3113, "lon": -72.9286, "aliases": ["sml", "sterling", "sterling library"]},
    {"name": "Bass Library",               "lat": 41.3108, "lon": -72.9288, "aliases": ["bass"]},
    {"name": "Beinecke Library",           "lat": 41.3115, "lon": -72.9272, "aliases": ["beinecke", "beinecke rare book"]},
    {"name": "Yale University Art Gallery","lat": 41.3085, "lon": -72.9316, "aliases": ["art gallery", "yuag"]},
    {"name": "Yale Center for British Art","lat": 41.3081, "lon": -72.9310, "aliases": ["ycba", "british art"]},
    {"name": "Woolsey Hall",               "lat": 41.3120, "lon": -72.9273, "aliases": ["woolsey"]},
    {"name": "Commons Dining Hall",        "lat": 41.3122, "lon": -72.9273, "aliases": ["commons", "commons hall"]},
    {"name": "Whitney Humanities Center",  "lat": 41.3129, "lon": -72.9292, "aliases": ["whc", "whitney humanities"]},
    {"name": "Schwarzman Center",          "lat": 41.3112, "lon": -72.9258, "aliases": ["schwarzman", "sss", "hewitt quad"]},

    # Sciences (Prospect St corridor)
    {"name": "Rosenkranz Hall",            "lat": 41.3147, "lon": -72.9246, "aliases": ["rosenkranz", "rosenkrantz"]},
    {"name": "Kroon Hall",                 "lat": 41.3184, "lon": -72.9223, "aliases": ["kroon", "fes", "yale school of environment"]},
    {"name": "Osborn Memorial Laboratories","lat": 41.3144, "lon": -72.9227, "aliases": ["osborn", "oml"]},
    {"name": "Kline Biology Tower",        "lat": 41.3180, "lon": -72.9232, "aliases": ["kbt", "kline"]},
    {"name": "Yale Science Building",      "lat": 41.3169, "lon": -72.9229, "aliases": ["ysb", "science building"]},
    {"name": "Greenberg Conference Center","lat": 41.3194, "lon": -72.9211, "aliases": ["greenberg"]},
    {"name": "Becton Engineering Center",  "lat": 41.3139, "lon": -72.9218, "aliases": ["becton"]},
    {"name": "Dunham Laboratory",          "lat": 41.3143, "lon": -72.9213, "aliases": ["dunham"]},
    {"name": "Hillhouse / Sachem",         "lat": 41.3134, "lon": -72.9225, "aliases": ["hillhouse", "sachem"]},

    # Management / law / medical
    {"name": "Yale School of Management (Evans Hall)","lat": 41.3166, "lon": -72.9252,
     "aliases": ["som", "yale som", "evans hall", "yale management"]},
    {"name": "Yale Law School",            "lat": 41.3109, "lon": -72.9284, "aliases": ["yls", "law school", "sterling law"]},
    {"name": "Yale Divinity School",       "lat": 41.3269, "lon": -72.9235, "aliases": ["yds", "divinity school"]},
    {"name": "Yale Medical School",        "lat": 41.3030, "lon": -72.9348, "aliases": ["ysm", "medical school", "yale med"]},
    {"name": "Yale New Haven Hospital",    "lat": 41.3045, "lon": -72.9356, "aliases": ["ynhh", "yale hospital"]},
    {"name": "Yale School of Public Health (LEPH)","lat": 41.3033, "lon": -72.9317,
     "aliases": ["ysph", "public health", "school of public health", "leph"]},
    {"name": "Yale School of Nursing",     "lat": 41.2607, "lon": -72.8802, "aliases": ["ysn", "nursing school", "yale nursing"]},
    {"name": "Yale School of Drama",       "lat": 41.3098, "lon": -72.9310, "aliases": ["drama school", "yale drama"]},

    # Athletics / health
    {"name": "Payne Whitney Gymnasium",    "lat": 41.3119, "lon": -72.9220, "aliases": ["payne whitney", "pwg", "yale gym", "gym"]},
    {"name": "Yale Health",                "lat": 41.3097, "lon": -72.9196, "aliases": ["yale health", "yuhs"]},
    {"name": "Ingalls Rink",               "lat": 41.3115, "lon": -72.9185, "aliases": ["whale", "ingalls"]},

    # Groceries near campus. Upstream geocoders return unrelated hits
    # ("Trader Joes" in Oklahoma, etc.) so these are curated explicitly.
    # Hamden is the one people mean — the closer TJ to Yale.
    {"name": "Trader Joe's (Hamden)",      "lat": 41.3736, "lon": -72.9187,
     "aliases": ["trader joes", "trader joe's", "tj", "trader joe", "hamden tj"]},
    {"name": "Trader Joe's (Orange)",      "lat": 41.2716, "lon": -73.0268,
     "aliases": ["trader joes orange", "orange tj"]},
    {"name": "Stop & Shop (Whalley)",      "lat": 41.3150, "lon": -72.9382,
     "aliases": ["stop and shop", "stop n shop", "stop shop"]},
    {"name": "Aldi / Walmart (Hamden)",    "lat": 41.3751, "lon": -72.9171,
     "aliases": ["aldi", "walmart", "aldi walmart"]},
    {"name": "Shop Rite (Hamden)",         "lat": 41.3688, "lon": -72.9205,
     "aliases": ["shoprite", "shop rite"]},

    # Cafes / coffee shops near campus. External geocoders often mis-rank
    # these (apostrophes, word splits) — curate the well-known ones so they
    # land in the picker regardless of how the user types them.
    {"name": "Poppy's Coffee and Kitchen", "lat": 41.3210, "lon": -72.9186,
     "aliases": ["poppys", "poppy's", "poppy", "poppys coffee", "poppys kitchen"]},
    {"name": "Arwa Yemeni Coffee",         "lat": 41.3097, "lon": -72.9202,
     "aliases": ["arwa", "arwa coffee", "arwa yemeni", "yemeni coffee", "yemeni"]},
    {"name": "Atticus Bookstore Cafe",     "lat": 41.3082, "lon": -72.9298,
     "aliases": ["atticus", "atticus cafe", "atticus bookstore"]},
    {"name": "Book Trader Cafe",           "lat": 41.3079, "lon": -72.9313,
     "aliases": ["book trader", "booktrader"]},
    {"name": "Willoughby's Coffee (York)", "lat": 41.3096, "lon": -72.9302,
     "aliases": ["willoughbys", "willoughby", "willoughbys york"]},
    {"name": "Willoughby's Coffee (Church)","lat": 41.3088, "lon": -72.9260,
     "aliases": ["willoughbys church"]},
    {"name": "Blue State Coffee (York)",   "lat": 41.3104, "lon": -72.9302,
     "aliases": ["blue state", "blue state coffee", "bluestate"]},
    {"name": "Blue State Coffee (Wall)",   "lat": 41.3116, "lon": -72.9275,
     "aliases": ["blue state wall"]},
    {"name": "Koffee?",                    "lat": 41.3127, "lon": -72.9260,
     "aliases": ["koffee", "koffee audubon"]},
    {"name": "Claire's Corner Copia",      "lat": 41.3090, "lon": -72.9280,
     "aliases": ["claires", "claire's", "corner copia", "claires corner copia"]},
    {"name": "Common Grounds",             "lat": 41.3074, "lon": -72.9340,
     "aliases": ["common grounds", "commongrounds"]},
    {"name": "ERO Cafe",                   "lat": 41.3118, "lon": -72.9213,
     "aliases": ["ero", "ero cafe"]},
    {"name": "Cafe Romeo",                 "lat": 41.3185, "lon": -72.9217,
     "aliases": ["romeo", "cafe romeo"]},
    {"name": "Donut Crazy",                "lat": 41.3080, "lon": -72.9262,
     "aliases": ["donut crazy", "donutcrazy"]},
    {"name": "G Cafe Bakery",              "lat": 41.3140, "lon": -72.9258,
     "aliases": ["g cafe", "gcafe", "g cafe bakery"]},
    {"name": "Poindexter",                 "lat": 41.3066, "lon": -72.9247,
     "aliases": ["poindexter", "poindexter cafe"]},
    {"name": "Pistachio Cafe",             "lat": 41.3083, "lon": -72.9286,
     "aliases": ["pistachio", "pistachio cafe"]},
    {"name": "Motw Coffee and Pastries",   "lat": 41.3088, "lon": -72.9288,
     "aliases": ["motw", "motw coffee"]},
    {"name": "The Coffee Pedaler",         "lat": 41.3075, "lon": -72.9234,
     "aliases": ["coffee pedaler", "pedaler"]},
    {"name": "Crossroads Cafe",            "lat": 41.3083, "lon": -72.9238,
     "aliases": ["crossroads", "crossroads cafe"]},

    # Landmarks
    {"name": "New Haven Green",            "lat": 41.3082, "lon": -72.9272, "aliases": ["green", "nh green"]},
    {"name": "New Haven Union Station",    "lat": 41.2973, "lon": -72.9263, "aliases": ["union station", "train station"]},
    {"name": "Tweed New Haven Airport",    "lat": 41.2636, "lon": -72.8895, "aliases": ["tweed", "hvn airport"]},
]


def _key_variants(k: str) -> list[str]:
    """Expand a match key into tolerant variants so "poppy", "poppys", and
    "poppy's" all hit the same landmark. We match against every variant, so
    this is safe even for words with a real trailing 's' (atticus stays
    "atticus" — the original is always included)."""
    base = k.lower().strip()
    no_apos = base.replace("'", "").replace("\u2019", "").replace("\u2018", "")
    out = {base, no_apos}
    if no_apos.endswith("s") and len(no_apos) > 3:
        out.add(no_apos[:-1])
    return [v for v in out if v]


def _query_variants(q: str) -> list[str]:
    base = q.lower().strip()
    no_apos = base.replace("'", "").replace("\u2019", "").replace("\u2018", "")
    return [v for v in {base, no_apos} if v]


def _match_landmarks(q: str) -> list:
    q_variants = _query_variants(q)
    if not q_variants:
        return []
    # Collect (score, landmark) for ranking. We score the best match across
    # every (query_variant × key_variant) pair so apostrophe / trailing-s
    # differences never lower the score.
    scored: list[tuple[float, dict]] = []
    for L in _YALE_LANDMARKS:
        keys = [L["name"]] + L.get("aliases", [])
        k_variants = [v for k in keys for v in _key_variants(k)]
        best = 0.0
        for qn in q_variants:
            for k in k_variants:
                if qn == k:
                    best = max(best, 1.0); continue
                if qn in k or k in qn:
                    best = max(best, 0.9); continue
                # Fuzzy match — handles typos like rozenkranz ↔ rosenkranz
                best = max(best, difflib.SequenceMatcher(None, qn, k).ratio())
        if best >= 0.75:
            scored.append((best, L))
    scored.sort(key=lambda x: -x[0])
    return [
        {"display_name": f"{L['name']} (Yale)", "lat": L["lat"], "lon": L["lon"],
         "type": "landmark", "class": "yale"}
        for _, L in scored[:3]
    ]


def _nominatim(q: str) -> list:
    params = urllib.parse.urlencode({
        "q": q, "format": "json", "limit": "5",
        "addressdetails": "1", "viewbox": _VIEWBOX, "bounded": "0",
    })
    url = f"https://nominatim.openstreetmap.org/search?{params}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "YaleShuttleTracker/1.0 (personal-use)",
        "Accept-Language": "en",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return []
    return [
        {
            "display_name": r.get("display_name"),
            "lat": float(r["lat"]), "lon": float(r["lon"]),
            "type": r.get("type"), "class": r.get("class"),
        }
        for r in data if "lat" in r and "lon" in r
    ]


def _photon(q: str) -> list:
    """Fallback geocoder with typo tolerance — biased to New Haven."""
    params = urllib.parse.urlencode({
        "q": q, "limit": "5", "lat": "41.31", "lon": "-72.92",
    })
    url = f"https://photon.komoot.io/api?{params}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "YaleShuttleTracker/1.0 (personal-use)",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return []
    out = []
    for f in data.get("features", []):
        coords = f.get("geometry", {}).get("coordinates")
        if not coords or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        # Filter out distant matches — Photon returns city-level hits when it
        # can't match; cap at ~40mi from New Haven to keep results local.
        if abs(lat - 41.31) > 0.6 or abs(lon - -72.92) > 0.6:
            continue
        p = f.get("properties", {})
        name = p.get("name") or ""
        parts = [name,
                 (p.get("street") or "") + (f" {p.get('housenumber')}" if p.get("housenumber") else ""),
                 p.get("city") or p.get("district"),
                 p.get("state"), p.get("country")]
        display = ", ".join([x for x in parts if x])
        out.append({
            "display_name": display, "lat": lat, "lon": lon,
            "type": p.get("type"), "class": p.get("osm_key"),
        })
    return out


def geocode(q: str) -> list:
    q = (q or "").strip()
    if not q:
        return []
    now = time.time()
    key = q.lower()
    hit = _GEOCODE_CACHE.get(key)
    if hit and now - hit[0] < _GEOCODE_TTL:
        return hit[1]

    # Curated Yale landmarks first — resolves typos ("rozenkranz") and
    # common abbreviations ("som", "sml") that the external geocoders miss.
    # Always merge Nominatim + Photon, rather than short-circuiting on the
    # first non-empty result. Otherwise a weak far-away Nominatim hit (e.g.
    # "poppys" → some town in Texas) hides the typo-tolerant Photon match.
    # After merging we drop anything > 40mi from New Haven and rank the rest
    # by distance, so local matches surface first.
    landmarks = _match_landmarks(q)
    NH_LAT, NH_LON = 41.31, -72.92
    MAX_METERS = 64_000  # ~40 mi
    def _dist(r):
        dlat = (r["lat"] - NH_LAT) * 111_000
        dlon = (r["lon"] - NH_LON) * 84_000
        return (dlat * dlat + dlon * dlon) ** 0.5
    merged = _nominatim(q) + _photon(q)
    external = sorted([r for r in merged if _dist(r) <= MAX_METERS], key=_dist)
    # Collapse near-duplicates. OSM often has separate nodes for each
    # direction of travel at a bus stop (e.g. "Prospect/Canner" NB + SB) ~10m
    # apart — keep only the first hit within ~40m of an already-accepted
    # result so the picker doesn't show visual dupes.
    DEDUP_METERS = 70
    kept: list = []
    for r in landmarks + external:
        dup = False
        for k in kept:
            # Quick planar-metric approximation at lat ≈ 41°: 1° lat ≈ 111km,
            # 1° lon ≈ 84km. Close-enough for short distances.
            dlat = (r["lat"] - k["lat"]) * 111_000
            dlon = (r["lon"] - k["lon"]) * 84_000
            if dlat * dlat + dlon * dlon < DEDUP_METERS * DEDUP_METERS:
                dup = True
                break
        if not dup:
            kept.append(r)
    _GEOCODE_CACHE[key] = (now, kept)
    return kept


# ── HTTP app (FastAPI) ────────────────────────────────────────────────────

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Yale Shuttle Map")

# Permissive CORS — the API is read-only and deliberately public.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
)


# In-memory TTL cache for read endpoints. Guards against thundering-herd
# cache stampedes from the Cloudflare edge and keeps the SQLite-heavy
# handlers off the critical path. Values: (expires_at, payload).
_RESPONSE_CACHE: dict[str, tuple[float, dict]] = {}


def _cached(key: str, ttl_sec: float, loader):
    now = time.time()
    hit = _RESPONSE_CACHE.get(key)
    if hit and hit[0] > now:
        return hit[1]
    payload = loader()
    _RESPONSE_CACHE[key] = (now + ttl_sec, payload)
    return payload


def _json_cached(payload, max_age: int):
    # Tell Cloudflare / browsers to cache for max_age seconds.
    # stale-while-revalidate lets clients serve a stale response while we
    # refresh in the background — no user-visible latency spikes.
    cc = f"public, max-age={max_age}, stale-while-revalidate={max_age * 2}"
    return JSONResponse(payload, headers={"Cache-Control": cc})


@app.get("/api/buses")
def api_buses():
    # Live data updates every 5s upstream, so cache 3s — fresh enough and
    # absorbs hundreds of simultaneous clients without hitting SQLite.
    data = _cached("buses", 3, get_bus_data)
    return _json_cached(data, 3)


@app.get("/api/accuracy")
def api_accuracy():
    # Accuracy stats recompute slowly (14-day window). 60s is plenty fresh.
    data = _cached("accuracy", 60, get_accuracy_stats)
    return _json_cached(data, 60)


@app.get("/api/geocode")
def api_geocode(q: str = Query("")):
    # Don't let the browser cache geocode responses: on-type autocomplete
    # repeats the same short queries frequently and stale results (from
    # before a landmark was added / a coord was fixed) confuse users. The
    # in-process server cache (_GEOCODE_CACHE, 24h) still protects us from
    # re-hitting Nominatim/Photon.
    return JSONResponse(
        {"results": geocode(q)},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/healthz")
def healthz():
    return {"ok": True}


# Serve the Vite-built frontend if it exists. In dev, the Vite server
# proxies /api itself, so this mount is only active on deploys where
# the `app/dist` directory has been built.
if STATIC_DIR.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(STATIC_DIR / "assets")),
        name="assets",
    )

    @app.get("/")
    def index():
        return FileResponse(str(STATIC_DIR / "index.html"))

    # Catch-all for any other path so client-side routing still serves
    # index.html. Keeping /api above this so it takes precedence.
    @app.get("/{_path:path}")
    def spa(_path: str):
        candidate = STATIC_DIR / _path
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(STATIC_DIR / "index.html"))


def main():
    import uvicorn

    # Get local IP for display
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = "localhost"
    finally:
        s.close()

    url = f"http://{local_ip}:{PORT}"
    print(f"\n  Yale Shuttle Map → {url}\n")

    if "--once" not in sys.argv:
        try:
            subprocess.Popen(
                ["xdg-open", f"http://localhost:{PORT}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
