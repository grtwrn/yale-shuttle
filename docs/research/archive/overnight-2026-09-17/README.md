# Yale Shuttle overnight teams — September 17–18, 2026

Two persistent systemd services work through **7:30 a.m. Eastern on September 18**. Each team alternates a builder and a fresh independent reviewer; the teams run concurrently in isolated Git worktrees. The runner resumes saved work after interruption. A deployment already merged before the cutoff may finish verification afterward (up to 30 minutes).

- **ETA:** understand driver holds, bus-ahead and bus-behind progress, clock/lap/service-role interactions, and causal remaining-trip predictions. Compare against currently deployed ETA behavior; inspect regressions and retain legitimate unusual trips. Prioritize rider arrival accuracy, useful windows, and stable route choices.
- **UI/UX:** audit all 27 identified surfaces for clear, succinct, useful rider decisions, beginning with distinct unavailable/tight-buffer/late class-planning states. Verify real screens, responsive behavior, and accessibility.

Both teams keep `HANDOFF.md`, `BACKLOG.md`, `PROGRESS.md`, `CHECKPOINT.md`, and experiment/review artifacts in their own directory. `status.json` records the current role, heartbeat, round, model PID, completed research, PRs and verified deployments. A `MORNING-REPORT.json` is written when the team stops. Individual model sessions have timestamped JSONL logs and structured result JSON.

Publication requires independent approval of the exact commit and current master, passing applicable GitHub checks, no outstanding human review blockers, then the existing deployment pipeline and live health verification. The shared publication lock permits one publication at a time. A durable pending record survives a lost merge response. An unresolved merge or failed deployment halts further publication while teams can keep researching. This does not guarantee every experiment will produce a shippable improvement.

The existing `yale-shuttle-rider.service` watcher stays running. Heavy local fits/tests/builds/browser staging share one lock. The runner checks available system memory every five seconds and interrupts model work to back off below 768 MiB. A 4 GiB cgroup ceiling is also configured, but this Pi currently lacks the kernel memory controller, so that ceiling is not enforced; the active check and serialized heavy work provide the resource protection. They use the locally configured Codex model and credentials; no secrets are copied into the team configuration.

## Inspect

```sh
systemctl --user status yale-shuttle-overnight-eta.service yale-shuttle-overnight-ux.service
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/status.py
journalctl --user -u yale-shuttle-overnight-eta.service -u yale-shuttle-overnight-ux.service --since today
```

## Stop or resume

```sh
systemctl --user stop yale-shuttle-overnight-eta.service yale-shuttle-overnight-ux.service
systemctl --user start yale-shuttle-overnight-eta.service yale-shuttle-overnight-ux.service
```

Starting again before the deadline resumes preserved state. After the deadline the runner exits without starting new work. To remove startup registration afterward, disable these two units; the watcher is a separate service. Never remove a pending-publication or publication-halted record without reconciling its PR, deployment and production state.
