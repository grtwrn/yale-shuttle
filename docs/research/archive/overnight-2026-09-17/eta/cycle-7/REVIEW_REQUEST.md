# Independent code review request

Review the four-file candidate summarized in RESULTS.md over preserved HEAD77c32b80256215eb36516e7bb68c9d7664c7697e. Source hashes are in evidence.json. This integrates the independently reviewed cycle6 ordered-join prototype; it does not change estimator or tracking code. Supplied HEAD already carries the separate approved pooling repair.

Check same-route/normalized-bus identity, zero priority, first-destination conservatism, folded/repeated pickups, missing/invalid timing, and separation from raw countdown/distribution. Inspect nine new app tests and actual built-SPA nonzero-walk/dwell-gate/class-deadline checks. Confirm all4,688 current-source decisions exactly match the reviewed prototype and all1,400 connected outcomes retain correct identity. Review63523's+442.83sec regression and61907; no exclusions or general accuracy/calibration claim.

Reproduction: run prepare.py, then locked verify.sh from RESULTS.md; run locked browser-extra.sh for class and final walking checks. Original failures and their corrected fixtures are disclosed in RESULTS.md. verify_evidence.py deliberately pins builder HEAD; after controller commits, independently check the new commit/base and four source hashes rather than rewriting the frozen evidence. The hash audit preserves46 original cycle6 files.

No full-suite/staging/deploy certification is claimed. Controller owns publication. Remaining38 outgoing cases,742 countdown/catchable identity differences and movement-cache determinism must remain separate. All builder processes and browsers are closed; no watcher changes or new screenshots.
