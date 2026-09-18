Waiting badges took two lines and could stack far above the bus when an arrival chip occupied the space between them. Show one compact line, such as `Red 7:14/~5m`, with the route color retained. Hover and accessibility text explain elapsed waiting time and typical total wait.

Place the badge in the closest clear position around its bus, avoiding other bus icons, ETA labels, and map controls. Remove the displaced tooltip arrow so it cannot point at an unrelated location.

Validation: backend/frontend typechecks, frontend build, label tests, and recorded Red rider UI checks pass. An exact Division/Prospect → Rosenkranz recording shows a 19-pixel-high badge six pixels from the bus in all six 320/390/430 px embedded/fullscreen layouts, with zero overlaps or page errors. Existing 320/390/1701 px overview checks pass. This does not change forecast values or model coefficients.
