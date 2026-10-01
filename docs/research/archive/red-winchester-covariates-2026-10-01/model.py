"""Discrete-time departure hazard (production form) plus pre-registered covariate arms.

The baseline reproduces src/calibrator/releaseFit.ts (fit) and web/src/eta/release.ts
(prediction): 15-second bins, nine features, L2 penalty 4 on every non-intercept
coefficient, censored exposure beyond 1,800 s, exponential tail continuation.
Arms append extra columns; nothing else about the likelihood changes.
"""
import math
import numpy as np
import lib

BIN = 15.0
HORIZON = 1800.0
PENALTY = 4.0
QLEVELS = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
AGES = (0, 60, 180, 300, 480)
SUPPORT_HOLDS = 20
SUPPORT_DATES = 3


def median_lo_hi(a):
    a = sorted(a)
    return (a[(len(a) - 1) // 2] + a[len(a) // 2]) / 2


def circ_mean_phase(times_ms, period=900.0):
    s = sum(math.sin(2 * math.pi * ((t / 1000) % period) / period) for t in times_ms)
    c = sum(math.cos(2 * math.pi * ((t / 1000) % period) / period) for t in times_ms)
    return (math.atan2(s, c) / (2 * math.pi) * period) % period


class Context:
    """Training-only constants for one fold."""

    def __init__(self, train):
        laps = [h["lap"] for h in train if h["lap"] is not None and 900 < h["lap"] < 7200]
        self.ref = median_lo_hi(laps)
        self.dep_phase = circ_mean_phase([h["dep"] for h in train])
        dm = [h["feat"]["dm_stand"] for h in train if h["feat"]["dm_ok"]]
        dn = [h["feat"]["dm_n"] for h in train if h["feat"]["dm_ok"]]
        self.dm_mean = sum(dm) / len(dm) if dm else 0.0
        self.dn_mean = sum(dn) / len(dn) if dn else 0.0
        self.n_laps = len(laps)
        ue = sorted(h["feat"]["ue48"] for h in train if h["feat"]["ue48"] is not None)
        self.ue_median = median_lo_hi(ue) if ue else 0.0

    def lap_valid(self, h):
        return h["lap"] is not None and 0.65 * self.ref <= h["lap"] <= 1.65 * self.ref

    def own_slot(self, h):
        """Own hourly slot: previous own Winchester departure snapped to the training
        departure-phase grid, plus one hour. None without a valid lap."""
        if not self.lap_valid(h) or h["prev_dep"] is None:
            return None
        p = h["prev_dep"] / 1000.0
        k = round((p - self.dep_phase) / 900.0)
        return (self.dep_phase + 900.0 * k + 3600.0) * 1000.0


# ---- feature blocks. Each returns a list of columns for (hold h, bin-centre t seconds) ----

def base_cols(ctx, h, t):
    valid = ctx.lap_valid(h)
    lap = (h["lap"] - ctx.ref) / 600 if valid else 0.0
    angle = 2 * math.pi * ((math.floor(h["pin"] / 1000) % 900) + t) / 900
    return [1.0, math.log1p(t / 60), t / 600, max(t - 300, 0) / 600, max(t - 600, 0) / 600,
            lap, 0.0 if valid else 1.0, math.sin(angle), math.cos(angle)]


def blk_W(ctx, h, t):
    f = h["feat"]
    temp = 0.0 if f["temp"] is None else (f["temp"] - 20.0) / 10.0
    return [f["wet"], temp]


def blk_C(ctx, h, t):
    return list(lib.class_window(h["pin"] + t * 1000))


def blk_FS(ctx, h, t):
    return [1.0 if h["feat"]["fleet"] <= 2 else 0.0]


def blk_SH(ctx, h, t):
    f = h["feat"]
    return [1.0 if f["loops_today"] <= 1 else 0.0, f["tis_h"] / 10.0, f["new_bus_30"], f["fleet_drop_30"]]


def blk_LL(ctx, h, t):
    slot = ctx.own_slot(h)
    if slot is None:
        return [0.0, 0.0]
    now = h["pin"] + t * 1000
    return [1.0 if now < slot else 0.0, max(0.0, slot - now) / 600000.0]


def blk_DM(ctx, h, t):
    f = h["feat"]
    if not f["dm_ok"]:
        return [0.0, 0.0]
    return [(f["dm_stand"] - ctx.dm_mean) / 300.0, (f["dm_n"] - ctx.dn_mean) / 3.0]


def blk_UE(ctx, h, t):
    """Operator ETA to Division at pin: deviation from the training median (clipped),
    a long-ETA flag, and missingness."""
    ue = h["feat"]["ue48"]
    if ue is None:
        return [0.0, 0.0, 1.0]
    return [max(-3.0, min(3.0, (ue - ctx.ue_median) / 60.0)), 1.0 if ue >= 900 else 0.0, 0.0]


def blk_CP(ctx, h, t):
    f = h["feat"]
    return [f["co_win"], f["co_union"], f["win_dep_10"]]


def blk_INT(ctx, h, t):
    b = base_cols(ctx, h, t)
    lap, s, c = b[5], b[7], b[8]
    fl = blk_FS(ctx, h, t)[0]
    return [lap * s, lap * c, fl * s, fl * c]


BLOCKS = {"W": blk_W, "C": blk_C, "FS": blk_FS, "SH": blk_SH, "LL": blk_LL, "DM": blk_DM,
          "UE": blk_UE, "CP": blk_CP, "INT": blk_INT}
# Pre-registered arms: name -> (blocks, penalty on the added columns)
ARMS = {
    "B0": ((), PENALTY),
    "W": (("W",), PENALTY), "C": (("C",), PENALTY), "FS": (("FS",), PENALTY), "SH": (("SH",), PENALTY),
    "LL": (("LL",), PENALTY), "DM": (("DM",), PENALTY), "UE": (("UE",), PENALTY), "CP": (("CP",), PENALTY),
    "INT": (("INT",), PENALTY),
    "ALL": (("W", "C", "FS", "SH", "LL", "DM", "UE", "CP", "INT"), PENALTY),
    "ALL_R": (("W", "C", "FS", "SH", "LL", "DM", "UE", "CP", "INT"), 20.0),
}


def row(ctx, h, t, blocks):
    x = base_cols(ctx, h, t)
    for b in blocks:
        x += BLOCKS[b](ctx, h, t)
    return x


def design(ctx, holds, blocks):
    xs, ys, owner = [], [], []
    for j, h in enumerate(holds):
        bins = max(1, math.ceil(min(h["y"], HORIZON) / BIN))
        for i in range(bins):
            t = (i + 0.5) * BIN
            xs.append(row(ctx, h, t, blocks))
            ys.append(1.0 if (i == bins - 1 and h["y"] <= HORIZON) else 0.0)
            owner.append(j)
    return np.array(xs), np.array(ys), np.array(owner)


def support_mask(X, owner, holds, k0=9):
    """Added column j is supported when it is nonzero in exposure rows of at least
    SUPPORT_HOLDS distinct training holds on at least SUPPORT_DATES dates. Unsupported
    columns are zeroed, so their coefficient is exactly 0 (forecast = no column)."""
    mask = np.ones(X.shape[1])
    for j in range(k0, X.shape[1]):
        nz = np.unique(owner[X[:, j] != 0])
        dates = {holds[i]["day"] for i in nz}
        if len(nz) < SUPPORT_HOLDS or len(dates) < SUPPORT_DATES:
            mask[j] = 0.0
    return mask


def fit(ctx, train, arm):
    blocks, pen_extra = ARMS[arm]
    X, y, owner = design(ctx, train, blocks)
    mask = support_mask(X, owner, train)
    X = X * mask
    k = X.shape[1]
    lam = np.full(k, PENALTY)
    lam[0] = 0.0
    lam[9:] = pen_extra
    p0 = y.mean()
    beta = np.zeros(k)
    beta[0] = math.log(p0 / (1 - p0))

    def objective(b):
        z = X @ b
        return float(np.sum(np.maximum(z, 0) + np.log1p(np.exp(-np.abs(z))) - y * z) + 0.5 * np.sum(lam * b * b))

    loss = objective(beta)
    for _ in range(100):
        z = X @ beta
        p = 1 / (1 + np.exp(-z))
        g = X.T @ (p - y) + lam * beta
        if np.max(np.abs(g)) < 1e-7:
            break
        Hm = (X * (p * (1 - p))[:, None]).T @ X + np.diag(lam)
        step = np.linalg.solve(Hm, g)
        scale = 1.0
        for _ in range(30):
            trial = beta - scale * step
            tl = objective(trial)
            if tl <= loss:
                break
            scale /= 2
        if tl > loss:
            break
        change = np.max(np.abs(trial - beta))
        beta, loss = trial, tl
        if change < 1e-9:
            break
    beta = beta * mask
    return {"arm": arm, "beta": beta, "blocks": blocks, "n": len(train), "rows": int(X.shape[0]),
            "unsupported": [int(j) for j in np.where(mask == 0)[0]]}


class Dist:
    """Pin-time departure CDF on 15-s knots with an exponential tail (release.ts)."""

    def __init__(self, ctx, model, h):
        xs, logs = [0.0], [0.0]
        logS, last = 0.0, 1 / 240
        end = BIN
        beta = model["beta"]
        while end <= HORIZON + 1e-9:
            t = end - BIN / 2
            z = float(np.dot(row(ctx, h, t, model["blocks"]), beta))
            hz = min(1 - 1e-9, max(1e-9, 1 / (1 + math.exp(-z))))
            last = -math.log1p(-hz) / BIN
            logS += math.log1p(-hz)
            if logS < math.log(1e-6):
                break
            xs.append(end)
            logs.append(logS)
            end += BIN
        self.xs, self.logs = xs, logs
        self.tail = min(1 / 5, max(1 / 1800, last))

    def log_surv(self, r):
        xs, logs = self.xs, self.logs
        if r >= xs[-1]:
            return logs[-1] - self.tail * (r - xs[-1])
        i = max(0, min(len(xs) - 2, int(r // BIN)))
        while xs[i + 1] < r:
            i += 1
        while xs[i] > r:
            i -= 1
        return logs[i] + (logs[i + 1] - logs[i]) * (r - xs[i]) / (xs[i + 1] - xs[i])

    def residual_q(self, age, u):
        """Remaining wait quantile u, conditional on still waiting at age."""
        if u <= 0:
            return 0.0
        target = self.log_surv(age) + math.log1p(-min(1 - 1e-15, u))
        xs, logs = self.xs, self.logs
        if target <= logs[-1]:
            return max(0.0, xs[-1] + (logs[-1] - target) / self.tail - age)
        lo, hi = 0, len(xs) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if logs[mid] > target:
                lo = mid
            else:
                hi = mid
        return max(0.0, xs[lo] + (xs[hi] - xs[lo]) * (target - logs[lo]) / (logs[hi] - logs[lo]) - age)

    def log_score(self, age, y):
        """-log P(departure in the 15-s bin containing y | waiting at age) (proper)."""
        a = self.log_surv(age)
        lo = math.floor(y / BIN) * BIN
        s0 = math.exp(self.log_surv(max(lo, age)) - a)
        s1 = math.exp(self.log_surv(lo + BIN) - a)
        return -math.log(max(1e-12, s0 - s1))


# ---- scores ----

def pinball(q, y, tau):
    return (tau - (1.0 if y < q else 0.0)) * (y - q)


def wis(qs, y):
    """Weighted interval score for quantiles at QLEVELS (90/80/50 intervals + median)."""
    m = qs[0.5]
    total = 0.5 * abs(y - m)
    for lo_t, hi_t in ((0.05, 0.95), (0.1, 0.9), (0.25, 0.75)):
        alpha = 2 * lo_t
        lo, hi = qs[lo_t], qs[hi_t]
        isc = (hi - lo) + (2 / alpha) * max(0.0, lo - y) + (2 / alpha) * max(0.0, y - hi)
        total += alpha / 2 * isc
    return total / 3.5


def wis80(q10, q50, q90, y):
    """WIS with the single 10-90 interval plus median; usable for production's band."""
    isc = (q90 - q10) + 10 * max(0.0, q10 - y) + 10 * max(0.0, y - q90)
    return (0.5 * abs(y - q50) + 0.1 * isc) / 1.5


def score_row(qs, y):
    return {
        "wis": wis(qs, y), "wis80": wis80(qs[0.1], qs[0.5], qs[0.9], y), "ae": abs(y - qs[0.5]),
        "pb10": pinball(qs[0.1], y, 0.1), "pb50": pinball(qs[0.5], y, 0.5), "pb90": pinball(qs[0.9], y, 0.9),
        "cover": 1.0 if qs[0.1] <= y <= qs[0.9] else 0.0, "below": 1.0 if y < qs[0.1] else 0.0,
        "above": 1.0 if y > qs[0.9] else 0.0, "width": qs[0.9] - qs[0.1], "signed": y - qs[0.5],
    }
