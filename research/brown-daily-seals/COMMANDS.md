# Commands for root review — inactive implementation contract

This document pins the exact intended interface. `controller.py`,
`run_daily.py`, `fixture-request.py` and `brown-daily-seal.yml` do not yet exist;
commands invoking them must wait for implementation and hosted fixture review.
No command below has launched a new fit, schedule or recording process.

## Review already sealed material now

```sh
git -C /home/gwarren/projects/yale-shuttle-watcher/brown-daily-seals-2026-09-22 show 6546241:research/brown-rolling-seal/RESULTS.md
gh run view 35696391115 --repo grtwrn/yale-shuttle
gh api repos/grtwrn/yale-shuttle/actions/runs/35696391115/artifacts --jq '.artifacts[] | {id,name,digest,expired,expires_at}'
```

## Required first implementation check (hosted, no new fit)

The synthetic fixture workflow runs on code pushes. Its reviewed invocation
must exercise the same publisher/request parser with synthetic archives and
fake clocks, plus the old Sep21 normalization control. A synthetic request
cannot switch itself to real input. Record the resulting commit and run before
substituting that exact SHA for IMPLEMENTATION_SHA in the launcher below.

## One-day launcher after gates, on September23 ET

```sh
cd /home/gwarren/projects/yale-shuttle-watcher/brown-daily-seals-2026-09-22
python3 research/brown-daily-seals/controller.py inspect \
  --forecast-day 2026-09-24 --archive-root /home/gwarren/shuttle-archive
python3 research/brown-daily-seals/controller.py publish \
  --forecast-day 2026-09-24 --archive-root /home/gwarren/shuttle-archive \
  --implementation IMPLEMENTATION_SHA \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals \
  --request-branch research/brown-daily-seals-2026-09-22
```

`inspect` reads metadata/stat only. `publish` freezes original gzip/metadata,
creates an immutable request with a unique UTC/UUID identity, and commits only
that raw package/request to the reviewed research branch; its push triggers the
hosted job. Its JSON result names requestCommit, requestSha256 and run identity
once admitted. It refuses an unreviewed code diff, unclosed training day,
changed packaged prefix, successful existing seal, active lock or scientific
halt. It cannot change dates/parameters or run the fitter on the Pi.

The hosted job runs exactly this driver contract under its aggregate resource
watchdog (one request, no date loop):

```sh
python3 research/brown-daily-seals/run_daily.py \
  --request research/brown-daily-seals/requests/REQUEST_ID.json \
  --expected-request-sha256 REQUEST_SHA256
```

This driver requires GITHUB_ACTIONS=true, validates pinned implementation/input
identity and the exact lock entry, performs the full daily gates, then builds,
verifies and publishes. `GITHUB_RUN_ATTEMPT` and true clock time remain in the
manifest/catalog. It has no cutoff, K, quality, arm, scoring or date-range flags.

## Fixed controller and status commands after root enables automation

```sh
python3 research/brown-daily-seals/controller.py due \
  --archive-root /home/gwarren/shuttle-archive \
  --implementation IMPLEMENTATION_SHA \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals \
  --request-branch research/brown-daily-seals-2026-09-22
python3 research/brown-daily-seals/controller.py reconcile \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals
```

Proposed systemd timer calendar (not installed):

```ini
[Timer]
OnCalendar=2026-09-23..29 04,06,10:10:00 America/New_York
Persistent=true
AccuracySec=1min
```

`due` accepts only these actual 2026 days/slots and the immutable schedule,
selects D=local calendar day+1, and treats Sep30 as contextOnly. It reconciles
any earlier request before publishing; successful/missing/scientific states
stay distinct. A persistent wakeup never backdates an attempt. A separate
17:10 ET status timer uses `reconcile` only. Unit/controller start remains a
root-reviewed action; these are proposed settings, not claimed active timers.

Use the concrete returned run ID for read-only monitoring:

```sh
gh run view RUN_ID --repo grtwrn/yale-shuttle --json status,conclusion,jobs
gh api repos/grtwrn/yale-shuttle/actions/runs/RUN_ID/artifacts --jq '.artifacts[] | {id,name,digest,created_at,expired}'
```

An operational retry is published as a new immutable attempt referencing the
same input/request configuration after explicit state reconciliation. No
automatic `gh run rerun` after a scientific halt, no overwritten input branch,
and no manual shell assignment to builtAt/validity. Late/unavailable forecasts
remain exact served fallback. No Slack/email/notification action is included.
