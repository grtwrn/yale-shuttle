# Exact replay runtime on the Mac observer host

Production runs Linux/x64 Node 22. The Mac observer's posterior drifted by
`5.55e-17` before any rounded output changed. On the original October 27 input,
that history produced eleven one-second wire differences and correctly halted
the trial. Both Linux CI and a local emulated Linux/x64 runtime matched all
7,969 retained single-bus diagnostic frames; both tested Mac Node versions
failed at the final frame. These are replay-consistency results, not physical
arrival or model-accuracy measurements.

`runtime-policy.json` pins the tested production image by digest and the actual
Node binary hash. The observer checks its own runtime and each producer context.
Switching executables cannot repair the rejected history: the fixture in
`learning-loop/runtime-parity.test.ts` preserves that negative control. A new
runtime freezes a fresh trial with its own training receipts and prospective
calendar, while the old failed cohort and source journals remain retained.

## Prepare the local runtime

Install `colima`, `docker`, `qemu` and `lima-additional-guestagents` with Homebrew.
Use a dedicated `yale-shuttle-eval` Colima profile: x86_64, QEMU with CPU type
`max`, 2 CPUs, 4 GiB memory, 12 GiB data disk and 8 GiB root disk. Use 9p mounts,
and `--activate=false` to preserve the user's default Docker context. Mount the
repository writable into the VM, and the archive and admin credential directory
read-only. The actual observer container mounts application source read-only
and gives write access only to its scientific evidence directory and isolated
Linux dependency volume.

Authenticate with `flyctl auth docker` and immediately pull the immutable image
declared in `runtime-policy.json`; Fly registry credentials expire quickly.
Prepare the `yale-shuttle-eval-node-modules` Docker volume by running
`npm ci --include=dev` against the unchanged service package and lockfiles in
that image. TypeScript is needed to fingerprint the import closure, although
the application image ordinarily omits dev dependencies. Do not replace this
volume while its observer is running. The source remains read-only, and no
public application process or database is started by this preparation.

The production app's hosting resources stay independent of this local VM.
No Fly machine restart or resource change is part of the observer rollout.

## Supervise and inspect

Launch `LEARNING_PUBLISH=1 python3 scripts/learning-runtime/start-host.py` from
the service directory. The existing launch agent should invoke that Python
entrypoint with the same environment and log paths. The Python parent holds
`flock` on `host-runtime.lock`, keeps the lease out of child descriptors, and
waits for the Node controller. Stale PID metadata cannot unlock a live lease.
The controller runs a single named `yale-shuttle-learning` container with the
pinned image, a 3 GiB memory limit and bounded Docker logs. The Node observer
is PID 1 in its container, and the host controller and lease parent retain
their actual Mac PIDs.

`runtime-owner.json` joins those identities to the full container ID, image,
owner label and source paths. The learning watcher checks the host process
tree, actual Docker state and `/proc/1/cmdline`; it never probes guest PID 1 as
a Mac process. Fresh status and real feed/control checks are still required.

An owned orphan container can be reattached without restarting the candidate.
Stale guest locks retire only after their original container is verified
terminal or absent. Frozen state, refusals and source journals are never
cleared by the controller. Operational lifecycle metadata rotates at 4 MiB
plus one previous file; this rotation does not touch scientific evidence.

For rollout, let the old observer exit through its existing source-change
check, verify both original host PIDs are gone, and then replace the launch
agent entrypoint. Start the new role only after required CI and runtime
qualification pass. The broader source and scientific execution change must
remain explicit in the new frozen descriptor. On rollback, keep learning held
with its evidence intact; the public app continues independently.
