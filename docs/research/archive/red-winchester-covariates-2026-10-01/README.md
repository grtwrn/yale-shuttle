# Red 344 Winchester covariates (2026-10-01)

Pre-registered, date-blocked screen of new covariates for Red's Winchester hold and the Division / Prospect pickup, against production. Results: [REPORT.md](REPORT.md).

| File | Role |
|---|---|
| `PLAN.json`, `FREEZE.json` | Frozen plan and the hashes of the plan and analysis code (frozen 2026-10-01 12:09:52 ET, before test-period scoring) |
| `lib.py` | Manifest-verified archive loader, production hold labels, causal covariates |
| `model.py` | Production-form departure hazard, covariate arms, scores |
| `screen.py` | Folds, fits, scoring, summary, variance decomposition (`--dev-smoke` = development days only) |
| `rider_extract.py` | Dedicated Red rider artifacts → displayed "Board in" window vs boarding, per waiting sample |
| `runner.py` | Repeatable runner: freeze and weather-input check, daily weather fetch (past hours), screen over every archived day (later days = extension folds), rider extraction. Exits non-zero on a failed step, plan drift or weather gaps |
| `WEATHER-INPUTS.json` | Hashes of the weather files the frozen run read, the daily fetch URL and the required hours |
| `screen-summary.json`, `dev-smoke-summary.json` | Frozen-run and pre-freeze development summaries |

Inputs are read-only: `/Users/grtwrn/shuttle-archive` (override with `RED_EXP_ARCHIVE`) and `…/scripts/.rider-watcher-red` (override with `RED_RIDER_SRC`). Weather is read from and fetched into `<RED_EXP_ROOT>/data/weather` (`RED_EXP_WEATHER`). Outputs go to `/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments/{results,rider}`. `RED_EXP_ROOT` moves the outputs, the Python venv (`RED_EXP_PY`) and the weather folder together; set `RED_EXP_PY` and `RED_EXP_WEATHER` too when redirecting only the outputs. The venv has numpy and scipy; nothing is installed in the repo.

Schedule: `runner.py` daily after the 03:40 ET archive; `runner.py --rider` hourly during service. Don't edit the frozen files. A changed analysis needs a new PLAN and freeze; `runner.py` reports any drift.
