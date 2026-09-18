import L from "leaflet";

// Leaflet 1.9's TouchZoom.removeHooks only removes touchstart. An active
// gesture still owns document listeners and a queued map movement frame.
// There is no public cancel method; keep this version-specific adapter here
// and exercise it through the real browser in map-touch-teardown-check.mjs.
type ActiveTouchZoom = L.Handler & {
  _zooming?: boolean;
  _animRequest?: number;
  _onTouchMove: L.DomEvent.EventHandlerFn;
  _onTouchEnd: L.DomEvent.EventHandlerFn;
};

/** Cancel this map's pinch before stop/remove, without completing a zoom. */
export function cancelMapTouchZoom(map: L.Map): void {
  const touch = map.touchZoom as ActiveTouchZoom;
  touch.disable();
  touch._zooming = false;
  if (touch._animRequest !== undefined) L.Util.cancelAnimFrame(touch._animRequest);
  // Also detach a gesture with no movement: Leaflet's own touch-end early
  // return skips these listeners. Other maps' document handlers stay intact.
  // Leaflet itself uses document here, but its types only accept HTMLElement.
  const target = document as unknown as HTMLElement;
  L.DomEvent.off(target, "touchmove", touch._onTouchMove, touch);
  L.DomEvent.off(target, "touchend touchcancel", touch._onTouchEnd, touch);
}
