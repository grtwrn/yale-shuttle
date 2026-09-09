"""Plot the fixed, paired rider-display CSV; does not fit or score new models."""
import csv
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(__file__).resolve().parents[5] / "docs/data"
NAME = "red-first-display-repaired-2026-09-08"
rows = list(csv.DictReader((OUT / f"{NAME}.csv").open()))
assert len(rows) == 25
assert all((r["routeId"], r["stopId"], r["stopIndex"]) == ("3", "11", "14") for r in rows)
actual = [float(r["actualTotalSec"]) / 60 for r in rows]
series = [
    [float(r[field]) / 60 for r in rows]
    for field in ("baselineTotalSec", "selectedTotalSec")
]
maximum = math.ceil(max(actual + series[0] + series[1]) / 5) * 5
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(1, 2, figsize=(10, 5.2), sharex=True, sharey=True)
fig.subplots_adjust(left=.09, right=.98, bottom=.20, top=.74, wspace=.12)
errors = []
for ax, predictions, title, color in zip(
    axes, series, ("Existing duration model", "General departure-phase model"), ("#b36920", "#147d92")
):
    mae = sum(abs(a - p) for a, p in zip(actual, predictions)) / len(rows)
    errors.append(mae)
    ax.plot([0, maximum], [0, maximum], color="#999999", linewidth=1, linestyle="--")
    ax.scatter(actual, predictions, s=48, alpha=.8, color=color, edgecolor="white", linewidth=.6)
    ax.set(title=f"{title}\nMean absolute error: {mae:.2f} min",
           xlabel="Actual total stand (min)", xlim=(0, maximum), ylim=(0, maximum))
    ax.grid(alpha=.15)
axes[0].set_ylabel("First recorded total-wait display (min)")
fig.suptitle("Red at 344 Winchester · September 8 · 25 visits\n"
             "Actual client replay with repaired physical standing labels", fontsize=14, y=.96)
fig.text(.5, .04, "Retrospective check; unchanged September 3–4 fit.\n"
         "First recorded display on a 30-second scoring grid; diagonal = exact prediction.",
         ha="center", fontsize=10, color="#444444")
fig.savefig(OUT / f"{NAME}.png", dpi=160)
fig.savefig(OUT / f"{NAME}.svg")
print(json.dumps({"visits": len(rows), "maeMinutes": errors, "output": str(OUT)}))
