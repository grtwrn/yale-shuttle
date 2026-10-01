# Independent overnight runner review

Reviewed September 17, 2026, about 22:18 Eastern. **No remaining launch blocker found in the reviewed runner and installed service configuration.** This approves starting the two authorized teams; it does not assert that an overnight candidate has passed its later review, CI, or deployment gates.

Reviewed runner SHA-256: `f1908435f3e641e12ddc722c0fccfb2e38887dfde6f4f4ba90c9e7e5ad10617d`.

## Findings resolved before launch

- **Stop/deadline race:** stopping after CI or external-review inspection previously still allowed the merge call. A final stop/deadline check now runs immediately before the durable merge intent and RPC. Both boundary tests pass.
- **Cross-team interruption during publication:** a durable shared pending record is now written before the merge request. Either team reconciles it under the shared publication lock, verifies the recorded head and acknowledged merge SHA, and completes deployment verification before another publication. An ambiguous merge response stops publication for manager inspection. Tests cover a lost response, changed head/SHA, and preserving the originating team's identity.
- **Deployment failure trapping research:** terminal verification failure records a publication halt and permits subsequent local research/review without allowing further merges. A regression test verifies recovery does not remain stuck retrying an already failed deployment.
- **Branch-setup crash:** dying after branch creation but before saving builder state previously produced an endless “branch already exists” retry. Round preparation now saves durable intent first, then reconciles the expected branch at its recorded base. A real temporary Git repository test interrupts precisely at that point, reloads controller state, and resumes without deleting work. Unexpected commits are preserved for inspection.
- **Review/CI boundaries:** review approval must name the exact head and base, contain no blocking findings, and include successful tests for app changes. Reviewer content changes are detected even when Git's status letter is unchanged. Required checks must actually exist and succeed; a skipped required check cannot satisfy the gate. Latest retry results supersede older failures. Latest external review per author and unresolved threads are checked.

## Verification

`python3 -m unittest discover -s overnight-2026-09-17 -p '*test*.py' -v` passed **20 tests**: 16 independent adversarial tests and four controller tests. Evidence: `independent-tests-final.log`; independent source: `team_runner_test.py`. Tests use mocks and temporary local Git repositories; they did not invoke Codex, GitHub, Fly, or production mutations.

Inspected both installed user service units and the shared slice; all three match their artifact copies byte-for-byte. They use distinct verified Git worktrees, `Restart=on-failure`, a 30-second restart delay, `KillMode=control-group`, a 30-second stop timeout, and the explicit September 18 **07:30 Eastern** cutoff. The shared slice configures a 4 GiB memory ceiling and 384-task limit; numerical workers are limited. **Subsequent live inspection established that this Pi has no memory cgroup controller, so the memory ceiling is not enforced; see the reviewed correction below.** The controller additionally uses a per-team singleton lock, serialized publication, bounded role duration/output, saved progress, and a shared heavy-work lock in both role instructions. `/usr/bin/python` exists. Parent independently reported successful `systemd-analyze --user verify`; my sandboxed invocation could not access the user manager (`SO_PASSCRED: Operation not permitted`), so I do not claim an independent successful manager validation.

The role briefs preserve the existing watcher, prohibit other-team/controller/credential mutations and nested model sessions, require separate dependencies, and explicitly forbid future neighbor trajectories and reuse of inspected data as a fresh holdout. The fresh builder/reviewer contexts use structured output and saved artifacts, consistent with the locally checked CLI and [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Operating limits

- Model subprocesses use `danger-full-access`. Worktree ownership, credential restrictions, and the heavy-work lock are instructions plus publication checks, **not an OS security boundary**. Fresh review and exact-content checks are meaningful controls, not proof that arbitrary model commands are confined.
- The publication lock coordinates these two teams. An unrelated publisher would need the same coordination or repository-side up-to-date enforcement; the immediate master recheck and expected-head merge request cannot make an external base change atomic.
- A deployment merged before the deadline may finish verification afterward. An ambiguous merge or failed deployment requires manager reconciliation; do not remove its marker to force progress. After the cutoff, starting the service will not begin new work.
- These tests establish the reviewed control behavior, not live end-to-end success. The parent owns launch and should confirm both service heartbeats and initial role logs. No service was launched and no app or production data was changed by this review.

## Live-memory correction reviewed after initial launch

Confirmed `/sys/fs/cgroup/cgroup.controllers` contains `cpuset cpu io pids`, without `memory`. The updated runner checks Linux `MemAvailable` before starting each model and on each five-second monitor poll. Below 768 MiB it terminates the model process group, waits up to 15 seconds, escalates to `SIGKILL` if necessary, and enters the existing retry/backoff path while preserving work. Available memory must recover before another model can start. The README now distinguishes this reactive guard from the configured but unenforced kernel ceiling.

Review found that an exception reading memory during monitoring could initially clear the active-process pointer without killing the worker. The final cleanup now terminates/reaps any still-live model before clearing its pointer, including on monitor errors. This avoids retrying alongside the forgotten model.

Added four focused tests: exact available-memory threshold and missing-field behavior; preflight refusal followed by successful resumption; low-memory TERM-to-KILL escalation with checkpoint preservation; and monitor-read failure cleanup. **All 24 combined tests pass**, including the original publication/restart tests. Log: `independent-tests-memory-initial.log` (the parent's cleanup fix was already present when these tests ran). Tests mock process signals and memory readings; they did not induce actual host memory pressure or alter running services.

Updated runner SHA-256: `be5767c88a1f34e03ba0309e9c54c1ee51def676e22cdb1e0d1842db73b41b5d`. No remaining blocker found in this delta. This remains a best-effort, system-wide pressure response: a five-second polling interval cannot guarantee protection against rapid allocation, and process-group signals alone do not guarantee cleanup of descendants that detach into other groups. The service's control-group termination still applies when the parent restarts or stops that service.
