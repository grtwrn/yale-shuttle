"""Descriptive, visit-weighted errors on matched checkpoint-ensemble cases.

No fitting, independent-error assumption, confidence interval or weight tuning.
The caller proves that all components refer to the same physical target and
that all source/label times are admissible. Unknown numeric rows remain in the
denominator; complete-case statistics report their own physical-visit counts.
"""
import collections
import datetime as dt
import json
import math


GROUP_FIELDS = ("quality", "route", "wait", "k", "mode", "regime")
BINS = ("0-30", "30-60", "60-120", "120-300", "300+", "unknown")


def _id(value, name):
    if (type(value) is int) or (isinstance(value, str) and value):
        return (type(value).__name__, value)
    raise ValueError(f"{name} must be a nonempty string or integer ID")


def _numeric(value, name):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric or explicitly unknown")
    try:
        value = float(value)
    except OverflowError:
        return None
    return value if math.isfinite(value) else None


def _counts(rows):
    dates = sorted({r["date"] for r in rows})
    return dict(snapshots=len(rows), visits=len({r["visitKey"] for r in rows}),
                journeys=len({r["journeyKey"] for r in rows}),
                dateCount=len(dates), dates=dates)


def _visit_weights(rows):
    counts = collections.Counter(r["visitKey"] for r in rows)
    return [1 / counts[r["visitKey"]] for r in rows]


def _weighted(values, weights):
    total = math.fsum(weights)
    if not total:
        return None
    return math.fsum(v * (w / total) for v, w in zip(values, weights))


def _summary(rows, weights):
    names = {"meanWithinSnapshotSdSec": "sd", "meanWithinSnapshotRangeSec": "range",
             "ensembleBiasSec": "error", "ensembleMaeSec": "absoluteError"}
    return {name: _weighted([r[field] for r in rows], weights)
            for name, field in names.items()}


def _bin(sd):
    if sd is None:
        return "unknown"
    for high, name in ((30, "0-30"), (60, "30-60"), (120, "60-120"),
                       (300, "120-300")):
        if sd < high:
            return name
    return "300+"


def _normalize(row):
    if not isinstance(row, dict):
        raise ValueError("each diagnostic row must be a mapping")
    try:
        group = {name: row[name] for name in GROUP_FIELDS}
        mask = row["mask"]
        components = row["components"]
        if not isinstance(mask, (list, tuple)) or not mask:
            raise ValueError("mask must be nonempty")
        if any(type(v) is not int or v < 0 for v in mask) or len(set(mask)) != len(mask):
            raise ValueError("mask must contain unique nonnegative integer offsets")
        mask = tuple(sorted(mask))
        if (not isinstance(components, dict)
                or any(type(k) is not int for k in components)
                or set(components) != set(mask)):
            raise ValueError("component keys must match the exact mask")
        for name in ("quality", "mode", "regime"):
            if not isinstance(group[name], str) or not group[name]:
                raise ValueError(f"{name} must be a nonempty string")
        for name in ("route", "wait", "k"):
            if type(group[name]) is not int or group[name] < 0:
                raise ValueError(f"{name} must be a nonnegative integer")
        if any(offset > group["k"] for offset in mask):
            raise ValueError("mask exceeds K")
        at = _numeric(row["at"], "at")
        if at is None:
            raise ValueError("forecast clock must be finite")
        date = row["date"]
        if not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
            raise ValueError("date must use YYYY-MM-DD")
        visit = _id(row["visit"], "visit")
        journey = _id(row["journey"], "journey")
        truth = _numeric(row["truthAbs"], "truthAbs")
        point = _numeric(row["pointAbs"], "pointAbs")
        arrivals = [_numeric(components[j], f"component {j}") for j in mask]
    except KeyError as error:
        raise ValueError(f"missing diagnostic field: {error.args[0]}") from None

    group["mask"] = list(mask)
    result = dict(group=group, visitKey=visit, journeyKey=journey, date=date,
                  at=at, finite=False, unknownReason=None, sd=None, range=None,
                  error=None, absoluteError=None, componentErrors=None)
    if truth is None or point is None or any(v is None for v in arrivals):
        result["unknownReason"] = "missing_or_nonfinite_numeric_diagnostic"
        return result
    errors = [v - truth for v in arrivals]
    error = point - truth
    if not all(math.isfinite(v) for v in errors + [error]):
        result["unknownReason"] = "nonfinite_derived_error"
        return result
    scale = max(abs(v) for v in errors)
    normalized = [v / scale for v in errors] if scale else [0.0] * len(errors)
    mean = math.fsum(v / len(errors) for v in normalized)
    sd = scale * math.sqrt(math.fsum((v - mean) ** 2 / len(errors) for v in normalized))
    spread = max(arrivals) - min(arrivals)
    if not math.isfinite(sd) or not math.isfinite(spread):
        result["unknownReason"] = "nonfinite_derived_dispersion"
        return result
    result.update(finite=True, sd=sd, range=spread, error=error,
                  absoluteError=abs(error), componentErrors=errors)
    return result


