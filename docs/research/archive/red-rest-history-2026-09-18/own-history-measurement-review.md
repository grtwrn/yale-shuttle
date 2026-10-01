# Own stop-history measurement review

**The proposed history features are testable, but the records identify buses and observed stop duration, not drivers or discretionary breaks.** Red has two Cedar stops, and the available training examples contain very few multi-minute Cedar stops. A negative model result must not be reported as disproving the user's operational hypothesis.

This review used existing SQLite records opened read-only and the immutable `recordings.json` capture. It made no application, production, watcher, or database changes, and fitted no models. Reproduce the eight selected case audits with `python3 red-rest-history-2026-09-18/own-history-measurement-review.py`. The JSON preserves exact visit IDs, clocks, inbound leg IDs, raw movement evidence, availability checks, and source provenance.

## Cedar means two distinct Red stops

The canonical Red sequence has **117 Gilbert/Cedar at index26**, then **13 Amistad/Cedar at index27**, then **14 Amistad/Church St South at index28**, then **121 Union Station at index0**. This is the medical-campus/Union portion of the loop after the southbound Prospect stops. There is one occurrence of each ID in the current Red sequence.344 Winchester is stop11, index14.

Keep117 and13 as separate features. Stop14 is adjacent context, not a Cedar stop. Other named Cedar stops—8 (300 Cedar),10 (333 Cedar),17 (weekend Amistad/Cedar),43 (Congress/Cedar),149 (York/Cedar)—are not in the canonical Red sequence and must not be silently pooled into it. These conclusions come from the stored route and stop tables, not a guess based on similar names.

## Duration definitions and contamination

- The proposed `stand_sec` is `departed_at − arrived_at`, from the first resting plateau to the final resting plateau. It can include shuffles between those plateaus. It is neither the sum of physically motionless seconds nor proof of a driver break. `departed_at − pinned_at` includes additional approach/pinning time; legacy `dwell_sec` uses another clock. Keep these definitions explicit.
- A confirmed pass is observed short/zero duration, not missing history. For example64010 at Amistad/Cedar has a5.007second pin span but `stand_sec=0`;68017 has a15.132second pin span but `stand_sec=9.822` and is classified passed. Selecting the latest **stopped** record would skip these real more recent encounters and can pull an unrelated older long stop into the current lap.
- Missing, unresolved, gap-resolved, or demonstrated truncated durations should remain missing. Do not replace them with zero or search backward for a more convenient duration. A missing Cedar record is not evidence that the bus did not pause nearby.
-65237 is a demonstrated restart-truncated hold. Its duration must remain unavailable, while its independently observed final departure remains valid. Continuous reducer replay reconstructs the longer hold with the **same final departure instant**; exact outgoing leg60470 and raw forward movement corroborate that endpoint. Masking the duration and keeping the clock is the appropriate field-level treatment.
- A brief raw gap alone is not proof of truncation. Union64594 has a19.525second gap but a749.692second identical-coordinate plateau, matching inbound pin, and a complete long visit. Union65096 and Winchester65119 span a25.128second observation interruption yet retain their original matching inbound pin. Do not delete them merely because the interruption also caused65237's independently demonstrated error on another bus.

The collector code explicitly distinguishes the first-ever movement from the final departure candidate: `departure.ts` stores `firstMovedAt=pass.firstMovedAt`, while `confirmSec=resolvedAt−cand.movedAt`. After shuffles, `firstMovedAt+confirmSec` is not the record's actual publication time. The plan's `max(departure+120s,departure+confirmSec+15s,firstMovedAt+confirmSec)` is a reasonable conservative **proxy**, not a guaranteed upper bound with long observation gaps. Exact reconstruction needs the final candidate movement/confirmation event or a causal raw replay. All selected prior records below remain available even under the more conservative `departure+600s+confirmSec` sensitivity.

## Valid examples for contrasting hypotheses

All numbers are recorded `stand_sec` in seconds; the final column separately shows the current pin-to-departure target used by the conditional-hold model. A superscript is not used for passed stops: their short values remain visible in the table. These examples were selected for measurement review and do not estimate correlations.

| Current Winchester visit | Bus/date | Previous Winchester | Gilbert/Cedar117 | Amistad/Cedar13 | Intervening Union | Current pinned hold |
|---|---|---:|---:|---:|---:|---:|
|64318|#309 Sep17|385.1|40.1|0.0 (passed)|304.9|160.1|
|64854|#309 Sep17|160.1|44.9|4.9 (passed)|764.3|590.0|
|65347|#309 Sep17|590.0|55.0|15.0|415.2|500.1|
|68304|#300 Sep17|179.9|60.6|9.8 (passed)|35.1|285.1|
|70927|#309 Sep18|410.6|60.1|10.0 (passed)|600.0|749.9|
|58505|#308 Sep16|130.0|70.0|310.1|145.0|465.1|
|65119|#300 Sep17|257.0|69.7|235.0|165.4|660.1|

The consecutive #309 sequence contains both a short→long Winchester transition (64318→64854) and a long→long transition (64854→65347). Its long Union stop before64854 also does not eliminate the later long Winchester wait. These observations rule out a deterministic “already waited, therefore no further hold” rule. They do not rule out conditional compensation involving travel time, current clock phase, fleet spacing, passenger handling, or operating shifts.

