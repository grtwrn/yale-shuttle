# Research review: alternative-bus outcomes and integration supplement

No application diff or release is proposed. Read RESULTS.md, both frozen plans,
current-base.json, paired-source.json and verification.json.

1. Verify exact current PR291 shell extraction and the one previously declared
   diagnostic guard. All38 paired states/76 options/76 traces should equal the
   prior stored comparison. Raw bus and both-visit rows remain unchanged.
2. Verify alternate bus/source/target identities independently of the original
   focal bus, forecast errors or nearest-time matching. Check predecessor chain,
   first eligible source occurrence and target-after-pickup order.
3. Preserve all38 cases:24 before/14 after original recorded departure;32 own
   alternative outcomes and6 unresolved links. Check the six exact broken links
   and avoid bridging nearby records or treating them as removable focal errors.
4. Check second-pickup and second-destination availability independently of
   outcome availability. Only5 second destinations are both served and connected;
   do not manufacture28 missing forecast rows or call16 outcomes16 forecasts.
5. Recompute own-trip errors and the observed arrival difference in18 before-
   departure cases/3 original sources. They compare different trips; the report
   must not call203secMAE a paired ETA gain,0/32 early misses calibrated coverage,
   or pre-departure evidence a boarding guarantee. Direct walking is modeled.
6. Preserve all1400 prior outcomes, all38 original raw-current unknowns and the
   exact442.82701916224846sec earlier regression; current source and index stay clean.
7. Supplemental9Vitest tests use normal intended imports and the reviewed helper;
   inspect final virtual typechecking paths and preserved fixture/harness failures.
   UX has already ported equivalent cases; no metadata-only release or duplicate
   app change should follow this supplement.

Copy scripts to a fresh own review directory before running. Absolute app
imports/cwd stay in this checkout; relative prior evidence paths assume a
sibling directory under eta. `prepare.py` then `prepare_tests.py` regenerates
overlays, and `prepare_current_pair.py` prepares the paired wrapper. Typechecking
must hold heavy.lock. No new build/browser/fullsuite/staging/deployment is claimed.
All recording/database access is read-only. Never overwrite builder evidence.

The useful conclusion is negative: a blanket switch obtains an estimate for a
different, often much later trip. Preserve current uncertainty until a specific
causal tracking/receipt defect is demonstrated. The combined UX pickup consumer
needs its separate code review and controller release gates.
