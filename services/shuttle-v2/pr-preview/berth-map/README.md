# Berth map — the evidence for `ui/berth-live-map`

Captured at 390 × 844, dSF 2, against a staged build of this branch on
`127.0.0.1:8098`, driving `?review=berth`, which renders the card's OWN
component off the real `/api/buses` payload. Reaching a berth through the app
means planning a trip that happens to board at that stop on that line, which is
ten different trips and a live fleet.

## Screenshots (`scripts/berth-map-capture.mjs`)

| | Blue Night · Wall / York (+40 m) | Red · Division / Prospect (+55 m) |
|---|---|---|
| the opening view | `bluenight-wall-york-initial.png` | `red-division-prospect-initial.png` |
| one step out — where the street names arrive | `bluenight-wall-york-zoomout.png` | `red-division-prospect-zoomout.png` |
| the app's own full map, opened with ⤢ | `bluenight-wall-york-fullscreen.png` | `red-division-prospect-fullscreen.png` |

`red-division-prospect-innertext.txt` is the page's `innerText` at 390 px — the
capture the canary fixture in `scripts/canary-metrics.test.mjs` is spliced from,
rather than a hand-written guess at what a Leaflet map prints.

## `capture.json` — the scroll trap, measured

A pannable map inside a scrolling card steals the gesture. Real CDP touch
sequences, `window.scrollY` and the map pane's own transform:

| state | `touch-action` | a 220 px swipe from the middle of the map |
|---|---|---|
| inert (as mounted) | `auto` | page scrolls **0 → 205 px**, map pane unmoved |
| armed (one tap) | `none` | map pane moves, page stays at **0** |
| after a tap outside the panel | `auto` again | disarmed |

Plus, per cell: ⤢ fills the viewport (height 844), Back is present, Escape
closes it.

## `teardown.json` — the map really goes

The whole licence for a Leaflet instance inside a card is that there is only
ever one and that it is destroyed on collapse. That is not observable from a
screenshot, and not from the source either: React calling the cleanup is one
thing, `map.remove()` having finished is another. So
`scripts/berth-teardown-check.mjs` drives two full collapse/expand cycles
through the review page's Collapse/Expand button — the same mount and
unmount `expandedKey` performs in the card — and records, after each collapse,
the `.leaflet-container` count, every request to `tile.openstreetmap.org` in the
following 5 s, and any console error; after each expand, the count again; and
the total after the second expand, which is where a leak would show as 2.

The sequence is `mount → collapse → expand → collapse → expand`, so both
collapses and both re-expands are recorded and the run ends expanded — which is
the state a leak shows in. Measured on Red at Division / Prospect, 2026-09-11:

| | cycle 1 | cycle 2 |
|---|---|---|
| `.leaflet-container` after collapse | **0** | **0** |
| tile.openstreetmap.org requests in the next 5 s | **0** | **0** |
| console errors around the collapse | **0** | **0** |
| `.leaflet-container` after the re-expand | **1** | **1** |

Total `.leaflet-container` after the second expand: **1**, not 2 — nothing
leaked. 20 tile requests over the whole run, all of them inside a mounted map's
own lifetime; zero console errors and zero page errors throughout.

Both scripts exit non-zero if any expectation misses, so a regression fails the
run rather than needing to be spotted in a picture.

## Re-running

```bash
cd services/shuttle-v2
npx vite build --config web/vite.config.ts   # or: cd web && npx vite build
PORT=8098 SHUTTLE_V2_DB=/tmp/stage.db SHUTTLE_ETA_SAMPLE=0 SHUTTLE_UPSTREAM_ETA=0 \
  npx tsx src/index.ts &
BASE=http://127.0.0.1:8098 OUT=pr-preview/berth-map BOT_CHROMIUM_PATH=/usr/bin/chromium \
  node scripts/berth-map-capture.mjs
BASE=http://127.0.0.1:8098 OUT=pr-preview/berth-map BOT_CHROMIUM_PATH=/usr/bin/chromium \
  node scripts/berth-teardown-check.mjs
```

`CELLS=` (capture) and `CELL=` (teardown) take `<stopId>-<routeId>` pairs from
`web/src/berths.ts`; the defaults are the operator's two.
