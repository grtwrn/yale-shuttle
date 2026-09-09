# Standing forecast operations

Deployment requires the owner's explicit permission and must go through Git and
CI. Submitting this branch for review does not authorize a merge, production SQL,
cache publication, a machine restart, or enabling the refresh timer. The refresh
scripts below are prepared and locally tested; their timer remains disabled.

[standing-forecast-nightly.py](../services/shuttle-v2/scripts/standing-forecast-nightly.py) runs the unchanged production fitter on the local
machine. Fly serves the resulting cached model with
`SHUTTLE_STANDING_FORECAST=0`, so training cannot consume the web VM's CPU quota.
The scripts are excluded by `.dockerignore`; no runtime model code changes.

Run all commands below from `services/shuttle-v2`. The
[remote helper](../services/shuttle-v2/scripts/standing-forecast-remote.mjs),
[service](../services/shuttle-v2/scripts/standing-forecast-nightly.service), and
[timer](../services/shuttle-v2/scripts/standing-forecast-nightly.timer) are kept
beside the runner, outside the production image.

The supplied user-systemd timer starts at **00:30 America/New_York**. The cache
is installed and the single machine restarted only after fitting and validation
finish. Every publication and restart additionally requires a healthy public
endpoint, zero known buses, and a local time before 04:00. A missed timer that
catches up during the day therefore cannot restart active service.

The runner refuses overlapping executions, multiple running Fly machines,
enabled web autofitting, changed source/dependency fingerprints, a changed
deployment or ET date during fitting, future/stale fits, mismatched observation
cutoffs, and replacing a newer cached fit. The local source must match the
deployed fitting code exactly; it never pulls git or installs dependencies.

Each run creates a mode-0700 directory under
`~/.local/state/yale-standing-forecast/runs/`; files are mode 0600. The SQLite
online backup is read-only with respect to the production database. Its cutoff
is recorded before backup, and the fitter excludes later observations. Snapshot,
source, dependency, fit, publication and receipt hashes are recorded. This full
database snapshot can contain private application data: only the seven most
recent successful snapshots are retained locally. Failed local snapshots are
deleted; model files and audit receipts are retained. Only files owned by this
runner's directory/manifest convention are pruned; study archives are untouched.

Installation first exercises the real production cache loader in an isolated
in-memory database. A receipt containing the previous cache row is fsynced
before the atomic SQL transaction. Restart verification must return the expected
`standingForecast.fittedAt` with no fitting in progress. Failure after a possible
install attempts a conditional rollback; it will not overwrite a subsequently
changed cache. If installation or rollback cannot be confirmed, the remote
private audit directory is preserved for recovery, rather than deleting the
only old-row receipt. Network failure before publication leaves the old fit.
Normal model expiry still applies: after 48 hours without a usable replacement,
the application uses its existing fallback. This job does not extend stale fits.

The operator must retain an existing Fly login for this user; no credentials are
embedded in scripts or service files. Public event logs contain operation names,
timing and exit status. Raw CLI diagnostics stay in private per-run files.

## Validation without touching the live service

Run the focused tests:

```sh
npx vitest run scripts/standing-forecast-remote.test.mjs
python3 scripts/standing_forecast_nightly_test.py
python3 scripts/standing-forecast-nightly.py --dry-run
```

`--dry-run` prints the plan with zero network calls. To exercise a complete local
fit and the real cache loader using an existing read-only snapshot:

```sh
python3 scripts/standing-forecast-nightly.py --check \
  --snapshot PATH_TO_EXISTING_SNAPSHOT \
  --at RECORDED_SNAPSHOT_CUTOFF_WITH_TIMEZONE \
  --state /tmp/yale-standing-nightly-check
```

`--check` does not invoke Fly, upload files, modify the snapshot, install a cache,
or restart a machine. It requires a current-ET-day cutoff because it also checks
the real publication date guard. It cannot verify SFTP, live source parity,
restart behavior or remote permissions; the first successful scheduled run must
provide that evidence.

## Scheduler installation

Install only after the owner approves this recurring publication/restart job,
the matching model implementation is deployed through Git/CI, and web
autofitting is disabled. Run these commands from `services/shuttle-v2`.
The units use `%h` for the user's home and expect the checkout at
`~/yale-shuttle/services/shuttle-v2`. The existing local user has lingering
enabled so the timer can run without an interactive login. The Pi must be on,
have network access, and retain the user's Fly authentication. A different host
must arrange user lingering before relying on unattended runs.

```sh
systemd-analyze verify scripts/standing-forecast-nightly.service scripts/standing-forecast-nightly.timer
install -Dm0644 scripts/standing-forecast-nightly.service ~/.config/systemd/user/standing-forecast-nightly.service
install -Dm0644 scripts/standing-forecast-nightly.timer ~/.config/systemd/user/standing-forecast-nightly.timer
systemctl --user daemon-reload
systemctl --user enable --now standing-forecast-nightly.timer
systemctl --user list-timers standing-forecast-nightly.timer
```

Inspect results with `journalctl --user -u standing-forecast-nightly.service`
and the private state directory. Pause automatic runs with
`systemctl --user disable --now standing-forecast-nightly.timer`.
Do not use a daytime publication/restart as a test.

## Reintroducing migration 0017

A read-only production audit at **08:28 ET on September 9, 2026** found all three
standing-forecast tables, their supporting index on `stop_visits`, and the
original migration ledger row. The row's `created_at` is `1788928156810` and its
SQL SHA-256 is
`40eb2caa507b060f8aceacfd7b0d8e660bfc22dbddefd11cad22d0b51b667767`.
Both values and every object definition match the unchanged
`0017_standing_forecasts.sql` and journal in this branch. At observation time
there were seven pattern rows, 721 observation rows and one cached model.

Installed Drizzle 0.45.2 decides which migrations to run using the greatest
ledger `created_at`, not by comparing hashes. An older application release does
not undo a migration or delete its ledger row. With the observed matching state,
bringing the same 0017 back into committed source skips it and preserves its
data. Its bare `CREATE TABLE` statements are therefore not an obstacle here.

[Regression tests](../services/shuttle-v2/src/db/migrate.test.ts) recreate the
captured schema and ledger in disposable databases, exercise a fresh upgrade
and an already-applied upgrade, and check the missing-ledger collision. The
[audit fixture](../services/shuttle-v2/src/db/__fixtures__/standing-schema-2026-09-09.json)
contains schema and migration metadata only. These checks complement the CI
staging server's empty-database migration check.

Do not delete the ledger row or add `IF NOT EXISTS` to hide a mismatch. Removing
the row while retaining the objects would create the collision described in the
warning. Dropping the three tables alone would also leave
`stop_visits_route_bus_time_idx` behind. If the ledger or definitions change
before an approved release, inspect that new state and prepare an explicit
reconciliation; this dated audit is not permission for a production mutation.
