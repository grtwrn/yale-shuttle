# Displayed-window audit

This is a diagnostic extension of immutable window-only run35685527686,
commit379ea69. It changes no prediction, label, scope, fit or promotion gate.
All14 existing arms remain. No September21 or later outcomes are opened.
Use the production predictionWindow helper called by ArrivalDetails for the
pickup table and card. The reminder deployment did not change this formatter.

Compare every arm on the same route union changed by any hybrid, separately
for currently applied checkpoints and current live fallback. Report mean raw
and printed envelope widths with equal weight per physical visit, plus the
fraction of unchanged text, narrower/wider printed ranges, raw savings hidden
by rounding, and raw-versus-printed outcome coverage and tails. A <1 lower
endpoint is interpreted conservatively as zero; upper bounds round outward.
A missing/expired band is unavailable, never a zero-width success.

The primary comparison is at the recorded forecast instant. Fixed5/15/30second
aging sensitivities show minute-boundary effects; these are hypothetical ticks,
not additional independent observations. Omit already-arrived cases from those
sensitivities explicitly and report their counts. Preserve all labels/rows in
the immutable input; do not reassign visits or turn virtual ticks into samples.
This audits valid not-at-pickup forecast formatting, not trip selection or the
whole app. Existing raw-window gates remain; rounding cannot excuse their
failures or select a K. Fresh-date, handoff and rider-risk requirements remain.
