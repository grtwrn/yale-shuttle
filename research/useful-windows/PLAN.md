# Continuing useful-window research

Authorized goal: narrower rider-facing windows, little accuracy loss, and no
increase in avoidable missed-shuttle risk. Heavy work runs on GitHub hosted
runners. Do not change the Pi watcher, resource caps or launch local replays.

Baseline is master 86cb499a4e28b0577b55c19162a8d4b9f673abc5: Red K10,
Blue Day K10, Blue West K10, Orange Night K10, Gold K8, existing live estimates
elsewhere. Replay the exact production checkpoint clocks and frozen model files
on raw GPS, overlaying the contemporaneously logged live estimate. This is an
exact checkpoint-layer comparator over a recorded fallback, not a claim to
regenerate every historical live-model fit from today's server state.

First fixed experiment: condition on a confirmed ongoing major wait. Compare
(1) refitted checkpoint control, (2) remaining-wait survival, (3) survival plus
observed source-to-wait travel-time weighting with fixed 120-second bandwidth,
(4) the same with 240-second bandwidth, and (5) the 120-second arm keeping the
lower bound no later than the deployed lower bound. No arbitrary quantile
compression. Each candidate reverts to the exact deployed estimate outside the
existing qualified section, after departure, or on insufficient group support.
All downstream targets share the support/expiry decision. Historical paths must
be complete before September16, connected in GPS and use the correct route
occurrence. Filter historical hold durations against elapsed hold time only
using current causal arrival evidence; actual future hold/departure is never a
live input. Require 12 effective paths over 3 materially weighted dates.

Existing September17–20 outcomes are reused development data. This first pass
is diagnostic and cannot by itself justify production promotion. Publish every
arm, fallback and censoring count. Retain anomalous but valid trips; timestamp
agreement filtering alone already produced a misleading Orange K8 gain.

Selection and promotion must separately evaluate width, MAE, early-bound misses
(any, >30/>60/>120 seconds), late-tail misses, total coverage, false-now,
adjacent-stop ordering and handoff jumps. Candidate must narrow mean width at
least 60 seconds, worsen MAE by no more than20 seconds, retain >=80% total
coverage with <=2 percentage points loss, introduce no early miss >60 seconds,
raise overall early-miss rate by no more than1 percentage point, and introduce
no new false-now or ordering reversal >30 seconds. Check route/date/stop and
cluster by source trip/date rather than treating every poll as independent.

Action-risk replay uses hypothetical walks of1,3,5,10 minutes, common baseline
arming, point-based versus lower-bound-based leave timing, unchanged30-second
walk buffer and a30-second response-delay sensitivity. Compare against observed
arrival and observed departure separately. GPS must remain continuous through
departure. No guessed arrival+60s boarding deadline; no claim these are measured
human missed-shuttle rates. Count late-at-arming and missing guidance explicitly.
No promotion if paired actionable cohorts show additional avoidable misses.

Before promotion, require subsequent uninspected dates with at least30 physical
pickup arrivals,12 source journeys and3 service dates in the proposed route
scope. Preserve an untouched temporal check after choosing features/calibration.
Sparse routes remain on their current estimator while evidence accumulates.

Next iterations: early/late break location, upstream standing versus moving
pace, service clock/day patterns, and defensible peer spacing. Test incremental
full-arrival gains against the chosen checkpoint baseline. Improve historical
coverage monitoring so transport-complete archives cannot masquerade as full
service-day GPS. The research agent keeps this goal active across runs and logs
rejected arms as well as accepted ones; no automatic deployment from a score.
