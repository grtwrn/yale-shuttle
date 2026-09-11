# Two bunched buses, said once

The screenshots for `ui/bunched-buses-one-statement` (`web/src/bunching.ts`).

| shot | the card | which rule |
|---|---|---|
| `1-interval.png` | `Orange Night   5-18 min · 2 buses   23 min / 12:01a` | `inside-band` — the pinned bus (#49) is standing at 100 Church Street South, so slot 1 is an interval, and #51's point lands inside it. The 22:19 card. |
| `2-point.png` | `Orange Night   8 min · 2 buses   20 min / 11:57p` | `next-band-overlap` — #51 is moving and pinned, so slot 1 is a point; #49 is standing BEHIND it and its own band reaches that minute. The 22:28 card, the half the pinned-only `standCtx` could not see. |
| `3-unbunched-control.png` | `Orange Night   in 7, 8 min   …` | the control: two buses that are genuinely distinguishable still print two numbers, "in" and all. |

## How they were taken

Real bundle, real client arithmetic, phone-sized headless chromium at 390 px
against a staged server on a throwaway DB. Only `/api/buses` is mocked: route
14's own dwell/segment/pace tables from production (`route14-tables.json`) and
two buses placed on the published sequence (`scenarios.json`). A bus with
`moveTo` CREEPS along its leg between polls, because a coordinate repeated
every 5 s is — correctly — a bus the client prices as standing.

```bash
cd services/shuttle-v2 && (cd web && npx vite build)
PORT=8098 SHUTTLE_V2_DB=/tmp/stage/stage.db npx tsx src/index.ts &
BASE=http://127.0.0.1:8098 BOT_CHROMIUM_PATH=/usr/bin/chromium \
  PATCH=pr-preview/bunching/route14-tables.json BOARD=43 DEST=41 \
  SCENARIOS=pr-preview/bunching/scenarios.json ONLY=A-19,A-21,B-same-leg \
  OUT_DIR=/tmp/shots SHOTS=/tmp/shots node pr-preview/bunching/probe.mjs
```

`MEASURE=1` with `PILLS` / `TEXTS` reports each candidate string's
`scrollWidth` against the span's `clientWidth` in that same card — which is
how the wording was chosen rather than counted.

## The measurement that chose the words

390 px, 13 px Inter 500, probed in the rendered card. The span's budget is
what the route pill leaves it: **134 px** beside `Orange Night`, **128 px**
beside `Blue Weekend` (the two widest labels).

| string | needs | verdict |
|---|---|---|
| `in 23-36 min · 2 buses` | 139 px | clips beside both |
| `in 23-36 min · two buses together` | 210 px | clips |
| `in 23-36 min · another right behind` | 216 px | clips |
| `in 23-36 min · 2 due` | 125 px | fits, but "due" is jargon |
| `in 23-36 min · both` | 118 px | fits, but says nothing |
| **`23-36 min · 2 buses`** | **124 px** | **fits both — shipped** |
| `25 min · 2 buses` | 102 px | fits |
| `in 23-36, then 35 min` (today's line) | 133 px | already clips beside `Blue Weekend` |

So the head drops its `in`: it is the cheapest word to lose (the map's board
chip already prints this quantity without it) and the only way to keep the
plain noun, which is the point of the change.
