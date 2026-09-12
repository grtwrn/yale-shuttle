# The Green fold: a rest attached to the wrong occurrence (2026-09-12)

Harnesses for the case in `docs/eta-ring-posterior.md`, "Green: a rest on the
fold was attached to the wrong occurrence". The operator reported it live as
"green just flicked from 22 to 34 minutes as I was watching"; the flick was the
app recovering, and the eight minutes before it were the defect.

**`predictions_log` held zero rider-surface rows for route 9 that day**, so
there is no server-side record of what the screen said. The replay against
captured payloads IS the record, which is why these four scripts exist and why
they read real `/api/buses` bodies rather than reconstructions.

| script | what it answers |
|---|---|
| `greenlurch.ts` | replays the client over captured `/api/buses` payloads and prints each stop's shown string per poll |
| `greenwarm.ts` | the same, but with the belief tracked warm from an earlier poll, so a stand is entered with history rather than cold |
| `greenring.ts` | prints the repaired ring beside the published list — where the two orders disagree, and which slots repeat |
| `greenmass.ts` | dumps per-leg belief mass and `restStop` per poll: the five-leg jump at 10:16:28 is visible here and nowhere else |

## Reading them

Both arms need a payload capture; a 10 s cadence is enough to see the jump (it
happens inside one poll). `raw_positions` is swept at 6 h, so capture the
positions the same day or the ground truth is gone — take the arrivals from
`arrivals` / `stop_visits`, which outlive it.

The two conclusions to preserve, because each cost a wrong first guess:

- **It is not a cold-start artifact.** The cold arm on the real captured
  payloads shows the same `restStop 18` through the whole stand, then +327..+438 s
  on all 20 stops at once. Warm and cold agree.
- **It is not the ratchet misbehaving.** The ratchet held 0.994 correctly; it
  was handed the wrong occurrence to hold. Fixing the ratchet would hide the
  mis-attribution, not correct it.
