# Blue overview feedback #140/#141

The October 12 reports showed Red, Walk and Brown in the initial list while
Blue was behind Show more. When the closer pickup was no longer the fastest
catchable one, the planner selected Whitney/Canner; its combined walking time
exceeded half the direct walk, so the overview excluded the whole route.

Route visibility now retains the least walking among valid pickup/exit pairs.
The selected catchable pickup, its displayed walks, and its forecasts keep
their existing selection rules. Walking-heavy Green/Orange alternatives in
this case stay under Show more.

The regression uses production feed received at **2026-10-12 13:41:07.700Z**,
2.7 seconds after report #140. The reports did not record the GPS origin;
the reproduction uses the 517 Prospect coordinates from an earlier recorded
case on the same corridor and Rosenkranz Hall as the destination. These are
controlled reproductions of the behavior, not exact replays of the rider's
unrecorded location. Map tiles are blocked in the browser check.

Validation: 3,731 tests passed; backend/frontend types and production build
passed. Type checking used the same compiler on a case-sensitive APFS volume
to match Linux import resolution. Two mobile browser checks passed: the
initial Blue row and its catchable Whitney/Canner pickup; later pickup recovery
and protection after opening a card. No page errors or horizontal overflow
were observed at 368 × 854.

- [Overview with Blue visible](overview-blue-visible.png)
- [Catchable pickup](blue-catchable-pickup.png)
- [Browser results](browser-results.json)

Reproduce from `services/shuttle-v2` after building `web`:
`BOT_CHROMIUM_PATH=/path/to/chrome node scripts/blue-overview-feedback-check.mjs`.
