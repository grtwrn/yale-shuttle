# Captured pickup signals and a reproducible checkpoint defect

Research only; current application, index and HEAD8aa67bdremain unchanged.

The receipt audit verified487actual watcher bus samples around five of nine
selected source visits. It confirms proximity signals can persist after
recorded departure and through a maneuver, while recording gaps and missing
server ETA snapshots prevent reconstructing the exact live disagreement.
All38unknown journeys remain; no forced board-now or broad bus switch is
supported. See RECEIPT_RESULTS.md for exact denominators and limitations.

The separate unfinished checkpoint investigation now has a concrete cause:
movement kernels are cached by rounded speed but built from the first
unrounded caller. An artifact-only rounding diagnostic restores exact
fresh-process parity for78polls/10,592rows, including both occurrences and
complete posteriors. Current code differs on1,817rows after restart, with
median differences up to21seconds and upper-bound differences up to3,768.
A tail probe explains the large change as a crossing of the existing
full-mixture threshold; no threshold was changed. See cache/RESULTS.md.

The same diagnostic changes warm predictions, so it is not a release proposal
or an ETA accuracy improvement. Independent research review and a separately
scoped all-route connected-outcome comparison are next. Existing UX pickup
and ride-recovery proposals remain on their own review paths. No watcher,
source, database, dependency, Git/publication or other-team file was changed.
