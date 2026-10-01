"""Shared loader, labels and causal covariates for the Red Winchester covariate screen.

Read-only. Archive files are resolved only through each day's selected
manifest.json and their SHA-256 is verified, as scripts/archive-check.mjs does.
Every covariate is computed from events that were observable before the time it
describes (the pin, or a forecast origin); the eventual departure of the focal
hold never enters its own features. See PLAN.md for definitions.
"""
import bisect, datetime, gzip, hashlib, json, math, os
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ROOT = os.environ.get("RED_EXP_ROOT", "/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments")
# The nightly production archive on the team Mac (03:40 ET). Read-only: never write into it.
ARCHIVE = os.environ.get("RED_EXP_ARCHIVE", "/Users/grtwrn/shuttle-archive")
WEATHER_DIR = os.environ.get("RED_EXP_WEATHER", os.path.join(ROOT, "data", "weather"))
RED, WIN, UNION, DIV = 3, 11, 121, 48
RIDER_SURFACES = ("trip", "card", "ride")
# Audited restart truncation excluded by production (releaseFit.ts); not an outlier rule.
RESTART_TRUNCATED = ("#316", 11, 1789656325854)
MIN = 60_000

# Yale FAS/SEAS standard meeting patterns effective Fall 2026 (registrar.yale.edu,
# read 2026-10-01). Every weekday follows the same schedule. Times are local ET.
CLASS_STARTS = ["09:00", "09:25", "10:30", "11:35", "13:05", "13:30", "14:35", "16:00", "17:00"]
CLASS_ENDS = ["09:10", "10:15", "11:20", "12:25", "12:50", "14:20", "15:25", "15:50", "16:50", "17:15", "17:50"]


