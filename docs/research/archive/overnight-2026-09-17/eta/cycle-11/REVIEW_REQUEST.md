# Review request: executable ETA pickup projection

Requested verdict is research acceptance or concrete correction, not release
approval. No application diff exists. A three-file ETA patch and its built
artifact are ready for the next combined UX integration; do not publish an
unused metadata-only half.

Read RESULTS.md, INTEGRATION.md, PLAN.json and overlay.json. Independently check:

1. The helper receives actual per-option selected rows; no trace scanner,
   second selector, target lookup, future observation or re-pricing is used.
2. Relation uses normalized bus/stop/hops within one selection. Same vehicle
   on a later occurrence stays distinct even when ETA values match; relative
   hops are not a persistent ID. Missing destinations do not erase a choice.
3. Raw evidence stays raw, even without any compatible current forecast.
   The original 38 unresolved cases remain unknown. Walking caution and
   the existing pinned walking tolerance remain unchanged.
4. The optional object clears on stale, departed/null, walk and future paths.
   Repeated polls do not persist it into saved plans or active rides.
5. Reproduce exact numerical/trace/ranking parity and metadata matches on
   9,376 paired states; 100 heterogeneous option batches agree with single
   evaluations. Preserve both occurrences and all 1,400 connected outcomes,
   including the exact 442.827-second earlier regression.
6. Compiler/Vite source overlays correspond exactly to the applicable patch;
   verify all 82 built source modules. No app source or original dist changed.
   Latest local origin/master numerical parity is separately recorded; newer
   UX presentation was not rebuilt here.
7. Twelve-state mobile and desktop checks use the real compiled application
   with tester identity and fully intercepted traffic. Existing display defects
   intentionally persist pending UX work. All browser resources close.
8. Review all preserved fixture/harness failures and the distinction between
   passing virtual compilation and unrun normal release gates. No new score,
   holdout, catchability guarantee or observed outage rate is claimed.

Absolute executed commands are in RESULTS. Copy scripts/artifacts to a new
review directory before rerunning, then run prepare.py there to regenerate
its output/overlay paths; baseline imports remain the frozen cycle10 source.
Do not overwrite builder evidence or silently update its pinned baseline.
Keep the controller's app/source-control/publication ownership unchanged.

Next action after acceptance is the coordinated consumer implementation, not
another census or model search. Contract and source are now concrete; preserve
current numerical semantics and manually boarded physical-vehicle identity.
