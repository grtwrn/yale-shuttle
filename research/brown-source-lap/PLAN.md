# Brown K8 source-occurrence diagnosis, pinned before replay

Research-only causal diagnosis on the SAME archived September17–20 development
observations; no fitting, new model scoring, new dates, guard implementation or
production changes. Inputs are raw run35677536788, canonical run35684356219 and
clock diagnostic run35687958726. Preserve their bytes/hashes and existing scores.

The exact primary case is Brown19 bus#304 on September18,2026 ET:

- Retained K8 source6 State St departure09:34:02.251, before wait5 Union.
- At10:14:45 the logged Divinity47 forecast moves phase4drive→6drive and
  checkpoint→pickup-before-wait fallback.
- At10:17:15 phase6drive→5hold reactivates the SAME retained source.
- At10:30:15 a confirmed Union departure releases it under the90min arm.

Trace the complete causally observed cycle from before the09:34 source emission
through10:31, including every raw fix, provider/route identity, actual detector
anchor/pin changes, VisitState pass/transit/candidates, detector events, all
VisitEvents (including unpinned passes/unresolved outcomes), source history,
knownAt and source-specific release latches. Include source/wait/neighbour
geometry, distances, the feed's last_stop_id, and forward modular and accumulated
anchor/phase progression. Accumulation is diagnostic evidence, never silently
treated as true physical progress or fed to a model.

Prespecified adjacent comparisons: same bus#304 source6 cycle before the
10:00 Science departure and actual10:30 Union release; the frozenK8 #126 Sep17
08:28:45 source-age expiry /08:30:45 confirmed Union departure, retained source6
07:43:41.452; and the source1→wait0 case #126 Sep17 11:47:00–12:00:15 ending in
group expiry. Do not select additional favorable or failed outcomes.

Questions fixed before diagnostic results:

1. Was the newer source6 encounter a completed physical departure, an unpinned
   detector pass, an observation/identity gap, or missing reducer evidence?
   Were wait5 visits emitted, and when did each become knowable?
2. Does the retained source precede a demonstrably completed loop, or does
   nearest-stop/phase movement merely create an ambiguous apparent wrap? State
   separately what GPS geometry establishes and what the reducer infers.
3. Can source6's modulo progress reset from8 to0 without a new source departure,
   leaving K=n−1 release condition `distance(source,index)>k` impossible?
   Does a later wait hold consequently re-enable an already uncertain origin?
4. Which causal evidence is available at the FIRST uncertain poll? Can it
   justify withdrawing a source-specific occurrence without inventing a wait
   departure or waiting for later labels? A proposed guard must keep confirmed
   release irreversible and require genuinely new causal source knowledge to
   establish a new occurrence; never reset from an unpinned pass alone.

Run production stepManyWithVisits and the fixed clock policy on GitHub only.
Reproduce ALL prior Brown variant features byte-for-byte before interpreting
traces. Deleting future raw polls/predictions at the primary edges must leave
earlier traces/features byte-identical. Do not close visits at EOF. Raw source
and prior forecast/label/score hashes must remain identical. No outcome arrival
or departure may select or resolve a causal source occurrence.

Persist record-level chronological trace and concise per-case timeline. Report
missing emissions with the actual reducer reason/contract, not assumed logging
loss. Return a concrete evidence-based guard proposal and its costs/uncertainties
AFTER diagnosis; do not implement the guard or score its numeric effect here.
