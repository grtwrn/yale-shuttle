"""Pure arithmetic for fixed checkpoint-ensemble development diagnostics.

Seconds throughout. Source admission, chronology, occurrence proof, historical
weights and minimum path/date support belong to the caller. A joint vector is
one physical journey/target, never independent draws from marginal pools.
These empirical deviations are not a claim of calibrated coverage.
"""
import math
from collections.abc import Mapping


def _finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a finite number") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _offsets(values, name="offsets"):
    if not isinstance(values, tuple) or not values:
        raise ValueError(f"{name} must be a nonempty tuple")
    if any(type(v) is not int or v < 0 for v in values):
        raise ValueError(f"{name} must contain nonnegative integer offsets")
    if len(set(values)) != len(values):
        raise ValueError(f"{name} must contain distinct offsets")
    return values


def _exact_keys(values, offsets, name):
    if not isinstance(values, Mapping):
        raise ValueError(f"{name} must be an offset mapping")
    if any(type(v) is not int for v in values) or set(values) != set(offsets):
        raise ValueError(f"{name} must have exactly the requested offsets")


def _identity(value, name, string_only=False):
    allowed = isinstance(value, str) and bool(value)
    if not string_only:
        allowed = allowed or type(value) is int
    if not allowed:
        raise ValueError(f"{name} must be a nonempty string or integer ID")
    return value


def mean_absolute(departures, means, offsets):
    """Average source-departure + fitted-duration clocks without clipping."""
    offsets = _offsets(offsets)
    _exact_keys(departures, offsets, "departures")
    _exact_keys(means, offsets, "means")
    values = [
        _finite(departures[j], "departure") + _finite(means[j], "duration mean")
        for j in offsets
    ]
    # Divide before summing to avoid an unnecessary intermediate sum overflow.
    result = math.fsum(v / len(values) for v in values)
    return _finite(result, "absolute arrival")


def _quantile(values, probability, weights):
    pairs = sorted(zip(values, weights))
    threshold = math.fsum(weights) * probability
    accumulated = 0.0
    for value, weight in pairs:
        accumulated += weight
        if accumulated >= threshold:
            return value
    return pairs[-1][0]


def joint_deviations(vectors, offsets, weights, project_offsets=None):
    """Weighted signed spread of paired durations around their joint mean.

    All full vectors are validated even for a single-offset projection. The
    matched single-K comparison therefore uses the same journeys and weights.
    Live departures add one constant to every historical vector's mean, which
    cancels on centering; they must not be supplied as separately sampled data.
    """
    offsets = _offsets(offsets)
    projection = offsets if project_offsets is None else _offsets(
        project_offsets, "project_offsets")
    if not set(projection).issubset(offsets):
        raise ValueError("project_offsets must be a subset of full offsets")
    if not isinstance(vectors, (list, tuple)) or not vectors:
        raise ValueError("vectors must be nonempty")
    if not isinstance(weights, (list, tuple)) or len(weights) != len(vectors):
        raise ValueError("weights must align exactly with vectors")

    admitted_weights = [_finite(w, "weight") for w in weights]
    if any(w <= 0 for w in admitted_weights):
        raise ValueError("weights must be positive")
    seen = set()
    seen_targets, seen_waits, seen_sources = set(), set(), set()
    values = []
    for vector in vectors:
        if not isinstance(vector, Mapping):
            raise ValueError("each vector must be a mapping")
        journey = _identity(vector.get("journeyId"), "journeyId", True)
        target = _identity(vector.get("targetId"), "targetId")
        wait = _identity(vector.get("waitId"), "waitId")
        identity = (journey, target)
        if identity in seen:
            raise ValueError("duplicate physical journey/target vector")
        seen.add(identity)
        # One call is one route/wait/target/mask cell. Relabeling a journey must
        # not turn a repeated physical visit into new effective support.
        if target in seen_targets or wait in seen_waits:
            raise ValueError("physical target or wait reused under another journey")
        seen_targets.add(target)
        seen_waits.add(wait)
        components = vector.get("components")
        _exact_keys(components, offsets, "components")
        durations = {}
        source_ids = set()
        for offset in offsets:
            component = components[offset]
            if not isinstance(component, Mapping):
                raise ValueError("each component must be a mapping")
            for field, expected in (("journeyId", journey), ("targetId", target),
                                    ("waitId", wait)):
                actual = _identity(component.get(field), field,
                                   field == "journeyId")
                if type(actual) is not type(expected) or actual != expected:
                    raise ValueError(f"component {field} differs from its vector")
            source = _identity(component.get("sourceId"), "sourceId")
            if source in source_ids:
                raise ValueError("distinct offsets must have distinct source IDs")
            if source in seen_sources:
                raise ValueError("physical source reused under another journey")
            source_ids.add(source)
            seen_sources.add(source)
            duration = _finite(component.get("durationSec"), "durationSec")
            if duration <= 0:
                raise ValueError("durationSec must be positive")
            durations[offset] = duration
        values.append(math.fsum(durations[j] / len(projection) for j in projection))

    # Scaling all weights by the same constant preserves the empirical law and
    # prevents underflow/overflow in the effective-count calculation.
    scale = max(admitted_weights)
    scaled = [w / scale for w in admitted_weights]
    total = math.fsum(scaled)
    normalized = [w / total for w in scaled]
    mean = _finite(math.fsum(v * w for v, w in zip(values, normalized)),
                   "joint mean duration")
    deviations = [v - mean for v in values]
    return dict(meanDuration=mean,
                q10=_quantile(deviations, .1, scaled),
                q90=_quantile(deviations, .9, scaled),
                effective=1 / math.fsum(w * w for w in normalized),
                count=len(vectors))


def wire_forecast(point_abs, low_abs, high_abs, now_s, deployed_low=None):
    """Enclose point, optionally protect early bound, then clip/round once."""
    point = _finite(point_abs, "point_abs")
    low = _finite(low_abs, "low_abs")
    high = _finite(high_abs, "high_abs")
    now = _finite(now_s, "now_s")
    if low > high:
        raise ValueError("low_abs must not exceed high_abs")
    low, high = min(low, point), max(high, point)
    if deployed_low is not None:
        protected = _finite(deployed_low, "deployed_low")
        if protected < 0:
            raise ValueError("deployed_low must be nonnegative")
        low = min(low, now + protected)

    def countdown(value):
        seconds = _finite(value - now, "countdown")
        return math.floor(max(0.0, seconds) + .5)

    return dict(eta=countdown(point), low=countdown(low), high=countdown(high))
