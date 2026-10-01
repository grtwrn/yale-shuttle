# Next bounded UX10 audit: saved destinations and recents

Source reconnaissance only on e7e9063 plus the map cleanup proposal. No new browser finding or code change is claimed here. Read prior UX02 deferrals before starting. Do not rerun completed map/crash/ETA investigations.

Start with the reachable Trip view with no destination/options. Seed two saved destinations and two recents using existing local-storage formats/test identity helpers (inspect recents.ts and the shell's load/save code). Keep all network local/intercepted. Capture actual 390px keyboard/touch behavior first.

1. Saved grid at TransitMap.tsx around 5010–5115: normal destination pills are clickable divs; edit toggle is a tiny icon; editing inputs have fontSize12 and no explicit name; delete acts only onMouseDown. Verify keyboard Tab/Enter/Space can plan a saved destination and delete the intended entry; compare touch. Check Enter, Escape, blur and name persistence. Source suggests keyboard delete has no action, but reproduce before claiming it.
2. Recent rows use renderTripRow around2685–2760. Verify keyboard selection, Save destination, Remove, focus after a row disappears, and that saving a recent leaves the intended destination saved exactly once. The old starred-row rename branch may be unreachable; inspect call sites before changing it.
3. Bound the first proposal to those demonstrated saved/recent failures. Preserve the data format, endpoint coordinates and destination dedup semantics. Avoid nested buttons when making the row keyboard accessible; give adjacent actions explicit destination-specific names and44px targets, inputs16px. Preserve focus on a stable same-list control when rows disappear without stealing focus from a rider who moved elsewhere.
4. Missing/blocked storage, two long destination names, empty lists,360/390/430/1280 widths and200%CSS reflow are meaningful regression cases. Use existing recents/typed storage tests; add substantive behavior tests only if new logic warrants them.

Later UX10 slices: location denied still permits typed origin; weather expansion currently overrides button role with status (around3320) and lacks expanded semantics. Preserve sibling unit toggle and removed temperature-trend constraint. Do not combine weather/location with saved-list repairs solely because this heading mentions all three.
