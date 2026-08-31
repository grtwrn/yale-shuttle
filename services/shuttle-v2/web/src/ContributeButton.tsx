/**
 * "Contribute" — links riders to the source repository.
 *
 * Kept as its own component because it is the one piece of chrome that points
 * off-site: it needs the external-link safety attributes, its own accessible
 * name (an icon button with no text is invisible to a screen reader), and the
 * 44 px touch target this project requires, none of which should be scattered
 * into the footer's layout code.
 */

/** Where the source lives. */
export const REPO_URL = "https://github.com/grtwrn/yale-shuttle";

/**
 * GitHub's mark, inlined rather than loaded from github.com.
 *
 * A remote favicon would be a third-party request on every page load — slower,
 * blockable, and it would tell GitHub who is looking at the shuttle map. The
 * path is the standard 16×16 octicon; `currentColor` lets it inherit the
 * surrounding text colour so it works on both themes without a second asset.
 */
function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function ContributeButton() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      // noopener is the one that matters: without it the opened tab gets a
      // handle back to this one via window.opener and can navigate it away.
      rel="noopener noreferrer"
      aria-label="Contribute on GitHub (opens in a new tab)"
      title="View the source and contribute on GitHub"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        // 44 px is the project's minimum touch target; padding carries it there
        // without making the footer chrome heavy.
        minHeight: 44,
        padding: "0 14px",
        fontSize: 13,
        fontFamily: "inherit",
        color: "#546e7a",
        background: "#fff",
        border: "1px solid #bbb",
        borderRadius: 6,
        textDecoration: "none",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <GitHubMark />
      <span>Contribute</span>
    </a>
  );
}
