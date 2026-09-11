# The folded berth block — evidence for `ui/berth-collapsed`

Captured at 390 × 844, dSF 2, against a staged build of this branch, driving
`?review=berth`, which renders the card's own `BerthDisclosure` off the real
`/api/buses` payload.

## Screenshots (`scripts/berth-map-capture.mjs`)

| | Red · Division / Prospect (+55 m) | Blue Night · Wall / York (+40 m) |
|---|---|---|
| **folded — what a rider meets** | `red-division-prospect-collapsed.png` | `bluenight-wall-york-collapsed.png` |
| opened | `red-division-prospect-initial.png` | `bluenight-wall-york-initial.png` |
| opened, one step out | `red-division-prospect-zoomout.png` | `bluenight-wall-york-zoomout.png` |
| the full map, via ⤢ | `red-division-prospect-fullscreen.png` | `bluenight-wall-york-fullscreen.png` |

`*-innertext-collapsed.txt` / `*-innertext-expanded.txt` are the page's
`innerText` in each state — what the canary's parser sees, and what the
fixtures in `scripts/canary-metrics.test.mjs` are spliced from.

## `row-measure.json` — why the toggle says what it says

`scripts/berth-row-measure.mjs` lays both controls out at 360 / 390 / 430 px and
reports the room left on the row. Counting characters is how a wrapping line
shipped on 2026-09-03, so these are rendered widths.

Rows are **312 / 342 / 382 px**. Control widths (max-content, including their
own padding and borders):

| | px |
|---|---|
| `🧭 Directions to published stop` | 263.9 |
| `🧭 Directions to stop` | 181.6 |
| `⚠ Stops 55 m past the published stop ▾` | 309.4 |
| `⚠ 55 m past the stop ▾` | 186.9 |
| `⚠ Stop is 55 m past ▾` | 176.5 |
| `⚠ Stops 55 m past ▾` | 167.5 |
| `⚠ 55 m past ▾` | 121.4 |
| `⚠ 55 m ▾` | 84.8 |

So the **long** button plus *any* warning that names the distance needs 385 px
or more and cannot share a 342 px row — not even `⚠ 55 m ▾`, which needs 356.7.
The **short** button plus `⚠ 55 m past ▾` needs **311.0 px** and shares one row
at all three widths, with 1.0 / 31.0 / 71.0 px to spare.

That is why the button's words follow the fold, which is the operator's own
rule applied to a screen that now has two states: *"the directions to stop
button should now say directions to published stop **since we show two**"*
(2026-09-11). Folded, one stop is on the card and the chip warns about the
other, so the button names it plainly. Opened, the map shows two — both
labelled — and the button says which one it points at; the row is then 393 px
and the chip drops to a second line, above a 200 px map where that costs
nothing.

Measured, on the shipped wording:

| width | folded | opened |
|---|---|---|
| 360 px | 311.0 of 312 — **one row** | 583.9 — wraps |
| 390 px | 326.0 of 342 — **one row** | 613.9 — wraps |
| 430 px | 346.0 of 382 — **one row** | 653.9 — wraps |

(The folded totals grow with the row because the chip is allowed to grow beside
the button; what decides the wrap is the 311.0 px of base widths.) The script
fails on a **clipped** control, and on a folded row that wraps at 390 px or
above — wrapping below 360 px is the deliberate fallback.

## `teardown.json` — folded really means no map

`scripts/berth-teardown-check.mjs` now has one more thing to check, and it is
the point of this PR: an expanded card whose fold is **shut** carries no
Leaflet instance at all.

- `.leaflet-container` with the card expanded and the fold shut: **0**
- then, over two full collapse/expand cycles of the card (each opening the fold
  again): after each collapse **0** containers, **0** requests to
  `tile.openstreetmap.org` in the next 5 s, **0** console errors; after each
  re-expand **1**; total after the second expand **1**, not 2.

## `capture.json` — the scroll trap still holds

Unchanged from #221 and re-measured here with real CDP touch sequences: inert,
`touch-action: auto` and a swipe from the middle of the map scrolls the page
0 → 205 px with the map pane unmoved; armed, `touch-action: none`, the pane
moves and the page stays at 0; a tap outside the panel disarms it.

## Re-running

```bash
cd services/shuttle-v2 && (cd web && npx vite build)
PORT=8101 SHUTTLE_V2_DB=/tmp/stage.db SHUTTLE_ETA_SAMPLE=0 SHUTTLE_UPSTREAM_ETA=0 \
  npx tsx src/index.ts &
for s in berth-map-capture berth-teardown-check berth-row-measure; do
  BASE=http://127.0.0.1:8101 OUT=pr-preview/berth-collapsed \
    BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/$s.mjs
done
```

`CELLS=` / `CELL=` take `<stopId>-<routeId>` pairs from `web/src/berths.ts`.
