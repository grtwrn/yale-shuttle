# Next bounded work

First independently review the weather proposal using REVIEW_REQUEST.md. Current checked source/build is PR293 plus weather-only TransitMap changes and one new regression script. No additional app work from the supplemental location audit.

Remaining UX10: normal geolocation denied/unavailable/timeout recovery passed in supplemental-verified/report.json; use that final recorded result rather than rerunning the completed main weather baseline. The never-calling provider, async Enter before geocoder results and36px Swap remain separate leads, not demonstrated regressions in this proposal.

UX11 source-only leads inspected this round (no browser claim):

- `web/public/stats.html`: loading at356, login/errors at360–374 have no status/alert semantics. `retry` near1795 hides its own parent before loading, and `load()` near705 replaces dashboard content. Reproduce focused Retry→pending→success/failure and ordinary refresh before deciding a fix.
- `renderDow` near800 rebuilds weekday buttons; determine whether a60second refresh removes the focused filter or scrolls a selected older chart. Existing aria-pressed and chartParked behavior must be retained.
- Never use real credentials or rider feedback: serve local copied static assets; intercept every endpoint and use public-shaped invented stats with empty mail. Existing tester identity applies. No production auth/session/report writes.
- `web/public/about.html` is a147line standalone static page. Both Back links are native44px controls and dark-mode colors already exist. Phone/reflow/keyboard checks are still needed, but source alone supports no redesign.

An independent review or controller release should not wait for speculative new runtime changes. Preserve the exact two-file weather candidate and completed evidence. Full suite/staging/publication belongs to the controller.