def _group_report(rows):
    group = rows[0]["group"]
    mask = group["mask"]
    complete = [r for r in rows if r["finite"]]
    unknown = [r for r in rows if not r["finite"]]
    weights = _visit_weights(complete)
    all_weights = _visit_weights(rows)
    counts = _counts(complete)
    # Compute moments on scaled columns. Multiplying two finite raw variances
    # before taking their square root can overflow and silently produce rho=0.
    columns, scales, means, deviations, unit_variances, variances = [], [], [], [], [], []
    for i in range(len(mask)):
        column = [r["componentErrors"][i] for r in complete]
        scale = max((abs(v) for v in column), default=0.0)
        normalized = [v / scale if scale else 0.0 for v in column]
        normalized_mean = _weighted(normalized, weights)
        centered = [v - normalized_mean for v in normalized]
        unit_variance = _weighted([v * v for v in centered], weights)
        variance = unit_variance * scale * scale if unit_variance is not None else None
        if counts["visits"] < 2 or (variance is not None and (
                not math.isfinite(variance) or (unit_variance > 0 and variance == 0))):
            variance = None
        columns.append(normalized)
        scales.append(scale)
        means.append(normalized_mean * scale if normalized_mean is not None else None)
        deviations.append(centered)
        unit_variances.append(unit_variance)
        variances.append(variance)
    pairs = []
    for i, a in enumerate(mask):
        for j, b in enumerate(mask):
            covariance = correlation = None
            reason = None
            if counts["visits"] < 2:
                reason = "fewer_than_two_physical_visits"
            elif variances[i] is None or variances[j] is None:
                reason = "unrepresentable_component_variance"
            elif unit_variances[i] == 0 or unit_variances[j] == 0:
                reason = "zero_component_variance"
            else:
                unit_covariance = _weighted([
                    a * b for a, b in zip(deviations[i], deviations[j])], weights)
                covariance = unit_covariance * scales[i] * scales[j]
                if (not math.isfinite(covariance)
                        or (unit_covariance != 0 and covariance == 0)):
                    covariance = None
                    reason = "unrepresentable_covariance"
                else:
                    correlation = (unit_covariance / math.sqrt(unit_variances[i])
                                   / math.sqrt(unit_variances[j]))
                    correlation = min(1.0, max(-1.0, correlation))
            pairs.append(dict(a=a, b=b, covarianceSec2=covariance,
                              correlation=correlation, undefinedReason=reason))

    bins = []
    for name in BINS:
        selected = [r for r in rows if _bin(r["sd"]) == name]
        global_weight = [w for r, w in zip(rows, all_weights) if _bin(r["sd"]) == name]
        valid_pairs = [(r, w) for r, w in zip(complete, weights) if _bin(r["sd"]) == name]
        bins.append(dict(bin=name, counts=_counts(selected),
                         fullDenominatorVisitWeight=math.fsum(global_weight),
                         completeCaseVisitWeight=math.fsum(w for _, w in valid_pairs),
                         **_summary([r for r, _ in valid_pairs], [w for _, w in valid_pairs])))

    return dict(group=group, singleton=len(mask) == 1, counts=_counts(rows),
                completeCases=counts, unknownCases=_counts(unknown),
                unknownReasons=dict(collections.Counter(r["unknownReason"] for r in unknown)),
                components=[dict(offset=j, meanErrorSec=mean, varianceSec2=variance)
                            for j, mean, variance in zip(mask, means, variances)],
                pairs=pairs, dispersionBins=bins, **_summary(complete, weights))


def covariance_report(rows):
    grouped = collections.defaultdict(list)
    normalized = [_normalize(row) for row in rows]
    for row in normalized:
        key = json.dumps(row["group"], sort_keys=True, separators=(",", ":"))
        grouped[key].append(row)
    groups = [_group_report(grouped[key]) for key in sorted(grouped)]
    result = dict(schema=1, counts=_counts(normalized), groups=groups,
                  singletonGroups=sum(g["singleton"] for g in groups),
                  multiOffsetGroups=sum(not g["singleton"] for g in groups),
                  weighting="Each physical visit has total weight one within a stratum; "
                            "complete-case statistics renormalize within valid visits.",
                  denominatorNote="Complete/unknown snapshot counts partition each group; "
                                  "their physical-visit counts can overlap. Bin visit counts "
                                  "can also overlap and must not be added as independent visits.",
                  interpretation="Descriptive population moments only. Repeated polls, "
                                 "target visits within one journey and reused dates are not "
                                 "independent trials. No confidence or interval-width inference.",
                  targetPooling="Physical target visits are matched within every row; "
                                "target-stop occurrences are pooled within the declared stratum. "
                                "Between-stop bias can contribute to correlation; it does not "
                                "identify a shared-wait cause.")
    # This rejects accidental NaN/Infinity if a later arithmetic change leaks it.
    json.dumps(result, allow_nan=False)
    return result
