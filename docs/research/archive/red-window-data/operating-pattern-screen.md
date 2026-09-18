# Red operating-pattern screen, September 17, 2026

**Not all useful covariates have been explored. A repeating clock pattern is a new, promising lead.** The tested 15-minute phase term improves mean absolute error and the weighted interval score on all four later evaluation dates at both regulating stops. This is a retrospective component experiment, not a deployed ETA improvement or proof that drivers follow a fixed quarter-hour timetable.

The official [Yale Red route description](https://your.yale.edu/media/3096/download?inline=) describes offset departures and loop durations affected by passengers, traffic and weather. It does not specify exact departure slots. An hour-long cycle with differently offset buses can also produce a 15-minute harmonic.

## Method and limits

[Reproducible script](operating-pattern-screen.py), [all predictions and features](operating-pattern-screen.json), and [independent statistical review](operating-pattern-review.md). The read-only input is `../conditional-replay-data/outcomes.db`. No application changes, production mutations, or historical row deletions were made.

- Fit on completed visits before September 10; calibrate residual quantiles on September 10–11; evaluate September 14–17 (the last day is partial). These later dates have already been inspected in earlier research, so they are development evidence, not untouched confirmation.
- Target is the complete duration from recorded stop pin to departure, conditional on a completed stopped visit. Winchester has 102 fit / 58 calibration / 99 evaluation visits; Union has 112 / 61 / 103. This does not directly score an upstream or continually updated rider ETA.
- Fourteen predefined model arms, fixed periods and penalties, identical outcome cohorts. All arms are retained below. Missing or unsupported lap history receives a pooled fallback; 86/99 Winchester and 92/103 Union evaluation visits have supported laps. Extra features are also disabled in the fallback cases.
- Own lap uses an earlier legacy departure with a 120-second assumed availability delay and an intervening opposite-stop departure. References and coefficients use training data only. Recent residuals use only same-day visits completed and assumed confirmed before the current pin. Exact historical event-receipt times are unavailable. Training residual features are not internally cross-fitted.
- Exclude only the independently confirmed restart-truncated visit 65237 and structurally unsupported labels (incomplete, passed, gap, or unsupported pin). No duration-based or age-based outlier deletion.
- Residual quantiles are calibrated separately before evaluation. They do not establish conditional 80% coverage. This is not a remaining-wait survival model, and the pin origin differs from the live filter's broader rest origin.

## Results

All errors, widths, and scores are in seconds; lower is better. WIS rewards narrower intervals while penalizing misses, alongside point error. Width is the mean central-80% interval width.

| Added feature (above lap, except pooled) | Winchester MAE | Winchester WIS | Union MAE | Union WIS |
|---|---:|---:|---:|---:|
| Pooled stop baseline | 172.2 | 99.6 | 185.8 | 110.5 |
| Lap baseline | 107.4 | 68.4 | 129.7 | 86.0 |
| Hour of day | 109.6 | 69.3 | 128.3 | 86.4 |
| **15-minute clock phase** | **97.9** | **63.7** | **120.4** | **83.9** |
| 20-minute clock phase | 108.8 | 69.6 | 129.4 | 85.8 |
| 30-minute clock phase | 100.6 | 65.0 | 128.8 | 82.9 |
| 60-minute clock phase | 104.6 | 68.1 | 130.3 | 85.6 |
| Recent own-bus residual | 106.7 | 68.8 | 128.4 | 84.9 |
| Recent fleet residual | 109.2 | 68.9 | 128.5 | 85.4 |
| Previous opposite-stop residual | 106.4 | 67.8 | 128.6 | 85.0 |
| Time from anchor to pin | 108.0 | 69.1 | 130.0 | 86.3 |
| Lap × hour | 105.3 | 67.5 | 127.7 | 86.2 |
| Bus × hour, with bus intercepts | 110.7 | 70.4 | 132.4 | 87.5 |
| Combined recent residuals and pre-pin time | 109.2 | 69.3 | 126.3 | 83.7 |

The 15-minute arm improves MAE on each of September 14, 15, 16 and 17, respectively:

- Winchester: 2.7, 14.1, 13.7 and 7.1 seconds; WIS also improves on each date.
- Union: 8.9, 7.2, 6.8 and 17.1 seconds; WIS also improves on each date.

Widths change from 330.1 to 327.5 seconds at Winchester and 375.9 to 350.6 seconds at Union. Union p90 absolute error worsens from approximately 319 to 331 seconds, and only 78/103 Union outcomes fall inside the nominal 80% interval (75.7%), with more outcomes below the interval than above it. The feature does not fix the broad-window or calibration problem by itself. Other candidate periods are not uniformly dominated on all metrics.

## Descriptive evidence for an operating rhythm

Departure phases, measured modulo 15 minutes, remain concentrated in both fit and evaluation periods. Circular concentration R ranges from zero (no single-phase concentration) to one (all at the same phase):

| Stop | Fit R / phase | Evaluation R / phase |
|---|---|---|
| Winchester | 0.626 / +2.18 min | 0.704 / +1.97 min |
| Union | 0.722 / +0.46 min | 0.689 / +0.59 min |

These are centers of distributions, not promised departure times. Independent review confirms concentration on individual dates. An additional descriptive check finds it across several bus IDs: evaluation R ranges 0.676–0.979 at Winchester and 0.358–0.886 at Union; groups contain 6–35 visits and must not be treated as independent operating policies.

Matching earlier legacy departure records from the same bus/stop within 120 seconds also preserves the phase concentration (evaluation R 0.737 Winchester, 0.691 Union; 98 and 101 matches). Both labelers derive from the same GPS feed, so this is a label-definition sensitivity check, not independent ground truth. Legacy labels tend to occur later; their phase offsets differ. Typical same-bus departure-to-departure cycles in this sample are close to an hour, reinforcing the ambiguity between a quarter-hour release rule and offset longer cycles.

## Interpretation and next experiment

The strongest useful structures now are own-lap information and clock phase. Bus number and a smooth hour term still do not reliably explain the remaining error; neither identifies a driver or shift. Previous geometric headway tests also do not exhaust actual neighbor-arrival interactions or changing active fleet size.

The next candidate should model departure/release timing from a consistently defined causal service episode, with a small training-selected clock structure and explicit exceptions/fallbacks. Evaluate remaining wait at increasing elapsed durations, stop/pass probability, both target occurrences and complete warm ETA trajectories. Preserve forward route progress while allowing ETA uncertainty to change with new evidence.

Do not infer causality from the lap coefficient alone: `lap = pin − previousDeparture` and `hold = departure − pin` share the pin timestamp with opposite signs. A shifted pin mechanically exchanges time between the two components. Validate actual future departure and rider arrival, including forecasts made before the pin, before changing the served model.

Further useful candidates include active fleet/service-block changes, fresh tracked arrival gaps to both neighbors, nonlinear bunching/release interactions, stop/pass state, class-release periods and boarding demand. Driver/shift, dispatch and passenger-load inputs are not present in this GPS dataset. More input columns without causal availability and later-date evaluation would not establish a better model.
