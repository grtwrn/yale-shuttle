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
import logging
import os
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

logging.basicConfig(
    level=os.environ.get("SHUTTLE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
_log = logging.getLogger("shuttle-map")


def _log_err(where: str, err: Exception) -> None:
    # Keep the message short for journal / Fly log tailers, but include the
    # traceback at DEBUG so we can flip SHUTTLE_LOG_LEVEL=DEBUG when triaging.
    _log.warning("%s: %s: %s", where, type(err).__name__, err)
    _log.debug("%s traceback:\n%s", where, traceback.format_exc())

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


# Route stops + polyline shapes change every ~6h upstream. Re-fetching and
# re-parsing them (json.loads of thousands of GPS points × ~16 routes) on
# every /api/buses tick was the dominant source of CPython heap churn —
# RSS climbed steadily until the 1GB cgroup OOM-killed the process. Cache
# for 5 minutes; live bus positions still refresh per call.
_ROUTE_STATIC_CACHE: tuple[float, dict] = (0.0, {})
_ROUTE_STATIC_TTL = 300.0


def _get_route_static() -> dict:
    global _ROUTE_STATIC_CACHE
    expires, payload = _ROUTE_STATIC_CACHE
    if payload and expires > time.time():
        return payload
    empty = {"routes": {}, "route_paths": {}, "stop_names": {}, "stop_coords": {}}
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("_get_route_static db.connect", e)
        return payload or empty
    db.row_factory = sqlite3.Row
    try:
        try:
            route_rows = db.execute(
                "SELECT id, stops_json, path_json FROM routes WHERE stops_json IS NOT NULL"
            ).fetchall()
            has_path = True
        except Exception:
            route_rows = db.execute(
                "SELECT id, stops_json FROM routes WHERE stops_json IS NOT NULL"
            ).fetchall()
            has_path = False
        routes: dict = {}
        route_paths: dict = {}
        for r in route_rows:
            rid = str(r["id"])
            stops = json.loads(r["stops_json"]) if r["stops_json"] else []
            routes[rid] = stops
            if has_path and r["path_json"]:
                try:
                    flat = json.loads(r["path_json"])
                    if isinstance(flat, list) and len(flat) >= 4 and len(flat) % 2 == 0:
                        route_paths[rid] = [[flat[i], flat[i + 1]] for i in range(0, len(flat), 2)]
                except Exception:
                    pass
        stop_rows = db.execute("SELECT id, name, lat, lon FROM stops").fetchall()
        stop_names = {r["id"]: r["name"] for r in stop_rows}
        stop_coords = {r["id"]: {"lat": r["lat"], "lon": r["lon"]} for r in stop_rows}
        result = {
            "routes": routes,
            "route_paths": route_paths,
            "stop_names": stop_names,
            "stop_coords": stop_coords,
        }
    except Exception as e:
        _log_err("_get_route_static query", e)
        result = payload or empty
    db.close()
    _ROUTE_STATIC_CACHE = (time.time() + _ROUTE_STATIC_TTL, result)
    return result


def get_bus_data():
    """Return live bus positions + route stop sequences."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("get_bus_data db.connect", e)
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

        static = _get_route_static()
        routes = static["routes"]
        route_paths = static["route_paths"]
        stop_names = static["stop_names"]
        stop_coords = static["stop_coords"]
    except Exception as e:
        _log_err("get_bus_data query", e)
        buses, routes, route_paths, stop_names, stop_coords = [], {}, {}, {}, {}
    db.close()
    segments = get_segment_times()
    dwells = get_dwell_times()
    dwells_by_bus = get_dwell_times_by_bus()
    peaks = get_route_peaks()
    pace = get_bus_pace()
    return {
        "buses": buses, "routes": routes, "route_paths": route_paths,
        "stop_names": stop_names, "stop_coords": stop_coords,
        "segments": segments, "dwells": dwells, "dwells_by_bus": dwells_by_bus,
        "route_peaks": peaks, "bus_pace": pace,
    }


def _expected_segment_seconds(
    db: sqlite3.Connection,
    bus_name: str,
    route_id: int,
    from_stop: int,
    to_stop: int,
    dow: int,
    hour: int,
) -> tuple[float | None, str]:
    """Return (expected_seconds, layer_label) for a segment traversal.

    Hierarchy, most specific → most general. At each layer we require
    ≥ MIN_SAMPLES samples to trust the aggregate; otherwise relax:

      1. bus, dow, hour (exact)   — on-the-fly from segment_times
      2. bus, dow, hour±1         — widen window
      3. bus, dow, hour±2         — widen more
      4. bus, dow (any hour)      — calibrated_segments_by_bus
      5. bus (any day / hour)     — segment_averages_by_bus
      6. any bus, dow, hour       — on-the-fly (route-wide at this hour)
      7. any bus, dow, hour±1
      8. any bus, dow, hour±2
      9. any bus, dow (any hour)  — calibrated_segments
     10. any bus, any             — segment_averages

    The per-bus layers (1–5) give you "is this bus driving differently
    than it normally does at this time?" The bus-agnostic layers (6–10)
    give "is it different from the fleet's usual pace?" Using them as
    fallbacks keeps the answer well-defined even for brand-new buses.
    """
    MIN = 3
    BUS_NORM = bus_name.lstrip("#")
    ONLY_BUS_NAMES = (f"#{BUS_NORM}", BUS_NORM)

    def hour_set(center: int, window: int) -> list[int]:
        # Modular window around `center` so midnight doesn't drop samples.
        # e.g. center=23, window=1 → [22, 23, 0]; center=0, window=2 → [22, 23, 0, 1, 2]
        return [(center + d) % 24 for d in range(-window, window + 1)]

    def raw_avg(bus_filter_sql: str, params: tuple) -> tuple[float | None, int]:
        row = db.execute(
            f"""
            SELECT AVG(travel_seconds) AS avg, COUNT(*) AS n
            FROM segment_times
            WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ?
              AND day_of_week = ?
              AND hops = 1
              AND travel_seconds BETWEEN 15 AND 1200
              AND recorded_at > datetime('now', '-30 days')
              {bus_filter_sql}
            """,
            params,
        ).fetchone()
        return (row["avg"], row["n"] or 0)

    # Per-bus, per-dow, at progressively wider hour windows (wraps at midnight).
    for window in (0, 1, 2):
        hours = hour_set(hour, window)
        placeholders = ",".join(["?"] * len(hours))
        avg, n = raw_avg(
            f"AND bus_name IN (?, ?) AND hour IN ({placeholders})",
            (route_id, from_stop, to_stop, dow, *ONLY_BUS_NAMES, *hours),
        )
        if avg is not None and n >= MIN:
            return avg, f"bus.dow.hr±{window}"

    # Per-bus, per-dow, any hour — use the calibrated table.
    row = db.execute(
        """
        SELECT avg_seconds AS avg, sample_count AS n
        FROM calibrated_segments_by_bus
        WHERE bus_name IN (?, ?) AND route_id = ?
          AND from_stop_id = ? AND to_stop_id = ? AND day_of_week = ?
        """,
        (*ONLY_BUS_NAMES, route_id, from_stop, to_stop, dow),
    ).fetchone()
    if row and row["avg"] is not None and row["n"] >= MIN:
        return row["avg"], "bus.dow"

    # Per-bus across days.
    row = db.execute(
        """
        SELECT avg_seconds AS avg, sample_count AS n
        FROM segment_averages_by_bus
        WHERE bus_name IN (?, ?) AND route_id = ?
          AND from_stop_id = ? AND to_stop_id = ?
        """,
        (*ONLY_BUS_NAMES, route_id, from_stop, to_stop),
    ).fetchone()
    if row and row["avg"] is not None and row["n"] >= MIN:
        return row["avg"], "bus.any"

    # Any-bus, per-dow, at progressively wider hour windows (wraps at midnight).
    for window in (0, 1, 2):
        hours = hour_set(hour, window)
        placeholders = ",".join(["?"] * len(hours))
        avg, n = raw_avg(
            f"AND hour IN ({placeholders})",
            (route_id, from_stop, to_stop, dow, *hours),
        )
        if avg is not None and n >= MIN:
            return avg, f"route.dow.hr±{window}"

    # Any-bus, per-dow (calibrated).
    row = db.execute(
        """
        SELECT avg_seconds AS avg, sample_count AS n
        FROM calibrated_segments
        WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ?
          AND day_of_week = ?
        """,
        (route_id, from_stop, to_stop, dow),
    ).fetchone()
    if row and row["avg"] is not None and row["n"] >= MIN:
        return row["avg"], "route.dow"

    # Any-bus, any-day (route-wide).
    row = db.execute(
        """
        SELECT avg_seconds AS avg, sample_count AS n
        FROM segment_averages
        WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ?
        """,
        (route_id, from_stop, to_stop),
    ).fetchone()
    if row and row["avg"] is not None and row["n"] >= MIN:
        return row["avg"], "route.any"

    return None, "none"


def get_bus_pace() -> dict:
    """For each bus, read the last 15 minutes of segment_times and
    compare actual travel_seconds against a hierarchically-derived
    expected time (see _expected_segment_seconds). Returns
    {bus_name: {fast, slow, ratio, n, layers, skip}} where `layers`
    counts how many samples fell through to each baseline."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("get_bus_pace db.connect", e)
        return {}
    db.row_factory = sqlite3.Row

    result: dict = {}
    # SQLite strftime("%w") gives Sun=0..Sat=6, matching how the
    # collector stores day_of_week.
    sqlite_dow = (time.localtime().tm_wday + 1) % 7
    try:
        # Recent traversals (last 15 min). For each one we look up the
        # expected time via the hierarchy and compute actual/expected.
        # The raw sample carries the hour its measurement was taken in,
        # which is what we key the hierarchy on.
        samples = db.execute(
            """
            SELECT bus_name, route_id, from_stop_id, to_stop_id,
                   travel_seconds,
                   CAST(strftime('%H', recorded_at) AS INTEGER) AS hour
            FROM segment_times
            WHERE recorded_at > datetime('now', '-15 minutes')
              AND hops = 1
              AND travel_seconds BETWEEN 15 AND 1200
            """
        ).fetchall()
    except Exception as e:
        _log_err("get_bus_pace samples", e)
        samples = []

    ratios_by_bus: dict = {}
    layer_counts: dict = {}
    for s in samples:
        bn = s["bus_name"].lstrip("#")
        expected, layer = _expected_segment_seconds(
            db, s["bus_name"], s["route_id"],
            s["from_stop_id"], s["to_stop_id"],
            sqlite_dow, s["hour"],
        )
        if not expected or expected <= 0:
            continue
        ratios_by_bus.setdefault(bn, []).append(s["travel_seconds"] / expected)
        layer_counts.setdefault(bn, {})[layer] = layer_counts.get(bn, {}).get(layer, 0) + 1

    for bn, rs in ratios_by_bus.items():
        if len(rs) < 2:
            continue
        rs_sorted = sorted(rs)
        median = rs_sorted[len(rs_sorted) // 2]
        result[bn] = {
            "fast": median < 0.80,
            "slow": median > 1.25,
            "ratio": round(median, 2),
            "n": len(rs),
            # Diagnostic: which layers of the hierarchy fed each sample.
            # Useful for triage — a bus showing {"route.any": 3} means
            # we had no day/hour calibration for its segments and fell
            # to the weakest baseline.
            "layers": layer_counts.get(bn, {}),
            "skip": None,
        }

    # Most recent multi-hop transition per bus in last 5 min —
    # collector records these when last_stop_id jumps >1 stop.
    try:
        skip_rows = db.execute("""
            SELECT bus_name, hops,
                   CAST((julianday('now') - julianday(recorded_at)) * 86400 AS INTEGER) AS ago_sec
            FROM segment_times
            WHERE recorded_at > datetime('now', '-5 minutes')
              AND hops > 1
            GROUP BY bus_name
            HAVING MIN(ago_sec)
        """).fetchall()
    except Exception as e:
        _log_err("get_bus_pace skips", e)
        skip_rows = []

    for r in skip_rows:
        bn = r["bus_name"].lstrip("#")
        entry = result.setdefault(bn, {"fast": False, "slow": False, "ratio": None, "n": 0, "layers": {}, "skip": None})
        entry["skip"] = {"count": r["hops"] - 1, "ago_sec": int(r["ago_sec"] or 0)}

    db.close()
    return result


def get_dwell_times_by_bus() -> dict:
    """Per-bus calibrated dwell times, prefer today's day-of-week then fall
    back to all-days average. Nested: {bus_name: {route_id: {stop_id: {med, sd, n}}}}."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("get_dwell_times_by_bus db.connect", e)
        return {}
    db.row_factory = sqlite3.Row
    try:
        day_of_week = time.localtime().tm_wday
        sqlite_dow = (day_of_week + 1) % 7
        rows = db.execute("""
            SELECT cdb.bus_name, cdb.route_id, cdb.stop_id,
                   cdb.median_dwell_seconds, cdb.stddev_dwell_seconds, cdb.sample_count
            FROM calibrated_dwells_by_bus cdb
            WHERE cdb.day_of_week = ?
            UNION ALL
            SELECT dab.bus_name, dab.route_id, dab.stop_id,
                   dab.median_dwell_seconds, dab.stddev_dwell_seconds, dab.sample_count
            FROM dwell_averages_by_bus dab
            WHERE NOT EXISTS (
                SELECT 1 FROM calibrated_dwells_by_bus cdb2
                WHERE cdb2.bus_name = dab.bus_name
                  AND cdb2.route_id = dab.route_id
                  AND cdb2.stop_id = dab.stop_id
                  AND cdb2.day_of_week = ?
            )
        """, (sqlite_dow, sqlite_dow)).fetchall()
    except Exception as e:
        _log_err("get_dwell_times_by_bus query", e)
        rows = []
    db.close()

    result: dict = {}
    for r in rows:
        bn = r["bus_name"].lstrip("#")
        rid = str(r["route_id"])
        sid = str(r["stop_id"])
        result.setdefault(bn, {}).setdefault(rid, {})[sid] = {
            "med": round(r["median_dwell_seconds"], 1),
            "sd": round(r["stddev_dwell_seconds"] or 0, 1),
            "n": r["sample_count"],
        }
    return result


def get_route_peaks() -> dict:
    """Max concurrent bus count ever observed per route (persisted across
    bus_positions retention trims)."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("get_route_peaks db.connect", e)
        return {}
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("SELECT route_id, peak_concurrent FROM route_peaks").fetchall()
    except Exception as e:
        _log_err("get_route_peaks query", e)
        rows = []
    db.close()
    return {str(r["route_id"]): r["peak_concurrent"] for r in rows}


def get_segment_times():
    """Return calibrated segment times for all routes."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("get_segment_times db.connect", e)
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
    except Exception as e:
        _log_err("get_segment_times query", e)
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
    except Exception as e:
        _log_err("get_dwell_times db.connect", e)
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
    except Exception as e:
        _log_err("get_dwell_times query", e)
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
    except Exception as e:
        _log_err("get_accuracy_stats db.connect", e)
        return {"buckets": [], "stops": [], "overall": None}
    db.row_factory = sqlite3.Row
    try:
        # Every prediction that preceded an arrival within the last 14 days, up
        # to 15 minutes ahead. Crucially, each prediction only matches the NEXT
        # arrival of that (bus, stop) — stale predictions from a prior loop
        # that were superseded by an earlier arrival are excluded.
        # Sanity filter on wraparound matches. A prediction made *after*
        # the bus had already blown past the pickup has its "next arrival"
        # land on the bus's next loop — inflating every error in that
        # sample to ~one full loop. We drop any row where the realised
        # horizon is more than 3× the predicted value plus 60 s, since
        # no legitimate miss (stall, traffic, etc.) should balloon that
        # much relative to what we told the rider. The absolute 15 min
        # ceiling stays in place as a secondary guard.
        rows = db.execute("""
            WITH next_arrival AS (
                SELECT
                    p.bus_id, p.to_stop_id, p.from_stop_id, p.route_id,
                    p.predicted_at, p.predicted_eta_sec,
                    (SELECT MIN(a.arrived_at)
                       FROM gps_arrivals a
                      WHERE a.bus_id = p.bus_id
                        AND a.stop_id = p.to_stop_id
                        AND a.arrived_at > p.predicted_at) AS arrived_at
                FROM predictions p
                WHERE p.predicted_at > datetime('now', '-7 days')
            )
            SELECT to_stop_id AS stop_id, route_id, from_stop_id, predicted_eta_sec,
                   (julianday(arrived_at) - julianday(predicted_at)) * 86400 AS actual_sec
            FROM next_arrival
            WHERE arrived_at IS NOT NULL
              AND (julianday(arrived_at) - julianday(predicted_at)) * 86400 <= 15 * 60
              AND (julianday(arrived_at) - julianday(predicted_at)) * 86400
                  <= predicted_eta_sec * 3 + 60
            LIMIT 150000
        """).fetchall()

        stop_names = {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM stops").fetchall()}
        route_colors = {r["id"]: (r["name"], r["color"]) for r in db.execute("SELECT id, name, color FROM routes").fetchall()}
        # Route stop sequences: needed to compute how many stops lay
        # between the bus and the pickup at prediction time. We pool
        # abs_error by (pickup_stop, stops_ahead) so the UI can show
        # "when the bus is N stops away, 95% of arrivals land in ±X m."
        route_seqs: dict[int, list[int]] = {}
        for r in db.execute("SELECT id, stops_json FROM routes WHERE stops_json IS NOT NULL").fetchall():
            try:
                seq = json.loads(r["stops_json"])
                if isinstance(seq, list) and seq:
                    route_seqs[r["id"]] = seq
            except Exception:
                pass
    except Exception as e:
        _log_err("get_accuracy_stats query", e)
        rows = []
        stop_names = {}
        route_colors = {}
        route_seqs = {}
    db.close()

    def _stops_ahead(route_id: int, from_stop: int, to_stop: int) -> int | None:
        # Modular stop-count along the route loop. Returns None when
        # either stop isn't on this route's sequence (route-crossing
        # vehicles or stale `from_stop_id` can produce this).
        seq = route_seqs.get(route_id)
        if not seq:
            return None
        try:
            fi = seq.index(from_stop)
            ti = seq.index(to_stop)
        except ValueError:
            return None
        return (ti - fi) % len(seq)

    # Finer buckets: individual 1-10, then everything 10+. User ask
    # was to distinguish a 6-stops-away prediction from a 27-stops-
    # away one (both landed in the old "6+" bucket and that hid how
    # much worse far-bus accuracy is). Far buckets will be sparser
    # but we already gate on n >= 10 samples in the UI.
    DIST_BUCKETS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "10+"]
    def _dist_bucket(ahead: int) -> str | None:
        if ahead <= 0:
            return None  # bus at / past the pickup — different regime
        if ahead <= 10:
            return str(ahead)
        return "10+"

    from collections import defaultdict

    def _percentile(values: list[float], p: float) -> float | None:
        """Linear-interpolated percentile. p in [0, 100]."""
        if not values:
            return None
        s = sorted(values)
        n = len(s)
        if n == 1:
            return s[0]
        pos = (p / 100.0) * (n - 1)
        lo = int(pos)
        hi = min(lo + 1, n - 1)
        frac = pos - lo
        return s[lo] + (s[hi] - s[lo]) * frac

    # Per-bucket aggregates (fleet-wide)
    def fresh_bucket():
        return {"n": 0, "in_range": 0, "errors": [], "abs_errors": []}
    bucket_stats = {b[0]: fresh_bucket() for b in ACCURACY_BUCKETS}

    # Per-(stop, route) overall + per-(stop, route, bucket) detail
    stop_samples = defaultdict(fresh_bucket)
    stop_bucket_samples = defaultdict(fresh_bucket)  # key: (stop_id, route_id, bucket)
    # Per-(stop, route, distance-bucket) — how accurate is the ETA when
    # the bus is N stops away? keys: (stop_id, route_id, dist_bucket).
    stop_dist_samples: dict = defaultdict(fresh_bucket)

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

        # Distance-bucketed samples (bus → pickup, in stop hops).
        ahead = _stops_ahead(r["route_id"], r["from_stop_id"], r["stop_id"])
        if ahead is not None:
            db_label = _dist_bucket(ahead)
            if db_label is not None:
                dsink = stop_dist_samples[(r["stop_id"], r["route_id"], db_label)]
                dsink["n"] += 1
                dsink["errors"].append(err)
                dsink["abs_errors"].append(abs_err)

    # Release the raw rows immediately — they're large and no longer needed.
    del rows
    import gc; gc.collect()

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
        # Pool every abs-error across buckets to compute overall confidence
        # windows. The frontend picks 95% if it fits within 15 min of
        # prediction, else falls back to 90%.
        all_abs = [e for bs in bucket_stats.values() for e in bs["abs_errors"]]
        overall = {
            "n": total_n,
            "in_range_pct": headline_in_range,
            "mae_sec": headline_mae,
            "bias_sec": headline_bias,
            "p90_sec": round(_percentile(all_abs, 90) or 0, 1) if all_abs else None,
            "p95_sec": round(_percentile(all_abs, 95) or 0, 1) if all_abs else None,
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
        stop_abs = ss["abs_errors"]
        by_distance = []
        for db_label in DIST_BUCKETS:
            dsink = stop_dist_samples.get((stop_id, route_id, db_label))
            if not dsink or dsink["n"] == 0:
                continue
            dabs = dsink["abs_errors"]
            derrs = dsink["errors"]
            by_distance.append({
                "stops_ahead": db_label,
                "n": dsink["n"],
                # p50: the "typical miss" rider-facing number. Robust
                # to the long late-tail (median, not mean).
                "p50_sec": round(_percentile(dabs, 50) or 0, 1) if dabs else None,
                "p90_sec": round(_percentile(dabs, 90) or 0, 1) if dabs else None,
                "p95_sec": round(_percentile(dabs, 95) or 0, 1) if dabs else None,
                "mae_sec": round(sum(dabs) / len(dabs), 1) if dabs else None,
                # Signed mean error. +ve → predicted > actual (bus
                # arrived earlier than we said → rider could miss it).
                # Surfaced as a warning when |bias| is large enough
                # to matter at the catch boundary.
                "bias_sec": round(sum(derrs) / len(derrs), 1) if derrs else None,
            })
        stops_out.append({
            "stop_id": stop_id,
            "stop_name": stop_names.get(stop_id, f"Stop {stop_id}"),
            "route_id": route_id,
            "route_name": route_colors.get(route_id, (f"Route {route_id}", ""))[0],
            "route_color": route_colors.get(route_id, ("", "#888888"))[1],
            "n": n,
            "mae_sec": stop_mae,
            "bias_sec": stop_bias,
            "p90_sec": round(_percentile(stop_abs, 90) or 0, 1) if stop_abs else None,
            "p95_sec": round(_percentile(stop_abs, 95) or 0, 1) if stop_abs else None,
            "by_distance": by_distance,
            "in_range_pct": stop_in_range,
            "buckets": per_bucket,
        })
    stops_out.sort(key=lambda s: -s["n"])

    return {"buckets": buckets_out, "stops": stops_out, "overall": overall}


# ── Geocoding (Nominatim proxy + cache) ────────────────────────────────────

import difflib

# In-process cache for geocode results. Keeps the client snappy and stays
# well within Nominatim's 1 req/sec policy. Entries expire after a day.
# Bounded so a flood of unique queries (typed-as-you-go autocomplete) can't
# leak — the dict was previously written to but never pruned.
_GEOCODE_CACHE: dict[str, tuple[float, list]] = {}
_GEOCODE_TTL = 24 * 60 * 60
_GEOCODE_MAX_ENTRIES = 1000

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
    {"name": "The Whale Tea",              "lat": 41.3120, "lon": -72.9223,
     "aliases": ["whale tea", "the whale", "whale", "bubble tea"]},
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
    # Emit the raw score alongside each result so the unified ranker in
    # geocode() can compare apples-to-apples against shuttle stops and
    # external geocoder hits rather than relying on source-ordering alone.
    return [
        {"display_name": f"{L['name']} (Yale)", "lat": L["lat"], "lon": L["lon"],
         "type": "landmark", "class": "yale", "_score": score}
        for score, L in scored[:6]
    ]


MAPBOX_TOKEN = os.environ.get("MAPBOX_TOKEN", "")


def _mapbox(q: str) -> list:
    """Mapbox Search Box `/forward` — single-shot search that covers
    both addresses and POIs (Geocoding v6 is address-only). Tight
    New Haven proximity bias. This is the primary external source;
    Nominatim and Photon stay as fallbacks so the picker keeps
    working if the token expires or the free tier runs out. Silent
    no-op when MAPBOX_TOKEN is unset."""
    if not MAPBOX_TOKEN:
        return []
    params = urllib.parse.urlencode({
        "q": q,
        "access_token": MAPBOX_TOKEN,
        "proximity": "-72.92,41.31",  # lon,lat (Mapbox order)
        "country": "us",
        "limit": "8",
        "language": "en",
    })
    url = f"https://api.mapbox.com/search/searchbox/v1/forward?{params}"
    # Send Referer so a public token with URL restrictions (recommended
    # setup) accepts the server-side call. Without this, Mapbox returns
    # 403 Forbidden and we silently fall through to Nominatim.
    req = urllib.request.Request(url, headers={
        "User-Agent": "YaleShuttleTracker/1.0 (personal-use)",
        "Referer": "https://yale-shuttle.fly.dev/",
    })
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        _log.debug("mapbox fetch failed for %r: %s", q, e)
        return []
    out: list = []
    for f in data.get("features", []):
        props = f.get("properties", {}) or {}
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        # For POIs, `name` is the business / landmark name; for
        # addresses it's the street + number. `full_address` gives
        # the whole human-readable form. Prefer full_address when the
        # name by itself is ambiguous ("Wall Street" → show city too).
        name = props.get("name") or ""
        full = props.get("full_address") or props.get("place_formatted") or ""
        display = f"{name}, {full}" if name and full and name not in full else (full or name)
        out.append({
            "display_name": display,
            "lat": lat, "lon": lon,
            "type": props.get("feature_type") or "place",
            "class": "mapbox",
        })
    return out


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
    except Exception as e:
        _log.debug("nominatim fetch failed for %r: %s", q, e)
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
    except Exception as e:
        _log.debug("photon fetch failed for %r: %s", q, e)
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


# Shuttle-stop list cached in memory so we don't hit SQLite on every
# keystroke. Refreshes when the collector ingests new stops (rare).
_STOPS_CACHE: tuple[float, list[dict]] = (0.0, [])
_STOPS_CACHE_TTL = 5 * 60  # seconds


def _load_shuttle_stops() -> list[dict]:
    global _STOPS_CACHE
    now = time.time()
    if now - _STOPS_CACHE[0] < _STOPS_CACHE_TTL and _STOPS_CACHE[1]:
        return _STOPS_CACHE[1]
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("_load_shuttle_stops db.connect", e)
        return _STOPS_CACHE[1]  # return stale rather than nothing
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("SELECT id, name, lat, lon FROM stops WHERE name IS NOT NULL").fetchall()
    except Exception as e:
        _log_err("_load_shuttle_stops query", e)
        rows = []
    db.close()
    out = [
        {"id": r["id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"]}
        for r in rows if r["lat"] is not None and r["lon"] is not None
    ]
    _STOPS_CACHE = (now, out)
    return out


def _nearest_stop_meters(lat: float, lon: float) -> float:
    """Approximate meters from a point to the nearest shuttle stop.
    Used to filter the picker to the service area — a Trader Joe's
    in Fairfield is technically within 40 mi of New Haven but none of
    the shuttles go there, so we shouldn't surface it. Returns inf
    when the stop cache is empty (don't filter) so initial requests
    during cold-start still return something."""
    stops = _load_shuttle_stops()
    if not stops:
        return float("inf")
    best = float("inf")
    for s in stops:
        dlat = (lat - s["lat"]) * 111_000
        dlon = (lon - s["lon"]) * 84_000
        d2 = dlat * dlat + dlon * dlon
        if d2 < best:
            best = d2
    return best ** 0.5


def _match_shuttle_stops(q: str) -> list:
    """Match a query against the shuttle stops table. Stops are the
    ground truth for "places the rider cares about" — when a user types
    'phelps gate' we should find the stop even though it isn't in the
    curated landmark list and may not exist cleanly on OSM. Emits a
    raw `_score` so the unified ranker in geocode() can compare against
    landmarks and external hits on even footing."""
    q_variants = _query_variants(q)
    if not q_variants:
        return []
    stops = _load_shuttle_stops()
    scored: list[tuple[float, dict]] = []
    for s in stops:
        name = s["name"]
        base = name.lower()
        no_punct = "".join(c if c.isalnum() or c == " " else " " for c in base)
        split_parts = [p for p in no_punct.split() if len(p) >= 3]
        key_variants = _key_variants(name) + _key_variants(no_punct) + split_parts
        best = 0.0
        for qn in q_variants:
            for k in key_variants:
                if not k:
                    continue
                if qn == k:
                    best = max(best, 1.0); continue
                if qn in k or k in qn:
                    # Distinguish prefix (strong) from contains (weaker).
                    # A whole-query prefix match is more meaningful than
                    # a single matching substring deep in the name.
                    if k.startswith(qn) or qn.startswith(k):
                        best = max(best, 0.92)
                    else:
                        best = max(best, 0.80); continue
                    continue
                best = max(best, difflib.SequenceMatcher(None, qn, k).ratio())
        if best >= 0.78:
            scored.append((best, s))
    scored.sort(key=lambda x: -x[0])
    seen_names: set[str] = set()
    out: list = []
    for score, s in scored:
        if s["name"] in seen_names:
            continue
        seen_names.add(s["name"])
        out.append({
            "display_name": f"{s['name']} (shuttle stop)",
            "lat": s["lat"], "lon": s["lon"],
            "type": "stop", "class": "shuttle",
            "_score": score,
        })
        if len(out) >= 8:
            break
    return out


def _score_external(q: str, candidate: dict) -> float:
    """Compute a match score for a Nominatim / Photon result. They
    don't return one, so we derive it from the first comma-separated
    segment of `display_name` (the actual place name — the rest is
    location hierarchy). Mirrors the tiered approach used for the
    internal matchers: exact → prefix → contains → fuzzy."""
    q_norm = q.lower().strip()
    full = (candidate.get("display_name") or "").lower()
    head = full.split(",", 1)[0].strip()
    if not head:
        return 0.0
    if q_norm == head:
        return 1.0
    if head.startswith(q_norm) or q_norm.startswith(head):
        return 0.92
    if q_norm in head:
        return 0.82
    # Also try against the address form "<number> <street>" by
    # normalizing out extra punctuation. "220 york" vs "220 york street".
    simple = "".join(c if c.isalnum() or c == " " else " " for c in head)
    simple = " ".join(simple.split())
    if q_norm in simple:
        return 0.82
    # Whole-query fuzzy ratio against the head.
    ratio = difflib.SequenceMatcher(None, q_norm, head).ratio()
    # Word-level fallback: best ratio of the query against any
    # 3+-char token in the name, lightly dampened.
    for w in simple.split():
        if len(w) >= 3:
            ratio = max(ratio, difflib.SequenceMatcher(None, q_norm, w).ratio() * 0.85)
    return ratio


def geocode(q: str) -> list:
    q = (q or "").strip()
    if not q:
        return []
    now = time.time()
    key = q.lower()
    hit = _GEOCODE_CACHE.get(key)
    if hit and now - hit[0] < _GEOCODE_TTL:
        return hit[1]

    # Unified ranker: collect candidates from every source with their
    # raw match score (or compute one for external hits), then apply
    # intent-aware adjustments and sort. No more "shuttle stops always
    # win" — a specific address beats a partial-word stop match when
    # the user types digits; a campus-near hit beats a city-suburb one
    # when scores are similar.
    q_has_digit = any(c.isdigit() for c in q)
    q_word_count = len([w for w in q.split() if w])

    NH_LAT, NH_LON = 41.31, -72.92
    MAX_METERS = 64_000   # ~40 mi fallback (used when stop data unavailable)
    # Tighter service-area cutoff: a candidate must be within ~2 mi of
    # an actual shuttle stop. That covers the Yale campus + Hamden
    # Trader Joe's + West Haven loop + Union Station and excludes
    # everything the shuttle can't reach (Fairfield, Stratford, etc.).
    SERVICE_AREA_METERS = 3200

    def _meters_from_nh(r: dict) -> float:
        dlat = (r["lat"] - NH_LAT) * 111_000
        dlon = (r["lon"] - NH_LON) * 84_000
        return (dlat * dlat + dlon * dlon) ** 0.5

    def _unified_score(r: dict) -> float:
        source = r.get("class") or ""
        base = float(r.get("_score", _score_external(q, r)))

        # Intent: a query with digits is almost certainly an address
        # ("220 york", "80 wall"). Addresses should beat loose word
        # matches on shuttle stops or landmark aliases in that case.
        if q_has_digit:
            if source == "shuttle":
                base *= 0.55
            elif source == "yale":
                base *= 0.80
            # external: leave alone — addresses deserve full score

        # Intent: a multi-word query with no digits is ambiguous. Give
        # curated landmarks + shuttle stops a slight edge since they're
        # what riders actually search for ("sterling library", "phelps
        # gate"). Single-word queries ("sml", "poppys") rely on
        # aliases, so the raw matcher score already handled that.
        if not q_has_digit and q_word_count >= 2:
            if source in ("yale", "shuttle"):
                base *= 1.05

        # Service-area gate: drop candidates too far from any shuttle
        # stop. Shuttle stops and curated landmarks are, by definition,
        # in-area — skip the check for them to save cycles. For
        # everything from Mapbox / Nominatim / Photon we measure.
        if source not in ("shuttle", "yale"):
            stop_dist = _nearest_stop_meters(r["lat"], r["lon"])
            if stop_dist > SERVICE_AREA_METERS and stop_dist != float("inf"):
                return 0.0

        # Distance bonus (from New Haven center). New Haven-proximal
        # results outrank far-off coincidences (a "York" in Pennsylvania,
        # a "Phelps" in Ohio). Also a hard outer cutoff in case the
        # stop table is unavailable and we fell through the gate above.
        dist = _meters_from_nh(r)
        if dist > MAX_METERS:
            return 0.0
        if dist < 2_000:        # ~1.2 mi — campus core
            base += 0.06
        elif dist < 8_000:      # ~5 mi
            base += 0.03
        elif dist < 24_000:     # ~15 mi — greater New Haven
            base += 0.01

        return base

    # Mapbox takes priority among external sources when the token is
    # configured — its autocomplete quality and proximity biasing are
    # miles better than what Nominatim gives us. Nominatim + Photon
    # stay as fallbacks so the picker still works if Mapbox fails or
    # the token is unset.
    #
    # Curated `_match_landmarks` is kept as a Yale-jargon safety net.
    # Mapbox handles full names well ("Kline Tower") but has no
    # tolerance for common typos ("klein" → Kline) or two-letter
    # abbreviations ("KBT", "SML"). The landmark matcher's difflib
    # fuzzy-match catches those. The unified scorer ranks everything
    # together, so this source only wins when it's a clear match.
    mapbox = _mapbox(q)
    if len(mapbox) >= 3:
        candidates = _match_shuttle_stops(q) + _match_landmarks(q) + mapbox
    else:
        candidates = _match_shuttle_stops(q) + _match_landmarks(q) + mapbox + _nominatim(q) + _photon(q)
    scored = [(_unified_score(c), c) for c in candidates]
    # Drop anything the scorer returned 0 for (out-of-area, no match)
    # and anything below a weak-match floor so we don't surface junk.
    scored = [(s, c) for s, c in scored if s >= 0.55]
    scored.sort(key=lambda x: -x[0])

    # Dedupe by geographic proximity — TransLoc NB/SB twins and OSM
    # direction-specific nodes often land within 40 m of each other.
    DEDUP_METERS = 70
    kept: list = []
    for score, r in scored:
        dup = False
        for k in kept:
            dlat = (r["lat"] - k["lat"]) * 111_000
            dlon = (r["lon"] - k["lon"]) * 84_000
            if dlat * dlat + dlon * dlon < DEDUP_METERS * DEDUP_METERS:
                dup = True
                break
        if not dup:
            # Strip the internal scoring field before returning to the
            # client — it's implementation-detail, not something the UI
            # should see or depend on.
            out = {k: v for k, v in r.items() if not k.startswith("_")}
            kept.append(out)
        if len(kept) >= 8:
            break
    if len(_GEOCODE_CACHE) >= _GEOCODE_MAX_ENTRIES:
        # Drop the oldest ~20% by write timestamp. Cheap, avoids LRU bookkeeping.
        ts_sorted = sorted(v[0] for v in _GEOCODE_CACHE.values())
        cutoff = ts_sorted[len(ts_sorted) // 5]
        for k in [k for k, v in _GEOCODE_CACHE.items() if v[0] <= cutoff]:
            del _GEOCODE_CACHE[k]
    _GEOCODE_CACHE[key] = (now, kept)
    return kept


# ── HTTP app (FastAPI) ────────────────────────────────────────────────────

from fastapi import FastAPI, Query, Request, HTTPException
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
    # Accuracy stats recompute slowly (7-day window). 5 min is plenty fresh
    # and keeps the expensive fetchall off the hot path.
    data = _cached("accuracy", 300, get_accuracy_stats)
    return _json_cached(data, 60)


@app.get("/api/debug/predictions")
def api_debug_predictions(
    route_id: int | None = Query(None),
    bus_name: str | None = Query(None),
    to_stop_id: int | None = Query(None),
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(200, ge=1, le=2000),
):
    """Join predictions with the closest-matching gps_arrival so we can see
    over/under per bus × stop over the last N hours (1..168 = 7 days, the
    retention ceiling). Any combination of route_id / bus_name / to_stop_id
    is allowed. Returns rows with predicted_at, horizon, actual_arrived_at,
    delta_sec (positive = bus arrived later than we said → rider waits
    longer than shown; negative = bus came earlier → rider misses it)."""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except Exception as e:
        _log_err("api_debug_predictions db.connect", e)
        return {"predictions": []}
    db.row_factory = sqlite3.Row
    wheres = [f"p.predicted_at > datetime('now', '-{int(hours)} hours')"]
    params: list = []
    if route_id is not None:
        wheres.append("p.route_id = ?"); params.append(route_id)
    if bus_name is not None:
        wheres.append("REPLACE(p.bus_name, '#', '') = ?"); params.append(bus_name.lstrip('#'))
    if to_stop_id is not None:
        wheres.append("p.to_stop_id = ?"); params.append(to_stop_id)
    where_sql = " AND ".join(wheres)
    try:
        rows = db.execute(f"""
            SELECT p.predicted_at, p.bus_name, p.route_id, p.from_stop_id, p.to_stop_id,
                   p.predicted_eta_sec, p.predicted_low_sec, p.predicted_high_sec,
                   (
                     SELECT ga.arrived_at
                     FROM gps_arrivals ga
                     WHERE ga.bus_id = p.bus_id AND ga.stop_id = p.to_stop_id
                       AND ga.arrived_at >= p.predicted_at
                       AND ga.arrived_at < datetime(p.predicted_at, '+2 hours')
                     ORDER BY ga.arrived_at ASC
                     LIMIT 1
                   ) as actual_arrived_at
            FROM predictions p
            WHERE {where_sql}
            ORDER BY p.predicted_at DESC
            LIMIT ?
        """, (*params, int(limit))).fetchall()
    except Exception as e:
        _log_err("api_debug_predictions query", e)
        db.close()
        return {"predictions": [], "error": str(e)}
    db.close()

    out = []
    for r in rows:
        actual = r["actual_arrived_at"]
        delta = None
        if actual:
            try:
                predicted = r["predicted_at"]
                # Convert both to epoch seconds via SQLite's julianday to avoid
                # timezone parsing mismatches. Do it in Python for clarity.
                import datetime as _dt
                pred_dt = _dt.datetime.fromisoformat(predicted.replace(" ", "T"))
                act_dt = _dt.datetime.fromisoformat(actual.replace(" ", "T"))
                delta = (act_dt - pred_dt).total_seconds() - float(r["predicted_eta_sec"])
            except Exception:
                pass
        out.append({
            "predicted_at": r["predicted_at"],
            "bus_name": r["bus_name"].lstrip("#") if r["bus_name"] else r["bus_name"],
            "route_id": r["route_id"],
            "from_stop_id": r["from_stop_id"],
            "to_stop_id": r["to_stop_id"],
            "predicted_eta_sec": round(r["predicted_eta_sec"], 1),
            "predicted_low_sec": round(r["predicted_low_sec"], 1),
            "predicted_high_sec": round(r["predicted_high_sec"], 1),
            "actual_arrived_at": actual,
            "delta_sec": round(delta, 1) if delta is not None else None,
        })
    return {"predictions": out, "horizon_hours": hours, "retention_days": 7}


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


def _ensure_reports_table() -> None:
    """Lazily create the bug-report table so this endpoint doesn't
    require a schema migration in the collector. Writes are rare
    enough that creating on first use is fine. The status/resolution
    columns track whether the developer has addressed a report so a
    later "show me outstanding reports" query can skip fixed ones."""
    try:
        db = sqlite3.connect(DB_PATH)
        db.execute("""
            CREATE TABLE IF NOT EXISTS debug_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reported_at TEXT NOT NULL DEFAULT (datetime('now')),
                note TEXT,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                resolution TEXT,
                resolved_at TEXT
            )
        """)
        # Additive migrations for existing deployments.
        for col, decl in [
            ("status", "TEXT NOT NULL DEFAULT 'open'"),
            ("resolution", "TEXT"),
            ("resolved_at", "TEXT"),
        ]:
            try:
                db.execute(f"ALTER TABLE debug_reports ADD COLUMN {col} {decl}")
            except Exception:
                pass  # already exists
        db.commit()
        db.close()
    except Exception as e:
        _log_err("_ensure_reports_table", e)


# Per-client rate limiter for /api/report. In-memory sliding window
# keyed by IP. Resets on process restart, which is fine — the goal is
# to stop accidental or malicious floods from filling the volume, not
# to be cryptographically strict. Values: (minute_bucket_start,
# minute_count, day_bucket_start, day_count).
_REPORT_RATE: dict[str, tuple[float, int, float, int]] = {}
_REPORT_PER_MINUTE = 10
_REPORT_PER_DAY = 200


def _report_rate_allow(client_ip: str) -> bool:
    now = time.time()
    m_bucket = now // 60
    d_bucket = now // 86400
    m_start, m_count, d_start, d_count = _REPORT_RATE.get(
        client_ip, (m_bucket, 0, d_bucket, 0),
    )
    if m_start != m_bucket:
        m_start, m_count = m_bucket, 0
    if d_start != d_bucket:
        d_start, d_count = d_bucket, 0
    if m_count >= _REPORT_PER_MINUTE or d_count >= _REPORT_PER_DAY:
        _REPORT_RATE[client_ip] = (m_start, m_count, d_start, d_count)
        return False
    _REPORT_RATE[client_ip] = (m_start, m_count + 1, d_start, d_count + 1)
    # Clean up cold entries so the dict doesn't grow forever.
    if len(_REPORT_RATE) > 1000:
        stale_cutoff = now - 86400 * 2
        for k, v in list(_REPORT_RATE.items()):
            if v[0] * 60 < stale_cutoff:
                _REPORT_RATE.pop(k, None)
    return True


def _json_depth(obj, d: int = 0) -> int:
    """Max nesting depth of a JSON-like value. Used to reject deeply
    nested payloads that could be a denial-of-service via parser
    recursion."""
    if isinstance(obj, dict):
        return max((_json_depth(v, d + 1) for v in obj.values()), default=d)
    if isinstance(obj, list):
        return max((_json_depth(v, d + 1) for v in obj), default=d)
    return d


@app.post("/api/report")
async def api_report(req: Request):
    """Log a user-submitted bug report. The payload is the client's
    current state (planned option, live buses, stop context) plus an
    optional free-text note. Stored verbatim — debugging later is a
    matter of SELECTing rows. Size-capped at 64 KB to keep the volume
    from filling with accidental floods. Rate-limited per-IP so a bad
    actor can't burst the endpoint."""
    client_ip = req.client.host if req.client else "unknown"
    # Fly sets X-Forwarded-For with the real client. Trust only when
    # the immediate peer is a known proxy IP range — but on Fly every
    # request arrives through their proxy, so pulling the first XFF
    # hop is safe for rate-limiting purposes.
    fwd = req.headers.get("x-forwarded-for")
    if fwd:
        client_ip = fwd.split(",")[0].strip() or client_ip
    if not _report_rate_allow(client_ip):
        raise HTTPException(status_code=429, detail="too many reports — slow down")
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected object body")
    if _json_depth(body) > 6:
        raise HTTPException(status_code=400, detail="payload too deeply nested")
    note = str(body.pop("note", "") or "")[:2000]
    payload = json.dumps(body, default=str)
    if len(payload) > 64_000:
        raise HTTPException(status_code=413, detail="payload too large")
    _ensure_reports_table()
    try:
        db = sqlite3.connect(DB_PATH)
        cursor = db.execute(
            "INSERT INTO debug_reports (note, payload) VALUES (?, ?)",
            (note, payload),
        )
        report_id = cursor.lastrowid
        db.commit()
        db.close()
    except Exception as e:
        _log_err("api_report insert", e)
        raise HTTPException(status_code=500, detail="could not save report")
    _log.info("debug report #%s saved (%d bytes, note=%r)", report_id, len(payload), note[:80])
    return {"ok": True, "id": report_id}


@app.get("/api/reports")
def api_reports(
    limit: int = Query(50, ge=1, le=500),
    status: str = Query("", description="Filter by status (open, addressed, wontfix). Empty = all."),
):
    """Read back recent bug reports — for the developer, not riders.
    Returns newest first. Includes status/resolution so a later
    "check for new errors" query can skip already-addressed ones."""
    _ensure_reports_table()
    wheres: list = []
    params: list = []
    if status:
        wheres.append("status = ?")
        params.append(status)
    where_sql = f"WHERE {' AND '.join(wheres)}" if wheres else ""
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        rows = db.execute(
            f"SELECT id, reported_at, note, payload, status, resolution, resolved_at "
            f"FROM debug_reports {where_sql} ORDER BY id DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        db.close()
    except Exception as e:
        _log_err("api_reports query", e)
        return {"reports": []}
    return {
        "reports": [
            {
                "id": r["id"],
                "reported_at": r["reported_at"],
                "note": r["note"],
                "payload": json.loads(r["payload"]) if r["payload"] else None,
                "status": r["status"],
                "resolution": r["resolution"],
                "resolved_at": r["resolved_at"],
            }
            for r in rows
        ],
    }


@app.post("/api/reports/{report_id}/update")
async def api_reports_update(report_id: int, req: Request):
    """Developer-only endpoint to annotate a bug report: set status
    (open/addressed/wontfix/duplicate) and/or add resolution notes.
    Each call appends the note to whatever was there, timestamping
    the update, so the resolution field doubles as a triage log."""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    status = body.get("status")
    note = body.get("note")
    if status is not None and status not in ("open", "addressed", "wontfix", "duplicate"):
        raise HTTPException(status_code=400, detail="invalid status")
    _ensure_reports_table()
    try:
        db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT resolution FROM debug_reports WHERE id = ?", (report_id,)).fetchone()
        if not row:
            db.close()
            raise HTTPException(status_code=404, detail="report not found")
        new_resolution = row["resolution"] or ""
        if note:
            # Append with timestamp; keep prior notes so the field
            # reads chronologically like a bug-tracker comment log.
            ts = time.strftime("%Y-%m-%d %H:%M")
            entry = f"[{ts}] {note}"
            new_resolution = f"{new_resolution}\n{entry}" if new_resolution else entry
        fields: list = []
        params: list = []
        if status is not None:
            fields.append("status = ?")
            params.append(status)
            if status != "open":
                fields.append("resolved_at = COALESCE(resolved_at, datetime('now'))")
        if note:
            fields.append("resolution = ?")
            params.append(new_resolution)
        if not fields:
            db.close()
            raise HTTPException(status_code=400, detail="nothing to update")
        params.append(report_id)
        db.execute(f"UPDATE debug_reports SET {', '.join(fields)} WHERE id = ?", params)
        db.commit()
        db.close()
    except HTTPException:
        raise
    except Exception as e:
        _log_err("api_reports_update", e)
        raise HTTPException(status_code=500, detail="could not update report")
    return {"ok": True, "id": report_id}


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
