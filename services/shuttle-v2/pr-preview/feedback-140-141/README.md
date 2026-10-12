# Blue overview feedback #140/#141

The October 12 reports showed Red, Walk and Brown in the initial list while
Blue was behind Show more. When the closer pickup was no longer the fastest
catchable one, the planner selected Whitney/Canner; its combined walking time
exceeded half the direct walk, so the overview excluded the whole route.

Blue now offers two independently selectable pickups on the same line:
**Prospect/Canner — Less walking** (about 2 minutes to the stop, next
catchable bus about 21 minutes away in this feed) and **Whitney/Canner — Arrive
sooner** (about 8 minutes to the stop, boarding about 7 minutes away).
The least-walking trip is the default, even when it means waiting longer.
A passing bus does not erase it. The earlier-arriving pickup remains a choice
when it saves at least three minutes and costs at least one minute more walking.

“Board in” uses the actual catchable visit, not the bus passing the close stop.
Each choice refreshes its own forecast; opening either binds the map and walking
directions to that pickup. Explicit choices stay selected after returning to the
list and polling. Changing pickups cancels the old-stop reminder. Walking-heavy
Green/Orange alternatives in this case stay under Show more.

The regression uses production feed received at **2026-10-12 13:41:07.700Z**,
2.7 seconds after report #140. The reports did not record the GPS origin;
the reproduction uses the 517 Prospect coordinates from an earlier recorded
case on the same corridor and Rosenkranz Hall as the destination. These are
controlled reproductions of the behavior, not exact replays of the rider's
unrecorded location. Map tiles are blocked in the browser check.

Validation: 3,737 tests passed; backend/frontend types and production build
passed. Type checking used the same compiler on a case-sensitive APFS volume
to match Linux import resolution. Mobile and desktop browser checks passed: both Blue choices with their own
boarding times, keyboard selection and walking directions, protection across
live updates, and cancellation of the old-stop reminder when switching. The
September transition check also preserves the explicit farther-stop choice. No page errors or horizontal overflow
were observed at 368 × 854.

- [Overview with Blue visible](overview-blue-visible.png)
- [Closest pickup](blue-close-pickup.png)
- [Earlier pickup](blue-catchable-pickup.png)
- [Browser results](browser-results.json)

Reproduce from `services/shuttle-v2` after building `web`:
`BOT_CHROMIUM_PATH=/path/to/chrome node scripts/blue-overview-feedback-check.mjs`.
