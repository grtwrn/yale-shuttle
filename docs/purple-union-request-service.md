Purple service at Union Station requires a Dispatch request beginning at noon
Eastern Time, according to Yale's current
[West Campus Shuttle page](https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/west-campus-shuttle).
Yale's [Shuttle Contact page](https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/contact-us)
lists Dispatch at 203-281-5470, option 1. Both pages were checked on October 23,
2026. The rule applies to Purple at Union Station; ordinary service on other
lines and at other Purple stops retains its existing behavior.

The October 23 virtual rider waited 45 minutes at Union Station (S). Its first
screen showed an under-one-minute pickup and a destination arrival window,
alongside a notice that recent buses had skipped the stop. All 271 saved
samples have original response evidence. The rider made no Dispatch request,
so this is not an independent measurement of requested pickup service or
physical ETA accuracy.

Trip planning retains Union Station as a visible request-only option. It
withholds pickup, following-arrival, and destination times for that option and
shows Dispatch instructions. A scheduled nearby pickup remains a separate
walking choice. The request requirement follows the planned pickup time as
well as the current Eastern Time; live choices refresh across noon without
moving the selected stop. Reminder ticks independently recheck the rule.
The route-stop list uses the same request state and does not offer a new
pickup alert or deliver one from a passing-bus forecast after noon. An armed
alert can still be canceled. Such forecasts are not logged as displayed
route-card timings while the request requirement applies.
Manual boarding remains available to a rider who is actually on the shuttle.
The app cannot place or confirm a Dispatch request.

The automated rider reads the product's selected stop-service state. It skips
new request-only selections and records an existing run that becomes
request-only as `on-demand-request-required-excluded`. Guardian retains that
outcome without treating it as a successful pickup or an unexplained timeout.
Other timeout incidents retain their existing handling.

The browser gate replays the saved incident in mobile and desktop views,
including devices outside Eastern Time and a page crossing noon. Clock-shift
controls retain the recorded positions and forecast durations; they are not
historical morning observations. The real rider loop reads the rendered DOM
and must record the request-only exclusion. This service rule does not fit
physical stop service probabilities, repair the general ETA model, or qualify
GPS proximity as physical boarding or door truth.