def _min_of_day(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


CLASS_START_MIN = [_min_of_day(x) for x in CLASS_STARTS]
CLASS_END_MIN = [_min_of_day(x) for x in CLASS_ENDS]


def et(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, ET)


def service_day(ms):
    return et(ms).strftime("%Y-%m-%d")


def archive_days():
    return sorted(d for d in os.listdir(ARCHIVE) if len(d) == 10 and d.startswith("20"))


def manifest(day):
    with open(os.path.join(ARCHIVE, day, "manifest.json")) as f:
        return json.load(f)


def load_table(day, table, verify=True):
    """Rows of one table through the selected manifest, or None if not complete."""
    t = manifest(day)["tables"].get(table)
    if not t or not t.get("complete"):
        return None
    path = os.path.join(ARCHIVE, day, t["file"])
    with open(path, "rb") as f:
        raw = f.read()
    if verify:
        if t.get("bytes") is not None and len(raw) != t["bytes"]:
            raise ValueError(f"{day}/{table}: size {len(raw)} != manifest {t['bytes']}")
        if t.get("sha256") and hashlib.sha256(raw).hexdigest() != t["sha256"]:
            raise ValueError(f"{day}/{table}: sha256 mismatch")
    if not raw:
        return []
    return [json.loads(l) for l in gzip.decompress(raw).decode().splitlines() if l.strip()]


def usable_days():
    """Days whose required tables are complete and that have Red Winchester visits."""
    out = []
    for d in archive_days():
        try:
            m = manifest(d)
        except FileNotFoundError:
            continue
        need = ("stop_visits", "arrivals")
        if not all(m["tables"].get(t, {}).get("complete") for t in need):
            continue
        out.append(d)
    return out


class Weather:
    """Hourly Open-Meteo values. Precipitation at hour H is the sum over (H-1, H]."""

    def __init__(self):
        self.precip, self.temp = {}, {}
        if not os.path.isdir(WEATHER_DIR):
            return
        for name in sorted(os.listdir(WEATHER_DIR)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(WEATHER_DIR, name)) as f:
                h = json.load(f).get("hourly") or {}
            prefer = name.startswith("archive")  # reanalysis wins over forecast-API past_days
            for t, p, T in zip(h.get("time", []), h.get("precipitation", []), h.get("temperature_2m", [])):
                if p is None or T is None:
                    continue
                if prefer or t not in self.precip:
                    self.precip[t], self.temp[t] = p, T

    def at(self, ms):
        """Latest completed hour at or before ms (local time keys)."""
        d = et(ms).replace(minute=0, second=0, microsecond=0)
        key = d.strftime("%Y-%m-%dT%H:00")
        prev = (d - datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:00")
        if key not in self.precip:
            return None
        return {"precip": self.precip[key], "precip_prev": self.precip.get(prev, 0.0), "temp": self.temp[key]}


def class_window(ms):
    """(post_end_15, pre_start_20) indicators for local clock time ms."""
    d = et(ms)
    m = d.hour * 60 + d.minute + d.second / 60
    post = any(0 <= m - e < 15 for e in CLASS_END_MIN)
    pre = any(0 < s - m <= 20 for s in CLASS_START_MIN)
    return (1.0 if post else 0.0, 1.0 if pre else 0.0)


def _sorted_index(rows, key):
    rows = sorted(rows, key=key)
    return rows, [key(r) for r in rows]


class RedData:
    """All Red rows needed by the screen, across every usable archive day."""

    def __init__(self, days=None, verify=True):
        self.days = days or usable_days()
        self.visits, self.arrivals, self.pred48, self.up48 = [], [], [], []
        self.coverage = {}
        for d in self.days:
            sv = load_table(d, "stop_visits", verify) or []
            ar = load_table(d, "arrivals", verify) or []
            pl = load_table(d, "predictions_log", verify)
            self.visits += [r for r in sv if r["route_id"] == RED]
            self.arrivals += [r for r in ar if r["route_id"] == RED]
            pl = pl or []
            p48 = [r for r in pl if r["route_id"] == RED and r["to_stop_id"] == DIV]
            self.pred48 += [r for r in p48 if r["surface"] in RIDER_SURFACES]
            self.up48 += [r for r in p48 if r["surface"] == "upstream"]
            m = manifest(d)
            self.coverage[d] = {t: (v.get("rows") if v.get("complete") else None) for t, v in m["tables"].items()}
        # Indexes
        self.dep_by_bus_stop = {}  # (bus_name, stop) -> sorted departure times (arrivals table, as production)
        for a in self.arrivals:
            if a.get("departed_at") is not None and a["stop_id"] in (WIN, UNION):
                self.dep_by_bus_stop.setdefault((a["bus_name"], a["stop_id"]), []).append(a["departed_at"])
        for v in self.dep_by_bus_stop.values():
            v.sort()
        self.arr48_by_bus = {}
        for a in self.arrivals:
            if a["stop_id"] == DIV:
                self.arr48_by_bus.setdefault(a["bus_id"], []).append(a["arrived_at"])
        self.arrW_by_bus = {}
        for a in self.arrivals:
            if a["stop_id"] == WIN:
                self.arrW_by_bus.setdefault(a["bus_id"], []).append(a["arrived_at"])
        for v in list(self.arr48_by_bus.values()) + list(self.arrW_by_bus.values()):
            v.sort()
        self.visits_by_bus = {}
        for v in self.visits:
            self.visits_by_bus.setdefault(v["bus_name"], []).append(v)
        for v in self.visits_by_bus.values():
            v.sort(key=lambda r: r["anchored_at"])
        self.visits_by_anchor, self.anchor_keys = _sorted_index(self.visits, lambda r: r["anchored_at"])
        self.first_seen = {}  # (day, bus_name) -> first anchored_at
        self.last_seen_list = {}
        for v in self.visits:
            k = (service_day(v["anchored_at"]), v["bus_name"])
            self.first_seen[k] = min(self.first_seen.get(k, v["anchored_at"]), v["anchored_at"])
        self.pred48_by_bus = {}
        for r in self.pred48:
            self.pred48_by_bus.setdefault(r["bus_id"], []).append(r)
        self.up48_by_bus = {}
        for r in self.up48:
            self.up48_by_bus.setdefault(r["bus_id"], []).append(r)
        for idx in (self.pred48_by_bus, self.up48_by_bus):
            for k in idx:
                idx[k].sort(key=lambda r: (r["predicted_at"], r["predicted_sec"]))
        self.weather = Weather()

    # ---- production lap (releaseFit.ts loadReleaseObservations) ----
    def prior_departure(self, bus, stop, at):
        ds = self.dep_by_bus_stop.get((bus, stop), [])
        i = bisect.bisect_right(ds, at - 120_000)
        return ds[i - 1] if i else None

    def production_lap(self, bus, pin):
        dep = self.prior_departure(bus, WIN, pin)
        other = self.prior_departure(bus, UNION, pin)
        day = service_day(pin)
        ok = dep is not None and other is not None and dep < other < pin and service_day(dep) == day
        return ((pin - dep) / 1000.0, dep) if ok else (None, dep)

    # ---- Winchester holds (production cohort rules) ----
    def holds(self):
        out = []
        for v in self.visits:
            if v["stop_id"] != WIN or v["outcome"] != "stopped" or v.get("how") == "gap":
                continue
            if v.get("closest_m") is None or v["closest_m"] > 75:
                continue
            pin, dep = v.get("pinned_at"), v.get("departed_at")
            if pin is None or dep is None or dep < pin:
                continue
            if (v["bus_name"], v["stop_id"], pin) == RESTART_TRUNCATED:
                continue
            ready = max(dep + 120_000, (v.get("first_moved_at") or dep) + (v.get("confirm_sec") or 0) * 1000)
            lap, prev_dep = self.production_lap(v["bus_name"], pin)
            h = {
                "id": v["id"], "day": service_day(pin), "bus": v["bus_name"], "bus_id": v["bus_id"],
                "pin": pin, "dep": dep, "y": (dep - pin) / 1000.0, "ready": ready,
                "lap": lap, "prev_dep": prev_dep,
            }
            h["div_arr"] = self.next_div_arrival(v["bus_id"], dep)
            h["feat"] = self.pin_features(h)
            out.append(h)
        out.sort(key=lambda h: h["pin"])
        return out

    def next_div_arrival(self, bus_id, dep):
        """First Division/Prospect arrival of the same vehicle after the Winchester
        departure (production pairing truth: arrivals.arrived_at), within 20 min and
        before the vehicle's next Winchester arrival."""
        arr = self.arr48_by_bus.get(bus_id, [])
        i = bisect.bisect_left(arr, dep - 5_000)
        if i >= len(arr) or arr[i] > dep + 20 * MIN:
            return None
        w = self.arrW_by_bus.get(bus_id, [])
        j = bisect.bisect_right(w, dep)
        if j < len(w) and w[j] < arr[i]:
            return None
        return arr[i]

    # ---- causal covariates at pin ----
    def visits_between(self, lo, hi):
        i = bisect.bisect_left(self.anchor_keys, lo)
        j = bisect.bisect_right(self.anchor_keys, hi)
        return self.visits_by_anchor[i:j]

    def pin_features(self, h):
        pin, bus, day = h["pin"], h["bus"], h["day"]
        f = {}
        # Weather (W): latest completed hour.
        w = self.weather.at(pin)
        f["w_ok"] = w is not None
        f["precip"] = w["precip"] if w else 0.0
        f["wet"] = 1.0 if (w and (w["precip"] >= 0.1 or w["precip_prev"] >= 0.1)) else 0.0
        f["temp"] = w["temp"] if w else None
        # Active fleet (FS): distinct Red vehicles anchored at any Red stop in the last 20 min (60 s delay).
        recent = self.visits_between(pin - 20 * MIN, pin - MIN)
        names = {v["bus_name"] for v in recent} | {bus}
        f["fleet"] = len(names)
        # Shift / service entry (SH)
        wdeps = self.dep_by_bus_stop.get((bus, WIN), [])
        i = bisect.bisect_right(wdeps, pin - 120_000)
        f["loops_today"] = sum(1 for t in wdeps[:i] if service_day(t) == day)
        first = self.first_seen.get((day, bus), pin)
        f["tis_h"] = max(0.0, (pin - first) / 3_600_000)
        new_bus = 0.0
        for (d2, b2), t0 in self.first_seen.items():
            if d2 == day and b2 != bus and pin - 30 * MIN <= t0 <= pin - MIN:
                new_bus = 1.0
        f["new_bus_30"] = new_bus
        seen_recent = {v["bus_name"] for v in self.visits_between(pin - 20 * MIN, pin - MIN)}
        seen_before = {v["bus_name"] for v in self.visits_between(pin - 50 * MIN, pin - 20 * MIN)}
        f["fleet_drop_30"] = 1.0 if (seen_before - seen_recent - {bus}) else 0.0
        # Demand / load proxy (DM): own non-regulator stops since the last Union departure.
        udep = self.prior_departure(bus, UNION, pin + 120_000)  # latest Union departure before pin
        if udep is not None and udep < pin and pin - udep < 90 * MIN:
            stand, n = 0.0, 0
            for v in self.visits_by_bus.get(bus, []):
                if v["anchored_at"] <= udep or v["anchored_at"] >= pin:
                    continue
                if v["stop_id"] in (WIN, UNION) or v.get("departed_at") is None or v["departed_at"] > pin - 15_000:
                    continue
                if v["outcome"] == "stopped":
                    stand += v.get("stand_sec") or 0.0
                    n += 1
            f["dm_ok"] = True
            f["dm_stand"], f["dm_n"] = stand, n
            f["union_to_pin"] = (pin - udep) / 1000.0
        else:
            f["dm_ok"], f["dm_stand"], f["dm_n"], f["union_to_pin"] = False, 0.0, 0, None
        # Operator ETA to Division (UE): latest upstream row for this vehicle in (pin-90 s, pin].
        f["ue48"] = self.upstream_eta(h["bus_id"], pin)
        # Co-presence (CP): other Red vehicles still at Winchester / Union as of pin-15 s.
        cw = cu = 0
        for v in self.visits_between(pin - 60 * MIN, pin - 15_000):
            if v["bus_name"] == bus or v["stop_id"] not in (WIN, UNION):
                continue
            gone = v.get("departed_at")
            if gone is not None and gone <= pin - 15_000:
                continue
            if v.get("pinned_at") is None or v["pinned_at"] > pin - 15_000:
                continue
            if v["stop_id"] == WIN:
                cw = 1
            else:
                cu = 1
        f["co_win"], f["co_union"] = float(cw), float(cu)
        recent_dep = 0.0
        for (b2, s2), ds in self.dep_by_bus_stop.items():
            if b2 == bus or s2 != WIN:
                continue
            k = bisect.bisect_right(ds, pin - MIN)
            if k and ds[k - 1] >= pin - 10 * MIN:
                recent_dep = 1.0
        f["win_dep_10"] = recent_dep
        return f

    def upstream_eta(self, bus_id, at, window_ms=90_000):
        rows = self.up48_by_bus.get(bus_id, [])
        keys = [r["predicted_at"] for r in rows]
        i = bisect.bisect_right(keys, at)
        best = None
        for r in reversed(rows[max(0, i - 10):i]):
            if r["predicted_at"] <= at - window_ms:
                break
            if best is None or r["predicted_at"] > best["predicted_at"] or (
                r["predicted_at"] == best["predicted_at"] and r["predicted_sec"] < best["predicted_sec"]
            ):
                best = r
        return None if best is None else float(best["predicted_sec"]) - (at - best["predicted_at"]) / 1000.0

    def production_pickup(self, bus_id, at, window_ms=30_000):
        """Latest rider-surface production prediction to Division for this vehicle in
        (at-30 s, at]. Several occurrences may be logged at one instant; the current
        one is the smallest predicted_sec. Returns absolute (point, low, high) ms."""
        rows = self.pred48_by_bus.get(bus_id, [])
        keys = [r["predicted_at"] for r in rows]
        i = bisect.bisect_right(keys, at)
        if not i:
            return None
        t = keys[i - 1]
        if t <= at - window_ms:
            return None
        same = [r for r in rows[max(0, i - 20):i] if r["predicted_at"] == t]
        r = min(same, key=lambda r: r["predicted_sec"])
        return {
            "at": t, "point": t + r["predicted_sec"] * 1000,
            "low": t + (r["predicted_low_sec"] if r["predicted_low_sec"] is not None else r["predicted_sec"]) * 1000,
            "high": t + (r["predicted_high_sec"] if r["predicted_high_sec"] is not None else r["predicted_sec"]) * 1000,
            "surface": r["surface"], "build": r.get("client_build"),
        }
