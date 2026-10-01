# Independent review request

Review the two-file weather proposal on preserved deployed HEAD56a5258. Start REPORT.md and git diff. The prior saved-place/map/recovery release is unchanged.

Focus on native disclosure naming/expanded/controls, one-hour disabled action/Tab behavior, scroll-region keyboard access, and guarded focus when a forecast refresh removes the strip or whole bar. Check surviving focus on ordinary refresh and deliberate outside navigation. Unit control must remain a sibling; temperatures, rain wording/times, thresholds and all planner/ETA behavior are unchanged.

Reproduce with a fresh OUT under shared heavy.lock: verify.sh runs84tests/both types/Vite; browser.sh runs mobile/desktop weather and navigation/search. Completed frozen baseline evidence is retained and need not be rerun. verify-integrity.py pins the builder entry HEAD/index; after controller capture, adapt those metadata assumptions while retaining source/scope/source-map checks.

Baseline and candidate screenshots/ARIA snapshots are local fixtures, not production incidence or native assistive-technology proof. Read retained first compositor-clock assertion failure and supplemental fixture setup failures honestly. Full suite/staging/CI/publication/deploy are controller gates.
