// WHAT A PREVIEW SHOT MUST CONTAIN — the half of the guard that was missing.
//
// `pr-preview.mjs` already refuses to embed a view that never OPENED: PR #7
// shipped a `trip-failed.png` as if it were the feature, the operator caught
// it, and the harness gained that guard. It is necessary and it is not
// sufficient, which a real case proved on 2026-09-12:
//
//   A preview mocked a RED bus to demonstrate the trip card's new arrival
//   clock. It was shot on a SATURDAY. Red runs Mon-Fri, so the service gate
//   correctly dropped the bus, the page rendered "SHUTTLES THAT GO THERE —
//   NONE ON THE MAP YET" with every line "no bus reporting yet", and the only
//   card was Walk. Nothing errored. No view failed to open. There were no page
//   errors, nothing crashed, and `pr-preview.mjs` EXITED 0 and wrote a
//   perfectly valid screenshot of a page containing none of the feature.
//
// Only a human opening the PNG caught it. That defeats the entire purpose of
// the screenshot requirement, which is that the operator sees the FEATURE
// before approving — a green harness plus a plausible page is exactly the
// shape of evidence nobody re-checks.
//
// So a recipe may now DECLARE what the shot has to contain, and the preview
// fails when it does not, recorded the same way a never-opened view is.
//
// BACK-COMPATIBILITY IS A REQUIREMENT, not a courtesy: the feedback bot
// generates its own recipes, and a mandatory assertion would break every one
// of them. An absent `expect` therefore means exactly what it means today —
// no content check, same exit code, same files. The declaration is opt-in and
// the harness is no stricter without it.
//
// AND THE GUARD'S OWN FAILURE IS LOUD. The lesson this class of bug keeps
// teaching — #111, #123, `eta-accuracy.mjs` blind for eight days, and the
// false pass above — is that a check which finds nothing looks identical to a
// check that passed. So there are two failures here, not one:
//
//   * a pattern that was evaluated and did not match  -> the view fails;
//   * a pattern that was never evaluated AT ALL       -> the RUN fails.
//
// The second is the one that matters for trust. A recipe that expects "by
// 2:23p" on a view it never asks for, or misspells a view name, would
// otherwise pass silently while asserting nothing whatsoever.
//
// Patterns are regular expressions matched against the view's rendered
// innerText, because that is the same text the canary's own parser reads and
// the same thing a rider sees; a literal string is a valid regex, so the
// simple case needs no escaping ceremony.

/** A recipe's `expect` is optional; these are the shapes it may take. */
export const EXPECT_FORMS = "string | string[] | { <view>: string | string[] }";

/**
 * Compile `recipe.expect` against the views the run will actually shoot.
 *
 * Returns `{ rules, errors }`. `rules` carry `view: null` when they apply to
 * every view. `errors` are DECLARATION faults — a bad regex, an empty pattern,
 * a view name that is not being shot — and the caller must treat a non-empty
 * `errors` as a failed run, because none of them can be checked.
 */
export function compileExpect(expect, views = []) {
  const rules = [];
  const errors = [];
  if (expect == null) return { rules, errors };

  const add = (view, pattern) => {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      errors.push(`expect${view ? ` for view "${view}"` : ""}: pattern must be a non-empty string, got ${JSON.stringify(pattern)}`);
      return;
    }
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      errors.push(`expect${view ? ` for view "${view}"` : ""}: ${JSON.stringify(pattern)} is not a valid regular expression (${e.message})`);
      return;
    }
    rules.push({ view, source: pattern, re });
  };

  if (typeof expect === "string" || Array.isArray(expect)) {
    for (const p of [].concat(expect)) add(null, p);
  } else if (typeof expect === "object") {
    for (const [view, p] of Object.entries(expect)) {
      // A view that is never shot cannot be asserted on. Loud, because the
      // alternative is a recipe that looks like it checks something.
      if (views.length && !views.includes(view)) {
        errors.push(`expect names view "${view}", which is not in views [${views.join(", ")}] — it would never be checked`);
        continue;
      }
      for (const one of [].concat(p)) add(view, one);
    }
  } else {
    errors.push(`expect must be ${EXPECT_FORMS}, got ${typeof expect}`);
  }
  return { rules, errors };
}

/** The rules that apply to one view. */
export function rulesFor(rules, view) {
  return rules.filter((r) => r.view === null || r.view === view);
}

/**
 * Check one view's rendered text. Returns the rules that matched and the ones
 * that did not; `missing` non-empty means this view must be recorded as a
 * failure and its PNG never embedded.
 */
export function checkView(rules, view, text) {
  const body = String(text ?? "");
  const applicable = rulesFor(rules, view);
  const matched = [];
  const missing = [];
  for (const r of applicable) (r.re.test(body) ? matched : missing).push(r.source);
  return { view, matched, missing, checked: applicable.length };
}

/**
 * Rules that no view ever evaluated. This is the guard on the guard: a
 * declaration that was never checked is not a passing check, and a run with
 * one must fail as loudly as a missing feature.
 */
export function unevaluatedRules(rules, viewsChecked) {
  const seen = new Set(viewsChecked);
  return rules
    .filter((r) => (r.view === null ? seen.size === 0 : !seen.has(r.view)))
    .map((r) => r.source);
}

/** One line for the console, and the reason string a failed view records. */
export function describeMissing(view, missing) {
  return `expected content not found on "${view}": ${missing.map((m) => `/${m}/`).join(", ")}`;
}