The multi-minute Amistad/Cedar examples are real recorded waits:

-58174 (#308, Sep16) has310.051seconds recorded standing, a300.044second identical-coordinate plateau, maximum raw gap5.229seconds, and exact inbound leg53765. The next Winchester visit58505 waits465.063seconds.
-64797 (#300, Sep17) has234.998seconds recorded standing (240.001seconds pinned), a234.998second plateau, maximum raw gap5.174seconds, and exact inbound leg60029. The next Winchester visit65119 waits660.143seconds.

Each selected lap has only Red assignments and one provider bus ID in its raw records. This supports vehicle continuity for these examples, not continuity of the driver. A driver can change while the bus name/ID stays the same. Conversely, provider IDs can be reissued or changed while bus names persist; the general feature extractor must check assignment/identity continuity rather than infer a driver from either field.

## Training support is particularly thin for long Cedar pauses

Before Sep14, the stored data has163 completed Amistad/Cedar visits, only17 classified stopped and only **one** with recorded standing of at least120seconds:23155, bus#119,189.893seconds. Gilbert/Cedar has167 completed visits,144 stopped, and only **two** at least120seconds:28403 and31990, bus#309,159.956 and140.279seconds.

These are source-visit counts before the cutoff, not counts of eligible prior histories among the160 fitted Winchester episodes; actual model support may be smaller. The longer240–310second examples above are later observations. Regularization is appropriate, but weak gains or a near-zero coefficient cannot settle what happens after long Cedar breaks with so few training examples. Report support by stop, date, bus, and actual nonzero prior-duration feature.

## Checklist for the forthcoming model results

1. Match the latest own prior event at each canonical stop using information known at focal pin; retain passed encounters and missingness. Mask65237's duration without discarding its departure or choosing an older hold.
2. Keep prior Winchester hold outside the current-lap rest sum. The lap begins at its confirmed departure; Cedar117/13 and Union121 must follow it in the observed route sequence. Missing intermediate records must reduce coverage rather than become zero rest.
3. Retain route/identity-change barriers, same-day and bounded-history rules, causal confirmation proxies, and sensitivity counts. Freeze history at pin; no current hold endpoint or future rest enters an input.
4. Use one event-history likelihood per training hold, with chronological cutoff and proper right censoring. Retain the matched lap/clock and Union-age comparisons, report every prespecified arm, and preserve production fallback outside supported lap.
5. Show per-date and fixed-elapsed results, affected visits and error severity, and raw-supported versus missing-history strata. Do not interpret a coefficient as proof of a driver instruction, nor transfer a conditional-hold interval directly into a safe Division leave-by time.
6. Keep an association worth testing distinct from deployable benefit. A successful history feature still needs a continuous full-path replay covering departure recognition, forecast pooling, both pickup occurrences, and arrival/departure boarding margins.

The frozen own-history plan is consistent with these principles. No app change or further lower-bound increase is supported by this measurement audit alone.

## Additional input-quality findings during model review

The fitted cohort has two laps with multiple Union fragments: focal25064 has unresolved24861 followed by completed24868; focal60263 has unresolved59983 followed by completed60020. Both involve a provider bus ID change under the same bus name. The current-lap sum marks incomplete history, but the standalone prior-Union feature uses the newest fragment as if it were the complete previous hold.

**60020 is demonstrably incomplete.** Sep16 #308 first pauses near Union, then has a100.069second observation gap and changes provider ID66427→66453. Under the new ID it produces65 consecutive fixes at41.297872,-72.926686 spanning319.993seconds, before moving outward at13:59:25. Only then does visit60020 start, reporting4.946seconds from a brief subsequent resting plateau. There is no intervening lap. Prior visit59983 and two legacy Union arrivals are unclosed. This is strong data-quality evidence independent of the focal prediction error: preserve the focal60263, the valid final departure, and the original records, but do not call4.946seconds its whole prior Union break.

**24868 is uncertain/incomplete.** Its earlier unresolved same-stop visit24861, changed provider ID66115→66136, and older unmatched inbound pin provide a similar fragmentation signal. No local raw positions are available in this database for that Sep9 case, so an exact duration repair is unsupported. Its85.05seconds should be treated as a recorded fragment with uncertain completeness, not confidently as the entire previous stop.

These findings concern the prior-Union and combined-history interpretation. A metadata screen of all250 distinct usable prior-Winchester durations found no additional earlier unresolved/gap Winchester anchor within20minutes without an intervening Union visit.65237 was already masked. This bounded metadata check strengthens the simple prior-Winchester candidate's provenance but does not replace raw validation of every historical visit.

The newly affected focal67621 is valid: its prior Winchester67188 has640.019seconds recorded standing,130 raw fixes, a529.875second coordinate plateau, maximum gap5.218seconds, and exact inbound leg62275. Current67621 holds245.342seconds, preserves its original inbound pin (leg62713), and starts final movement4.994seconds after the departure label. Its25.478second mid-visit observation gap does not imply a lost origin. Keep the new4.524second lower-bound miss at elapsed180 in evaluation.
