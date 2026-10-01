from pathlib import Path
import json,datetime,hashlib
O=Path(__file__).resolve().parent;E=O.parent;now=datetime.datetime.now(datetime.timezone.utc).isoformat();read=lambda n:json.loads((O/n).read_text());s=read('score.json');v=read('verification.json');m=s['metrics']['all'];r=read('rider-outcome-summary.json');a=read('alignment-verification.json');summary=read('summary.json');rank=read('ranking-state-audit.json')
stability={arm:{direction:sum(n for k,n in s['stability'].items() if k.endswith(':'+arm+':'+direction)) for direction in ['up','down']} for arm in ['current','canonical']}
rankrows={arm:next(x for x in rows if x['at']==rank['when']) for arm,rows in rank['context'].items()};rankdelay=rankrows['canonical']['priorState']['pending']['since']-rankrows['current']['priorState']['pending']['since'];assert rankdelay==5043
report=f'''# Cycle 17 — evening fleet continuation and rider decisions

**Research only; no additional estimator change is supported.** Continued the frozen current/canonical cache diagnostic from poll6000 through8999 without restarting the prefix. Across70,162 connected arrival rows, mean error changes234.831558→234.851763sec. Across4,088 identical recorded rider trips, error changes369.240206→369.112271sec. These small mixed changes do not demonstrate a useful ETA or rider-choice improvement.

## Baseline, chronology and capture

Supplied/current HEAD is56a5258bd4c6a4869667a99d3b480b12a3ce61c9. The frozen baseline is98e535b; core ETA/server/planner/arrival modules, twelve runtime imports and the complete numerical options memo are exactly unchanged at current HEAD. `PLAN.json`, `adapter-provenance.json` and `shell-head-diff.patch` record this. Application files, index and HEAD are unchanged by this round.

The two frozen bundles and matching native checkpoint6000 files were copied and SHA256-verified. Original global first-caller cache state, fleet ordering, calibration and fixed canonical-mean diagnostic remain intact. No fit, new coefficient, model search or future neighbor feature was introduced. Current release behavior including prior overnight fixes remains enabled in both arms.

The new range is2026-09-16 15:25:54.049–19:35:51.305 ET:3,000 polls/250 minute samples per arm,12 routes including evening services,1,670,421 current/1,670,415 diagnostic wire rows. No fleet gap occurred. All9,000 completed polls remain separate durable captures;11,199 of the20,199 prepared polls remain. This is reused history, not a fresh holdout. Collector clocks are reconstructed, not original publication receipts.

`capture-verification.json` verifies every new poll timestamp against saved input, ordering, sample flags, row totals, checkpoint counters, nonempty kernel caches and zero server failures. Both native checkpoint9000 files persist. Original poll5999 seeds only stability/tracking comparisons so the chunk boundary is retained; it is not rescored. No old prefix forecast or planner session was rerun.

## Arrival outcomes and uncertainty

| Metric | Current | Diagnostic |
| --- | ---: | ---: |
| Connected scored rows |70,162|70,162|
| Mean absolute error, sec |234.831558|234.851763|
| Median absolute error, sec |169.876|169.929|
| p90 absolute error, sec |533.7178|533.7098|
| WIS |162.554030|162.565363|
| Mean interval width, sec |992.702446|992.725165|
| Bus before lower bound |5,996|5,996|
| Bus after upper bound |4,287|4,286|

Both occurrences remain:48,251 first and21,911 following connected rows. They reuse1,293 source/1,609 target visits and are not independent trips. Exact structural checks traverse34,066 paths/734,613 leg uses; these counts do not certify every provisional identity.

Corrected lagged-rest attribution independently checks2,795 wire records per arm across64 bus-polls/61 prior visits, including2,790 nonzero-hop records.1,752 resolve and1,043 retain unresolved targets. No nearest-time joins, caps, exclusions or outcome-dependent label changes were added.

The new slice retains19 provisional scored zero-hop keys per arm:8different tracked-rest positions and11without an exact pin. All have identical arms. Their exploratory complementary MAE234.641299→234.661509sec has the same small worsening, but this complement is not certified or substituted for inclusive results. The previous57/58uncertainties and poll508 sign sensitivity remain unchanged in review15. Unknown minute rows, broken/skipped chains, warmup and1,083post-arrival transitions remain explicitly counted in `score.json` and separate streams.

## Tails, availability and genuine regressions

All1,771 raw interval changes over60sec remain, including unresolved and post-arrival contexts. Largest raw change is5,494sec at Green#122/poll7682, repeated physical index11(stop127): current[4193,3,5494,24] versus diagnostic[0,0,0,0]. Its historical source/target identity is unresolved; it is not a measured accuracy improvement. Full raw wires and `large-tail-changes.jsonl` preserve it.

Largest scored point regression is64sec at Blue Day#46/poll6698, following stop98: recorded remaining2690.307sec, current3257sec, diagnostic3321sec,31exact connected physical hops. Blue West#300/poll8341 retains a62sec regression at following stop98. `largest-regression-context.json` preserves all25 largest rows with source/target/leg records. Older69sec fleet,442.827sec pickup and audited Red regressions remain in original evidence; this slice does not newly certify cases outside its dates/windows.

There are38current-only/32diagnostic-only physical occurrence keys; all remain in `unpaired-arrivals.jsonl`. Row totals are not a claim that every old identity stays available. Raw negative lower bounds6101/6111 remain. Both arms have the same12backward numerical-lead event identities. Absolute-arrival jumps over60sec are current/diagnostic upward{stability['current']['up']}/{stability['canonical']['up']}, downward{stability['current']['down']}/{stability['canonical']['down']}; route-specific differences remain in `score.json`. No clipping or forward-position rule was introduced.

## Connected rider decisions

The three previously fixed sessions60836,61538,61907 begin and end wholly inside this chunk. With two destinations/two access offsets they produce12contexts/1,836paired decisions. The actual unchanged numerical shell/planner/ranker consumes each arm's saved wire.4,088selected option-polls connect to the same vehicle, pickup visit, destination visit and ride legs;2,600remain unresolved. Independent checks verify42,224ride-leg uses per arm. Walking/access is modeled, not observed boarding.

No chosen physical bus or journey availability differs. There are20pickup-metadata differences, one visible order difference, one caution difference and four synthetic point-deadline differences. All are audited in `decision-case-audit.json`:

- The four30minute flips are Brown1801→1800sec at two polls/two access offsets. All four lack a proved pickup chain; no class-arrival improvement can be inferred.
- The Blue Day#44caution flips when pickup lower bound418→426sec crosses modeled walk424.780sec. The same connected pickup/target is retained; recorded departure leaves modeled access about80sec spare in both arms. This is not observed boarding or calibrated catchability.
- The sole visible-order difference lasts one poll. Replaying all3,672saved decision rows through current ranking/visibility exactly reproduces every saved order. The diagnostic's existing30sec persistence timer starts5,043ms later; both converge at the next poll. `ranking-state-audit.json` retains the ±45sec state trace. No ranking threshold change is justified by this slice.

Matched rider mean error improves0.128sec while its median218.292→218.3345sec slightly worsens. The preceding6,000poll rider mean slightly worsened. Neither provides a useful/generalized rider gain or on-time probability.

## Executed checks and remaining work

`commands.md` lists exact commands. Locked replay and full analysis scripts finish exit0: capture, corrected scorer, actual selector, connected rider matching, decision accounting, every new lagged-origin proof, structural SQL truth, actual wire/cumulative occurrence semantics, and zero-hop inventory. Light decision-case/ranking/sensitivity audits also pass. No application tests, typecheck, Vite/browser/staging/CI/deployment were run or claimed for this empty app diff.

Two harness/reporting corrections are explicit: a pre-scoring adapter assertion caught an old canonical filename; and the copied decision verifier's inherited prose incorrectly said zero differences. Corrected note/source/output provenance is preserved; numerical assertions, actual decisions and forecasts did not change. No substantive check failure was suppressed.

Independent review should audit source/bundle provenance, native continuation, corrected identity scope, both occurrences, retained large tails and exact rider-change cases. The fixed diagnostic remains artifact-only. If further coverage is useful after review, continue9000:12000from these exact bundles and arm-matched checkpoint9000files in a sibling directory. Do not cold-start, rebuild a new baseline silently or repeat negative model screens. No code publication is requested.

All owned command sessions59606/82470/26063have completed; no owned browser/server/process/lock remains. Zero new screenshots/dependencies, no private feedback, historical DB writes, watcher changes, other-team/controller mutations or Git/publication actions. Final preservation evidence is `final-integrity.json`.
'''
# Verify summarized unmatched totals directly.
assert sum(n for k,n in s['availability'].items() if k.endswith(':current-only'))==38
assert sum(n for k,n in s['availability'].items() if k.endswith(':canonical-only'))==32
(O/'RESULTS.md').write_text(report)
commands=f'''# Exact commands and results

All commands ran in the assigned checkout; TS commands use services/shuttle-v2 as cwd. Outputs are only in `{O}`. Historical databases were opened mode=ro.

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash {O}/run.sh` — exit0;3,000new polls per arm, both checkpoint9000files saved, zero server failures.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash {O}/analyze.sh` — exit0; sequential capture/score/decisions/rider/decision/alignment/SQL/wire/zero-hop gates all pass. See individual `.log` outputs. No prefix replay.
- `python3 {O}/verify_decisions.py > {O}/decision-verification.log` — exit0 after inherited descriptive note correction; exact actual counts unchanged, original source/log/output preserved.
- `python3 {O}/audit_decision_changes.py > {O}/decision-case-audit.log` — exit0; all one order/one caution/four deadline changes accounted for.
- `./node_modules/.bin/tsx {O}/audit_ranking.mts > {O}/ranking-state-audit.log` — exit0;3,672saved rows exactly reproduce visibility, one-poll persistence delay explained.
- `python3 {O}/summarize.py > {O}/summary.log` — exit0; inclusive scores reproduce; all19uncertain keys remain, complementary sensitivity labeled; all25largest regression contexts saved.

Preparation: initial inline boundary-seed assertion exited1 on an unadapted canonical-wire filename before any scoring; corrected explicit resumed path before analysis. A diagnostic read before output creation returned nonzero and was not a verification failure. `adapter-provenance.json` records adaptations and exact current numerical memo/runtime-source parity. No app gate was run or claimed.

Final reporting/integrity commands are recorded in their own logs and final-integrity.json.
'''
(O/'commands.md').write_text(commands)
(O/'REVIEW_REQUEST.md').write_text('''# Review request — cycle17 frozen evening continuation

Research only; no app diff or publication proposal. Exact unchanged head56a5258bd4c6a4869667a99d3b480b12a3ce61c9. Read RESULTS.md, PLAN.json, adapter-provenance.json and commands.md.

Independently verify copied bundle/checkpoint hashes, parity of relevant current source against frozen98e535b, new polls6000:9000against original timestamps, checkpoint counters/cache and boundary5999stability seeding. Do not regenerate the prefix or overwrite builder outputs.

Audit the adapted cycle16scorer and physical-occurrence SQL/wire proof, especially19remaining zero-hop keys, repeated Green index11/poll7682large unresolved change,38/32unpaired keys, and retained genuine Blue Day/Blue West64/62sec regressions. Inclusive/sensitivity reporting must not imply all identities are validated. Previous57/58and poll508uncertainty remain intact.

Audit1,836paired decisions/4,088same trips and actual changed outcomes: Brown one-second unproved deadline flips, Blue Day lower-bound/walk caution crossing, and one-poll rank persistence delay. Confirm3,672rank rows reproduce without retuning. No general boarding, accuracy, on-time or calibrated-coverage claim.

Review integrity and accurately scoped tests. Initial filename preflight and inherited zero-difference prose correction are documented, with original reporting evidence retained. Nothing authorizes a production cache patch. After acceptance, optional next coverage uses the saved arm-matched checkpoint9000files into a new sibling directory for9000:12000; no new fit or repeated negative screens.
''')
(O/'RESUME.md').write_text(f'''# Resume at poll9000

Cycle17 completes3000new polls, corrected-label scoring and connected rider analysis. Do not restart first9000polls. Read RESULTS.md/REVIEW_REQUEST.md and independent review before extension. Code is unchanged; diagnostic remains artifact-only. Remaining11,199polls cover later evening and the next reused date.

Copy cycle17`current.mjs`,`canonical.mjs`,`current-checkpoint-9000.v8`,`canonical-checkpoint-9000.v8`to a new sibling own artifact directory and assert hashes against cycle17. The sibling `../cycle-14/all-route-raw-frames.jsonl`input must resolve to the same hash. Preserve all eight PLAN input hashes. Check relevant current production source parity if controller advances HEAD.

Under one shared heavy lock, run sequentially from services/shuttle-v2:

```
node --max-old-space-size=512 NEW_DIRECTORY/current.mjs current 9000 12000
node --max-old-space-size=512 NEW_DIRECTORY/canonical.mjs canonical 9000 12000
```

Use a checked script/log redirection; outputs get `ARM-resume9000`names and checkpoint12000. Do not invoke these commands inside this completed directory or rebuild bundles. Adapt scorers to explicit new filenames and verified poll8999boundary without rescoring the prefix. Preserve both physical occurrences, all unknowns/tails/availability and future session continuity. Only reuse sessions wholly inside the next chunk unless their prior planner state is explicitly reconstructed.

No process, server, browser or lock remains. All owned sessions finished. Prior58physical zero-hop uncertainties/poll508sensitivity plus new19identical-arm keys remain provisional. No source/model/threshold change is supported by the small mixed errors. The rank difference is explained by5,043ms persistence-start delay; do not retune from one poll.
''')
print(json.dumps({'report':str(O/'RESULTS.md'),'stability':stability,'rankDelayMs':rankdelay,'at':now}))
