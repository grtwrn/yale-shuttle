"""Export the already-scored Red regression first-total comparison and its data."""
import csv
import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SERVICE = pathlib.Path(__file__).resolve().parents[3]
REPO = SERVICE.parents[1]
ARTIFACTS = SERVICE / "scripts/.eta-replay/overnight-2026-09-08/analytic/reserved-confirmation"
OUT = REPO / "docs/data"

def first_rows(arm):
    rows = [json.loads(line) for line in (ARTIFACTS / f"2026-09-08-{arm}-shared.jsonl").open()]
    return {r["id"]: r for r in rows if r["routeId"] == 3 and r["stopId"] == 11 and r["elapsedSec"] == 0}

baseline, candidate = first_rows("duration"), first_rows("stacked")
assert baseline.keys() == candidate.keys()
rows = []
for key in sorted(baseline, key=lambda k: baseline[k]["issuedAt"]):
    a, b = baseline[key], candidate[key]
    assert a["actualSec"] == b["actualSec"]
    rows.append({"episodeId": a["episodeId"], "issuedAt": a["issuedAt"], "bus": a["busKey"],
                 "actualSec": a["actualSec"], "baselineSec": a["quantilesSec"][9],
                 "candidateSec": b["quantilesSec"][9], "phaseAvailable": b["phaseAvailable"]})
OUT.mkdir(exist_ok=True)
with (OUT / "red-general-first-total-2026-09-08.csv").open("w") as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)

plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(1, 2, figsize=(9, 4.5), sharex=True, sharey=True, layout="constrained")
maximum = max(max(r["actualSec"], r["baselineSec"], r["candidateSec"]) for r in rows) / 60 + 1
for ax, field, title, color in zip(axes, ["baselineSec", "candidateSec"],
                                  ["Existing duration model", "General phase mixture"], ["#b36920", "#147d92"]):
    ax.plot([0, maximum], [0, maximum], color="#999999", linewidth=1, linestyle="--")
    ax.scatter([r["actualSec"] / 60 for r in rows], [r[field] / 60 for r in rows],
               s=43, alpha=0.8, color=color, edgecolor="white", linewidth=0.6)
    mae = sum(abs(r[field] - r["actualSec"]) for r in rows) / len(rows) / 60
    ax.set(title=f"{title}\nMean absolute error: {mae:.2f} min", xlabel="Actual total stand (min)",
           xlim=(0, maximum), ylim=(0, maximum))
    ax.grid(alpha=0.15)
axes[0].set_ylabel("Initial predicted total stand (min)")
fig.suptitle(f"Red at 344 Winchester · September 8 · {len(rows)} visits\nRetrospective component check; fit uses September 3–4", fontsize=13)
fig.savefig(OUT / "red-general-first-total-2026-09-08.png", dpi=160)
fig.savefig(OUT / "red-general-first-total-2026-09-08.svg")
print(json.dumps({"visits": len(rows), "output": str(OUT)}))
