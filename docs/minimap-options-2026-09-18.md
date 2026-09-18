# Ten mini-map information layouts

Review at `/minimap-options/index.html`. These are isolated, interactive design concepts with illustrative times and simplified SVG maps, using the same Red trip from Division / Prospect to Rosenkranz. The current rider UI is unchanged.

1. Map for location: move all times below the map.
2. Pickup first: one pickup window on the map; destination time in the card.
3. Destination first: emphasize arrival at the destination.
4. One route at a time: route tabs instead of simultaneous annotations.
5. Tap to reveal: markers reveal details on demand.
6. One status strip: pickup and compact elapsed/typical wait in a fixed strip.
7. Your next step: walk, wait and ride views.
8. A simple stop timeline: replace geography with stop order.
9. Zoom into pickup: close pickup map with a small trip inset.
10. Map when you need it: timing first, foldaway geography.

The review starts with options 2, 6 and 8: a conservative simplification, a stable place for the existing waiting information, and a larger structural alternative. This is a design judgment, not a usability-study result. Blue in option 4 demonstrates route switching and is explicitly illustrative, not a service recommendation.

No live endpoints, map tiles, external fonts, telemetry or app storage are used. Favorites use a separate browser-local key. Dialogs support keyboard activation and Escape. Historical typical total waiting is distinguished from remaining waiting; example windows are estimates, not guaranteed bounds.

The Pi only edits and publishes source. Hosted `minimap-gallery-review` checks 320/390/1440 px, clipping, marker dialogs, keyboard focus, route switching, trip stages, expansion, favorites and persistence, and uploads screenshots. Normal app PR and deploy gates also run remotely.
