from pathlib import Path
import json,datetime
O=Path(__file__).resolve().parent;E=O.parent;read=lambda n:json.loads((O/n).read_text());s=read('score.json');v=read('verification.json');d=read('decision-summary.json');a=read('largest-case-audit.json');r=read('resume-comparison.json');now=datetime.datetime.now(datetime.timezone.utc).isoformat();m=s['metrics']['all'];c=s['counts'];worst=s['largestPointRegressions'][0]
rows=[]
for route in [1,2,3,8,9,10,15,19]:
 g=s['metrics'].get('route:'+str(route))
 if g:
  x,y=g['current'],g['canonical'];rows.append(f"| {route} | {x['n']} | {x['MAE']:.3f} → {y['MAE']:.3f} | {x['WIS']:.3f} → {y['WIS']:.3f} | {x['early']}/{x['late']} → {y['early']}/{y['late']} |")
report=f'''# Full-fleet cache diagnostic: first chronological slice

Research only. No application proposal. HEAD98e535b99649e74ca599d2e33bcfdc46df83d30d and index remain unchanged. The fixed canonical cache diagnostic changes non-Red forecasts materially; neither restart determinism nor pooled error supports publication on its own. This round finishes a bounded connected-outcome slice and saves verified continuation state.

## Scope and chronology

First6000of20199saved fleet polls,2026-09-16T11:04:43.166Z–19:25:49.204Z, across8daytime routes1/2/3/8/9/10/15/19. All original fleet order retained. Actual current ServerEta produces4002512rows; diagnostic4002532. Night routes and remaining later Red observations are outstanding. This is reused evaluation, not a fresh holdout. Collector stop/pin/lap metadata is causally reconstructed; GPS rows are original. No outcomes enter forecast generation.

PLAN.json preserves initial full-archive intent. Measured runtime required RESOURCE_AMENDMENT before any outcome scoring: first6000chronological polls. The initial own unbounded process was stopped after its timing probe; partial files prefixed initial-unbounded are retained and are not complete inputs. No prior completed experiment was rerun or historical input changed. Fixed preSep14marginals/preSep10release fit and prior causal refresh remain identical between arms; only the previously frozen kernel mean rounding differs.

## Continuation and measurement corrections

Both fresh continuations5900:6000exactly reproduce100wire/tracking polls per arm, plus8immutable full-state minute digests per arm. The research checkpoint includes the global kernel cache so the current comparator does not cold-restart differently. This verifies chunking; it is not a new production checkpoint fix. Ordinary production checkpoint canonical repeatability remains independently proved in review-round-13/immutable. RESUME.md gives the next commands.

The original cycle14mutable-reference state claim is explicitly superseded; originals preserved. This capture serializes every poll immediately and hashes structuredClone snapshots with no-future-timestamp assertions. A new early500poll harness check found that priceRoute.startChain may reanchor a standing/repositioning price relative to situation.leg. Inferring the unique pricing origin from all served hop/stop rows corrects attribution without changing forecasts. Every{c['currentRows']}current/{c['canonicalRows']}diagnostic row maps; unresolved counts are{c['currentIndexUnresolved']}/{c['canonicalIndexUnresolved']}. Repaired/repeated physical indices match database topology, including routes8/9/10. Each physical position retains both traversals; do not deduplicate stop IDs or apply Red's29-hop threshold globally.

## Connected outcomes

Primary descriptive scores use first observed poll of each UTC minute and10minute bus warmup. Exact historical leg departure/arrival/index joins preserve gaps and unobserved targets as unresolved. The score contains{c['scored']}paired forecast outcomes, {v['sources']}source visits and{v['targets']}target visits; these are strongly dependent repeated measurements. Independent verifier checks{v['connectedChains']}distinct source-target chains and{v['connectedLegUses']}leg uses. Adapter zero normalization applies only to scored bounds; all raw negatives are retained ({c.get('currentNegativeLow',0)}current/{c.get('canonicalNegativeLow',0)}diagnostic). {c.get('postArrivalTransition',0)}minute rows after recorded arrivals remain separate, not relabeled.

| Route | Paired minute rows | MAE seconds | WIS | Early/late misses |
|---|---:|---:|---:|---:|
'''+ '\n'.join(rows)+f'''

Pooled MAE{m['current']['MAE']:.3f}→{m['canonical']['MAE']:.3f}seconds and WIS{m['current']['WIS']:.3f}→{m['canonical']['WIS']:.3f}are descriptive, not validation of a coefficient or nominal coverage. Per-occurrence, passed/stopped, tails, availability and >60second jump counts are in score.json. Differential availability remains explicit in unpaired-arrivals.jsonl; no arm's failures were silently dropped.

All{a['largeBandRows']}band changes above60seconds remain in large-tail-changes.jsonl;{a['connectedNonnegative']}connect to nonnegative future outcomes,{a['postArrivalLabeled']}lie after recorded arrivals,{a['unknownTruth']}lack a truth. Largest-case-audit.json checks recorded visits/legs and surrounding raw coordinates for the top band changes and point regressions; no exclusions are justified or made. Largest retained scored point-error increase is{worst['errorIncrease']:.3f}seconds, route{worst['route']},bus{worst['bus']},source{worst['sourceId']}→target{worst['targetId']},occurrence{worst['occurrence']}. Earlier legitimate Red regressions and38pickup uncertainties remain prior evidence and are not newly certified by this earlier-day slice.

## Rider decisions

Exact current extracted numerical memo, actual planner/selectors/identity projection/ranking, previous declared stationary Red-origin geometries and allfleet transport yield{d['pairedDecisions']}paired decisions in{d['sessions']}sessions. Boarding vehicle differences:{d['boardingVehicleDifferences']}; pickup metadata differences:{d['pickupSelectionMetadataDifferences']}; visible order differences:{d['visibleOrderDifferences']}; connection caution differences:{d['cautionDifferences']}; journey availability differences:{d['journeyAvailabilityDifferences']}; synthetic15/30/45minute point-deadline differences:{d['syntheticPointDeadlineDifferences']}. Exact paired options and changes are saved. Walking and deadlines are hypothetical. These numerical-path checks are not browser verification, observed rider intent or calibrated deadline probabilities. Matching each changed chosen pickup/ride to its own complete rider outcome remains an outstanding gate.

## Reproduction and retained harness failures

From assigned worktree, all absolute commands use O={O}:

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash {O}/run.sh` — exit0; separate6000poll processes plus100poll native continuations per arm, memory bounded512MiB Node heap.
- `bash {O}/analyze.sh` — compare_resume.py,score.py and current numerical decisions.mts; exact logs retained.
- `python3 {O}/verify_score.py` — direct read-only DB/source/input/topology/aggregate verification.
- `python3 {O}/audit_tails.py` — largest-case raw/label audit; all retained.
- `python3 {O}/finish.py` — final HEAD/index/scope/artifact/screenshot-budget integrity.

Preflight baseline-only500poll scoring/verification passed14504truths,7477chains and188703leg uses. Initial occurrence assertion and its correction are preserved. Initial uncached DB verification was stopped for runtime; memoizing repeated identical queries changes no acceptance condition. Corrected verifier first exposed a missing zero Counter key in the identical-arm preflight; the failed log/source remain and `.get(...,0)` fixes reporting only. First-poll current memo probe passes3options/4traces. No app tests/types/Vite/fullsuite/browser/staging/CI/deployment or dependency installation is claimed. No screenshots added, no watcher interaction, no DB writes or source-control/publication action.

Next: independent review of occurrence matching, connected chains, tails and native continuation. Then resume frozen arms from6000through remaining chronological polls under shared lock; include night routes and later date, connect changed rider selections to their own trips, and retain all introduced regressions before considering any code proposal.
'''
(O/'RESULTS.md').write_text(report)
(O/'REVIEW_REQUEST.md').write_text('Research-only review requested; no application diff.\n\nRead RESULTS.md, PLAN.json/RESOURCE_AMENDMENT, ARTIFACT_CORRECTION.md and RESUME.md. Independently check unique pricing-origin/physical-position occurrence joins, gaps/censoring, source and target chain clocks, paired availability, large post-label tails, largest point regressions, per-route/per-occurrence score tradeoffs, current numerical rider-path scope and exact native-cache continuation. Preserve original failed preflight evidence. No restart of completed replay or extraction required unless a specific defect warrants it. No ETA accuracy, coverage or publication approval requested.\n')
summary=f"Fixed cache diagnostic evaluated on6000chronological fleet polls/eight routes, about4million arrival rows per arm. {c['scored']}connected minute outcomes have pooled MAE{m['current']['MAE']:.3f}→{m['canonical']['MAE']:.3f}s; material route-specific tails remain, largest scored point regression{worst['errorIncrease']:.3f}s. Both arms resume exactly100/100polls; state saved for remaining archive. {d['pairedDecisions']}paired extracted rider decisions assessed. Research only; no app/HEAD/index changes."
(E/'PROGRESS.md').open('a').write('\n## '+now+' — cycle15 bounded fullfleet outcome slice complete\n\n'+summary+'\n\nExact commands/results and retained harness failures in cycle15/RESULTS.md. Eight actual repaired sequences, physical-position bothoccurrences, missing chains and raw negative bounds retained. Previous38pickup unknowns and443sec regression remain separate; no model fitting, broad rule, cap, exclusion, browser or publication. Next independent research review then native continuation6000onward and changed-rider outcome attribution. No owned replay process/server/browser/lock remains; existingwatcher untouched.\n')
checkpoint=f'''# Latest checkpoint — cycle15 complete, {now}

{summary}

Read cycle15/RESULTS.md and REVIEW_REQUEST.md. Frozen actual-server capture first6000of20199polls,2026-09-16T11:04:43.166Z–19:25:49.204Z,8dayroutes1/2/3/8/9/10/15/19. No newholdout, original raw GPS/reconstructed collector metadata. Current code98e535b/releaseON/current causal calibration. Fixed kernel diagnostic remains artifact-only.

Continue using cycle15/RESUME.md and arm-matched checkpoint6000.v8/frozenbundles/inputhashes; do not cold-replay the completed prefix. Both arms100/100exact wire/tracking continuation5900:6000with8immutable full-state minute digests each. Native research checkpoint includes kernel cache. Actual repaired ring positions are in metadata and verified against database. Price origin is inferred uniquely from all served hop/stop rows, not situation/belief leg; preserve both occurrences per physical position on repeated routes. Originalcycle14mutable-state proof is superseded by reviewer13immutable; originals retained.

Outcomes:{c['scored']}truthchecks/{v['connectedChains']}distinct connected chains/{v['connectedLegUses']}leguses. All{a['largeBandRows']}large band changes and largest point regressions audited without exclusions. Missing/unpaired/tracking/tails/jumps/negativebounds files persist. Rider output is extracted current numerical path on prior selected geometries; complete changed chosen-bus outcome matching remains unfinished. Do not describe point synthetic deadlines as probabilities or claim browser verification. Remaining night routes/laterReddate require continuation. Old legitimate cases outside this slice and38pickup uncertainties remain unresolved historical evidence.

All exact commands/logs and intermediate harness failures are recorded. No app tests/typecheck/Vite/browser/staging/CI/deploy this round, no code/source-control/controller/otherteam mutation. Zero screenshots, watcher untouched. All owned replay/analyze/verification processes finished; no owned lock/server/browser. Controller owns next independent review and any eventual code scope.

Earlier checkpoints follow unchanged.

'''
p=E/'CHECKPOINT.md';p.write_text(checkpoint+p.read_text())
(E/'BACKLOG.md').open('a').write('\nRound15 task6 **[Completed first fullfleet chronological outcome slice; remainder pending]**: cycle-15/RESULTS.md. '+summary+' Preserve verified native-cache checkpoints; next independent review then6000onward,night routes/laterdate/changedrider outcomes.\n')
(E/'MORNING_SUMMARY.md').open('a').write('\n## Full-fleet cache slice — '+now+'\n\n'+summary+' The repair makes restarts repeatable, but non-Red changes can be large and still need full remaining-route/rider validation. Nothing from this research round is proposed for deployment. Evidence:cycle-15/RESULTS.md.\n')
print(summary)
