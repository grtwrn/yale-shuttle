# Variants of the current mini map — 18 September 2026

The first gallery changed the map and layout too much. This revision uses the
actual `CombinedTripMap` from the app with a frozen recorded Red trip from
Division / Prospect to Rosenkranz. The current map is shown as the baseline.

Ten alternatives change only label visibility, wording or placement: hide the
destination clock; hide the waiting label; shorten Red to R; show wait numbers
only; remove repeated route initials; hide pickup time; keep pickup time only;
move the waiting label below the bus; move waiting time to the existing legend;
hide all time labels. Streets, route shape, map bounds, markers, controls,
colors and typography remain the same. These are static comparison images;
the live mini map remains unchanged pending selection.

The review gallery stays at `/minimap-options/index.html`. It supports comparing
each option with the current map, keyboard-accessible dialogs and local saved
favorites. Old redesign favorites use a different storage key.

## Validation and load

GitHub hosted Chrome renders the built app using a committed public feed
fixture. Only map tile and font requests are allowed externally. App API calls
use the recorded fixture. The renderer checks that map size, paths, marker
positions and tile URLs remain identical for all eleven images. The manifest
records source and image hashes; the reviewed images are committed and reused
for deployment. The gallery makes no live API requests. No build, test or
browser runs on the watcher Pi.

The same hosted job checks route cards at 320, 390 and 1280 pixels: the total
minutes are removed from the right column, leaving the destination arrival
range; pickup reads “Arrives in ~X min” with “Next in ~Y min” below it. Next is
arrival from now at the pickup stop, not the gap after the first shuttle. Under
one minute and observed presence retain their precise labels. Tapping still
shows the pickup window and history. Walking/future plans retain an explicit
approximate destination time when no live journey window exists. The watcher
parser accepts both the previous layout and the compact cards.
