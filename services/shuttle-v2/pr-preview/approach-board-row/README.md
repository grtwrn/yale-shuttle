# The BOARD row carries the arrival

Operator, 2026-09-11 ~13:50 ET, on a Red card with #310 standing near
344 Winchester: **"map says 1-8 but route list says 1-4."**

Both numbers were right and they are different quantities. The collapsed row
and the map bubble print the ARRIVAL at the rider's board stop; the expanded
card's approach list printed one number only — the pause chip's DEPARTURE from
the stop the bus is standing at — and never priced the rider's own stop. So the
only number in the list got compared with the row's.

The BOARD row that ends the approach now carries the row's own band
(`boardArrivalText` in `web/src/etaBand.ts`, fed the row's `leadBand` and
`busEtaLive`), and the list reads as a timeline.

| | before | after |
|---|---|---|
| collapsed row | `now-10, then 17 min` | `now-10, then 17 min` |
| map bubble | `🚌 (R) now-10 min` | `🚌 (R) now-10 min` |
| bus's own row | `🚌 344 Winchester ⏸ 3:38 · leaves in <1-7 min` | unchanged |
| **BOARD row** | `BOARD Division/Prospect` | `BOARD Division/Prospect  arrives in <1-10 min` |

Shots (390x844, deviceScaleFactor 2): `*-list.png` is the stop list clipped
from "N stops away" to GET OFF, `*-page.png` the whole expanded card.
The captures (`*-<scenario>.txt`) are the fixtures in
`scripts/canary-metrics.test.mjs`.

Taken on #237 (the countdown prints the range alone) and #240 (a standing
bus's low end is no longer floored), which is why the low end reads "now" on
the row. After "arrives in" the same quantity is a duration, so the BOARD row
spells it "<1", exactly as `standLeftText` does (`etaBand.test.ts` pins the
pair). The capture is past Red's published hours, so the last-bus warning
rides along in it — more furniture for the canary's parser to survive.

```bash
cd services/shuttle-v2 && (cd web && npx vite build)
PORT=8104 SHUTTLE_V2_DB=/tmp/stage/stage.db SHUTTLE_UPSTREAM_ETA=0 \
  SHUTTLE_ETA_SAMPLE=0 npx tsx src/index.ts &
BASE=http://127.0.0.1:8104 TAG=after OUT_DIR=/tmp/shots \
  BOT_CHROMIUM_PATH=/usr/bin/chromium node pr-preview/approach-board-row/probe.mjs
```

`scenarios.json` places #310 standing 200 s at 344 Winchester (three stops
before the board stop) and, as a control, driving one stop out with no stand
in the list; `base-patch.json` is Red's production `dwells`/`segments` tables
(copied from `pr-preview/eta-band`). Rider at Division / Prospect (48), bound
for LEPH / 60 College (72) — the operator's own trip.
