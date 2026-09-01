/**
 * The anonymous id every browser-driving harness uses.
 *
 * Harnesses load the live site in a real browser, so without this they mint a
 * fresh id per run and appear in the usage numbers as riders who never come
 * back — which would drag week-1 retention toward zero for a month.
 *
 * The server seeds this id into `excluded_anon_ids` at startup, so a new
 * harness is excluded the moment it uses `seedTestId`, with no cleanup step to
 * forget. Must stay in sync with TEST_ANON_ID in src/server/actives.ts.
 */
export const TEST_ANON_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Make a Playwright context identify as the test browser. Call before the
 * first `goto`, so the app finds the id already in localStorage rather than
 * minting its own.
 */
export async function seedTestId(ctx) {
  await ctx.addInitScript((id) => {
    try {
      localStorage.setItem("shuttle-anon-id", id);
    } catch {
      /* storage unavailable — the run simply goes uncounted, which is fine */
    }
  }, TEST_ANON_ID);
}
