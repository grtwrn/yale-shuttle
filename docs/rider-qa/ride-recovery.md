# Recover a ride after tracking ends

Split from #212 following review. The bus-gone, off-bus and two-hour tracking endings previously cleared the ride without opening its recovery panel. They now retain its destination and explain why tracking stopped, with walking directions, Find another shuttle and Dismiss.

Manual Done already calls setFinishedRide on the current master; this PR preserves that caller and adds recovery actions to its panel. It does not claim the component is wholly unreachable on current master.

Find another shuttle submits a destination-only request, with no invented 0,0 origin. Its explicit recovery flag resets the time to Now and clears an old expanded option. The existing useCurrent flow requests geolocation and applies the fix when it arrives; denied/timed-out location uses the normal planner location feedback and manual entry. The explanation paragraph is the live status announcement.

Validation: 20 focused recovery/ride-end tests and full typecheck. Historical controlled screenshots are linked from #212 and cover the original recovery behavior, not the new missing-GPS wiring. No new browser verification is claimed for this revision: the Pi was already running live riders and other workloads. UI recovery does not modify automatic ending thresholds or assert physical arrival.

Separate held work: the raw five-minute pickup warning needs model-consistent evidence and a measured firing rate; automatically expanding the operator tracker needs performance review. Neither is part of this PR. The user's requested default expansion is still tracked in #212 rather than silently canceled.

Separate unresolved report: synthetic repeated-stop Green/Purple Building 800 arrival fixtures showed Get off here alongside next-lap stop-list ETAs (48/7 min). See #212 prior-browser-results.json; temporary screenshots were lost in the reboot. This is not fixed by the recovery panel or #223's sub-minute text correction.
