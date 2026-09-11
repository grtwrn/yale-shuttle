# The countdown's band, with its median

Screenshots for `eta/calibrated-range` (`web/src/etaBand.ts`, `fmtBusBand`),
390 px, real bundle, staged server on a throwaway DB with Red's production
tables (`base-patch.json`) and two buses placed on the published sequence
(`scenarios.json`); rider at Division / Prospect, bound for LEPH / 60 College.

| shot | the card | what it shows |
|---|---|---|
| `moving-toward-layover.png` | `Red   12 (6-20) min · 2 buses   25 min / 9:38a` | #304 driving toward the 344 Winchester layover — a range while MOVING, the operator's first ask; #316 behind it inside the band, so bunching.ts folds the pair |
| `standing-at-layover.png` | `Red   in 4 (2-10), 17 min   17 min / 10:59a` | #304 standing at 344 Winchester: the median beside the band, the second bus apart; the low end is floored at departNow + the shortest stand left (`standingLowFloor`), the low end today's card printed |
| `moving-no-layover-ahead.png` | `Red   in <1, 20 min` | a band under 3 printed minutes prints as the point it is — byte-identical to before |

The map's board chip prints the same three numbers ("4 (2-10) min").

```bash
cd services/shuttle-v2 && (cd web && npx vite build)
PORT=8099 SHUTTLE_V2_DB=/tmp/stage/stage.db npx tsx src/index.ts &
BASE=http://127.0.0.1:8099 BOT_CHROMIUM_PATH=/usr/bin/chromium \
  PATCH=pr-preview/eta-band/base-patch.json BOARD=48 DEST=72 \
  SCENARIOS=pr-preview/eta-band/scenarios.json OUT_DIR=/tmp/shots SHOTS=/tmp/shots \
  MEASURE=1 PILLS='["Orange Night","Blue Weekend","Red"]' TEXTS=pr-preview/eta-band/texts.json \
  node pr-preview/eta-band/probe.mjs
```

The width table that chose the wording is in `docs/eta-band.md` §C.
