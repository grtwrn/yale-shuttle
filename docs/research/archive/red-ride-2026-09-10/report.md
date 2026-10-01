# Red rider test: Division / Prospect → Yale Public Health

September 10, 2026. One phone-sized Chromium page; excluded tester identity `00000000-0000-4000-8000-000000000000`. GPS-simulated rider following Red #310, not a physical passenger. Screenshot gallery (`screenshots.html`; historical input/reference, see publication manifest).

The ride was generally smooth and the onboard ETA was good for this observation. The waiting display and arrival experience have confirmed issues.

| Measurement | Result |
|---|---|
| First recorded wait, 9:49:44 | 11 minutes |
| Pickup observed within 45 m of Division / Prospect | 9:58:44 — actual remaining wait 8 min 59 sec |
| Ride time predicted at boarding | 13 minutes |
| LEPH / 60 College observed within 45 m | 10:11:14 — 12 min 30 sec onboard |
| Waiting point estimates, 50 samples | Mean absolute error 1.72 min; mean bias +1.36 min (too late) |
| Onboard numeric estimates before arrival, 66 samples | Mean absolute error 0.56 min |

Samples from a single trip are correlated; these are not system-wide accuracy statistics. GPS observation uses the same upstream vehicle feed, not independent physical arrival evidence. Stop arrival means within 45 m, with polling/feed timing uncertainty. The first destination forecast around 10:15 included a final walking leg, so it is not directly comparable to the 10:11 bus-stop arrival.

## Confirmed issues and evidence

1. **Get-off popup stays stale.** The undismissed popup says “Get off in 2 stops” while the banner says “Get off NEXT stop.” It persists into arrival. Screenshot (`images/2026-09-10T14-09-34-259Z-issue-popup-still-two-stops-when-next.png`; historical input/reference, see publication manifest).
2. **Next-lap ETA at arrival.** The banner says “Arriving at LEPH/60 College,” while the stop list says “55 min to your stop.” Screenshot (`images/2026-09-10T14-11-40-178Z-arrival-popup-dismissed.png`; historical input/reference, see publication manifest).
3. **Unclear waiting uncertainty.** During the layover, a headline range such as “2–10” conflicts with an unqualified 6-minute detail line and 5-minute map chip. Screenshot (`images/2026-09-10T13-55-08-809Z-issue-wait-range-versus-single-estimate.png`; historical input/reference, see publication manifest). The map-chip fix was already on master; PR #200 fixes the remaining detail line.

## Other observations

Boarding and exit stops are clearly highlighted. “I'm on it” opens a focused ride view with remaining stops and ETA. Passed stops are marked clearly. The get-off alert fired around 10:08:47, about 2 min 27 sec before GPS arrival. No uncaught JavaScript or HTTP errors were recorded during the live ride. A route-wide construction alert concerns a stop outside this ride's segment. “Done” returns to the destination picker without a final walking handoff.

## Fix tracking

All ten fixes with before/after screenshots (`fixes.html`; historical input/reference, see publication manifest).

| Cycle | PR | Fix | Status |
|---|---|---|---|
| 1 | [#192](https://github.com/grtwrn/yale-shuttle/pull/192) | Keyboard access to trip details | Merged by reviewer |
| 2 | [#194](https://github.com/grtwrn/yale-shuttle/pull/194) | Get-off prompt updates | Merged by reviewer |
| 3 | [#195](https://github.com/grtwrn/yale-shuttle/pull/195) | Arrival does not show the next lap | Merged by reviewer |
| 4 | [#196](https://github.com/grtwrn/yale-shuttle/pull/196) | Search feedback | Merged by reviewer |
| 5 | [#197](https://github.com/grtwrn/yale-shuttle/pull/197) | Keyboard editing of endpoints | Merged by reviewer |
| 6 | [#198](https://github.com/grtwrn/yale-shuttle/pull/198) | Keyboard focus in get-off alert | Merged by reviewer |
| 7 | [#199](https://github.com/grtwrn/yale-shuttle/pull/199) | Final walking handoff | Merged by reviewer |
| 8 | [#200](https://github.com/grtwrn/yale-shuttle/pull/200) | Consistent waiting uncertainty | Open for review |
| 9 | [#201](https://github.com/grtwrn/yale-shuttle/pull/201) | Restore waiting trip after refresh | Open for review |
| 10 | [#202](https://github.com/grtwrn/yale-shuttle/pull/202) | Past departure validation | Open for review |

Review feedback on [#195](https://github.com/grtwrn/yale-shuttle/pull/195#issuecomment-5623459039) was addressed with an unambiguous-stop guard and repeated-stop regression tests. The reviewer accepted and merged it. Seven of ten PRs are merged by the reviewer; #200–#202 remain open. Their latest commits all have successful CI gates. Conflicts introduced by earlier merges were resolved and verified with targeted tests and frontend builds. No outstanding review comments on the three open PRs at the final audit. The browser is closed. We did not merge or deploy.

The 33 live screenshots total about 5.74 MB. The local report, including all 20 before/after images, totals 8.31 MB of images. The capture limit was 100 MB, below the requested 2 GB maximum.
