"""Atom-preserving total-stand survival law used by the coherent challenger.

This is the analytic candidate's left/right quantile-knot convention with
log-survival arithmetic, so an overdue exponential tail does not underflow.
"""
import math
import numpy as np

from learned_features import LEVELS


def atom_remaining_quantiles(values, elapsed, levels=LEVELS):
    values = np.maximum(0, np.sort(np.asarray(values, dtype=float)))
    if not len(values) or not np.isfinite(values).all():
        raise ValueError('Finite nonempty quantiles required')
    xs, left, right = [], [], []
    if values[0] > 0:
        xs.append(0.)
        left.append(0.)
        right.append(0.)
    for i, value in enumerate(values):
        probability = (i + .5) / len(values)
        if xs and value == xs[-1]:
            right[-1] = probability
        else:
            xs.append(float(value))
            left.append(probability)
            right.append(probability)
    width = values[-1] - values[-2] if len(values) > 1 else 0
    hazard = min(1 / 5, max(1 / 1800, math.log(3) / width if width > 0 else 1 / 5))
    log_left = np.log1p(-np.asarray(left))
    log_right = np.log1p(-np.asarray(right))
    rest = max(0., float(elapsed))
    last = len(xs) - 1
    if rest >= xs[last]:
        # Beyond the final knot, survival conditioning is exactly memoryless.
        # Returning directly also avoids cancellation at very large rest ages.
        return -np.log1p(-np.asarray(levels)) / hazard
    index = 0
    while index < last and xs[index + 1] <= rest:
        index += 1
    if rest == xs[index]:
        log_survival = log_right[index]
    else:
        fraction = (rest - xs[index]) / (xs[index + 1] - xs[index])
        log_survival = log_right[index] + fraction * (log_left[index + 1] - log_right[index])
    result = []
    for level in levels:
        target = log_survival + math.log1p(-float(level))
        total = None
        for i in range(last + 1):
            if target >= log_left[i]:
                if i == 0:
                    total = xs[0]
                elif log_left[i] == log_right[i - 1]:
                    total = xs[i]
                else:
                    fraction = (target - log_right[i - 1]) / (log_left[i] - log_right[i - 1])
                    total = xs[i - 1] + fraction * (xs[i] - xs[i - 1])
                break
            if target >= log_right[i]:
                total = xs[i]
                break
        if total is None:
            total = xs[last] + (log_right[last] - target) / hazard
        result.append(max(0., total - rest))
    return np.asarray(result)
