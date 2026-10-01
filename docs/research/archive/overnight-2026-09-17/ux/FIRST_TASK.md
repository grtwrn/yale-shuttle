# UX-01: Make class planning distinguish unknown arrival, buffer use and lateness

Status: ready for builder; no application changes made by bootstrap.

## Problem and evidence

In `web/src/ArriveBy.tsx:29`, absence of `comparison.recommendation` always renders “Your arrival is at risk.” `web/src/arriveBy.ts:20–27` withholds shuttle windows when future, stale or missing, and `journeyArrival.ts:47–51` already separates `fits`, `buffer`, `late` and `unknown`. These are different states that currently share an alarming headline. A rider should know whether to act now, allow less buffer, or wait for usable information.

The future-planning line in `TransitMap.tsx:3204–3206` also exposes “wait = ½ typical headway.” It is method jargon at the point where the rider needs to know the estimates are provisional. “When” can be confused with the nearby arrival deadline; a concise “Leave” or “Departure” label may help if verified at phone width.

## Scope

Preserve `compareDeadline` selection, every numerical window, buffer, stale gate, option ordering, displayed route/bus identity and all current calculations. Add a small presentation helper if needed to derive truthful heading/explanation from existing comparison states. Keep it separate from ETA arithmetic. Do not choose a new route or claim an on-time probability.

Suggested presentation precedence (builder must confirm against all rows):

1. A recommendation exists: retain direct walking or named-shuttle guidance.
2. No recommendation but a usable non-caution option still reaches class while using some buffer: “Your buffer may be tight,” with its concrete time visible below.
3. Every relevant alternative is missing/unknown, or unknown alternatives prevent a general conclusion: “Arrival time unavailable” / “Live shuttle times unavailable,” with a reason such as interrupted updates or planning ahead. If walking is known late, say that in its row without declaring every unseen alternative late.
4. Usable options' windows extend past class: “You may arrive after class starts.” Avoid a guarantee of missing class; a high end past class is a possible late arrival, not certainty.
5. A fast shuttle exists but catching it is uncertain: expose that specific connection caution, not a generic missing-data label or an unconditional “take this bus.”

No need to use these exact words if concise alternatives are clearer. Do not add a new card or tab. Keep walking comparison and target/deadline visible; method details belong in the existing disclosure.

Translate the future-planning helper to ordinary language, e.g. “Estimated from service hours and past trips. Check live arrivals near departure.” Verify wording accurately reflects the existing half-headway model; “past trips” may be too broad, so “Typical wait and travel times; live arrivals available near departure” is acceptable. Preserve published-hours information in an optional explanation if useful. Raise only the affected future-time controls to the existing 44 px target.

## Acceptance examples

* Fresh Red window fits buffer, safe catch: named route guidance unchanged.
* Walking fits, shuttle stale or late: “Walk now” remains available.
* Neither fits the buffer but walking reaches before class: buffer warning, not blanket late/unknown alarm.
* Only shuttle option, no live window: missing information is explicit.
* Future departure, walking would be late, shuttle unavailable: walking row says late, overall message acknowledges unknown shuttle timing.
* Fresh windows cross class start: possible late arrival wording, no numeric probability.
* Catch-risk or estimated-only shuttle: retains caution; no confident recommendation.
* Invalid/past datetime: existing inline input error stays authoritative.
* Long destination name, 360 px phone, 200% zoom: no horizontal page overflow or hidden controls.

## Validation

Read existing `arriveBy.test.ts` and add meaningful cases for any new presentation-state helper. Keep current recommendation tests passing. Run typecheck and Vite build; inspect a staged mocked page at 360 and 390 px for at least fresh-fit, buffer-only, stale and future states. Verify screen-reader order/labels and 44 px target size of touched controls. Independent reviewer must inspect the state precedence: especially unknown shuttle plus late walking, and caution-only shuttle plus a known buffer-fitting walk.

Deliver screenshots/DOM evidence, test summary, changed-file list and concise PR description to root. This is a small presentation PR, not an estimator experiment.
