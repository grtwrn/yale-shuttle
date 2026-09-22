Investigate Orange Day's failed narrowing and audit Orange Night before deployment.
Rebuild both routes' visits from the frozen raw GPS with current detector code;
reset on gaps, route changes and contended names. Compare historical path endpoints
and route progress against rebuilt events. Independently flag provider-ID changes,
coincident names, >60s gaps, route changes and >22m/s motion inside accepted paths.
An ID change or rebuilt disagreement is a suspect record, not proof of corruption.
Re-score each K after conservatively excluding flagged training paths. Also remove
one training date at a time for K10, and decompose source-to-wait travel, wait, and
post-wait time on the same complete trips. No error-based outlier removal, no
post-hoc narrowing of intervals and no claim of a fresh holdout. Save worst paths,
identity counts, and per-date results, including losses of historical support.
