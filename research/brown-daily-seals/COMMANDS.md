# Daily Brown seals: concrete commands, inactive pending root review

The implementation now exists. See RESULTS.md for the exact tested source SHA,
hosted gates and limits. No real request, new-day fit, installed unit or enabled
timer was created during implementation. Publishing/enabling commands below
are proposed next actions for root review, not a claim that they ran.

## Read-only readiness and evidence

```sh
cd /home/gwarren/projects/yale-shuttle-watcher/brown-daily-seals-2026-09-22
python3 research/brown-daily-seals/controller.py inspect \
  --forecast-day 2026-09-24 --archive-root /home/gwarren/shuttle-archive
git show 6546241:research/brown-rolling-seal/RESULTS.md
gh run view 35696391115 --repo grtwrn/yale-shuttle
```

`inspect` reads small manifests/stat only, never a decoded GPS body. The
implementation manifest pins 106 source/lock/workflow/unit files. The archive
format and observed archiver source hash are also fixed. A changed archiver
requires qualification; another normalization implementation is not accepted.

## One-day launch after review, no earlier than September23 ET

The commands pin the full tested implementation SHA. Do not replace it with
an untested head.

```sh
cd /home/gwarren/projects/yale-shuttle-watcher/brown-daily-seals-2026-09-22
python3 research/brown-daily-seals/controller.py reconcile \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals
python3 research/brown-daily-seals/controller.py publish \
  --forecast-day 2026-09-24 --archive-root /home/gwarren/shuttle-archive \
  --implementation 51adecc7bc580deab59695cc1583c61ecb3bdccf \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals \
  --request-branch research/brown-daily-seals-2026-09-22
```

This freezes untouched gzip bytes and original metadata, records package
completion before request creation, creates one unique immutable request,
commits only selected packages/request and pushes this research branch. The
request push triggers `research-brown-daily-seal`, without triggering fixtures.
Both workflows use the same noncanceling concurrency group. No cutoff, arm, K,
threshold or scoring override is accepted.

The hosted workflow validates exact source/input identity, downloads the fixed
base, runs fresh full-prefix gates and then the original K5 fitting code under
the aggregate resource watchdog. Its internal command is:

```sh
python3 research/brown-daily-seals/run_daily.py \
  --request research/brown-daily-seals/requests/REQUEST_ID.json \
  --expected-request-sha256 REQUEST_SHA256
```

Do not run that command on the Pi; it requires GitHub Actions. Upload/download
verification records `publishedAt` separately from `builtAt`. The controller
accepts a catalog only after actual GitHub API receipt; earlier forecasts
cannot inherit later acceptance. Reconcile and inspect a returned run ID:

```sh
python3 research/brown-daily-seals/controller.py reconcile \
  --state-root /home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/brown-daily-seals
gh run view RUN_ID --repo grtwrn/yale-shuttle --json status,conclusion,jobs
gh api repos/grtwrn/yale-shuttle/actions/runs/RUN_ID/artifacts \
  --jq '.artifacts[] | {id,name,digest,created_at,expired}'
```

## Inactive units for review

The four `units/` files target this dedicated checkout and state directory.
The request service reads this plain, nonsecret environment file:

```ini
# /home/gwarren/.config/yale-shuttle/brown-daily-seal.env
BROWN_SEAL_IMPLEMENTATION=51adecc7bc580deab59695cc1583c61ecb3bdccf
```

After root reviews the tested source and approves activation:

```sh
mkdir -p /home/gwarren/.config/systemd/user /home/gwarren/.config/yale-shuttle
# Create the environment file above with the full reviewed SHA first.
install -m 0644 research/brown-daily-seals/units/brown-daily-seal.service \
  research/brown-daily-seals/units/brown-daily-seal.timer \
  research/brown-daily-seals/units/brown-daily-seal-status.service \
  research/brown-daily-seals/units/brown-daily-seal-status.timer \
  /home/gwarren/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now brown-daily-seal.timer brown-daily-seal-status.timer
systemctl --user list-timers brown-daily-seal.timer brown-daily-seal-status.timer
```

These commands were not executed. They depend on existing authenticated `gh`
and Git access and an available user systemd manager. No new credential or
token is created; do not put a token in the environment file. The hosted runner
validated these exact inactive calendar expressions:

- Requests: `2026-09-23..29 04,06,10:10:00 America/New_York`.
- Status only: `2026-09-23..29 17:10:00 America/New_York`.
- Both persistent, one-minute accuracy, no dates beyond this fixed range.

Each request date targets the following calendar day. Sep29 creates only the
already locked Sep30 00:00–00:30 ET context artifact. `due` permits persistent
catch-up after 04:10 on the fixed request date using its actual clock. A missed
prior date is not replayed as if attempted on time.

## Recovery and evidence limits

State is in `state.json`, immutable accepted catalogs in `catalog/`, and the
exclusive live/crash lock in `controller.lock/owner.json`. First success is
idempotent even after expiry. Unknown GitHub admission remains queued; it never
licenses a second fit.

After a crash, inspect the owner PID, state/request hashes, local Git commit
and remote run first. If a committed request was not pushed, retry the SAME
commit push and reconcile. Do not create a replacement simply because no run
is visible. Remove a stale lock only after establishing its owner is gone and
resolving any active request; the controller never steals it. Interrupted
staging/commit requires inspection, not a blind reset or input deletion. A
durable accepted catalog surviving a state-write crash keeps its acceptedAt.

Operational failure may be retried as a new immutable request with identical
input/source configuration and new actual timestamps. Any scientific halt
blocks every later new fit until review; do not use `gh run rerun` to evade it.
Missing, late and expired artifacts retain exact served fallback; yesterday's
validity is never extended. No notification, candidate activation, prospective
scoring or production change is included.
