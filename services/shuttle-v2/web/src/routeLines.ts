import L from 'leaflet';
import { offsetRoute, routeLanes } from './routeOffsets';

type RouteLine = { label: string; color: string; path: [number, number][] };

/** Paint parallel route traces without moving bus/stop markers or changing
 * planner geometry. Reproject only on zoom, never on the live polling loop. */
export function addRouteLines(map: L.Map, routes: RouteLine[]) {
  const lanes = routeLanes(routes.map(route => route.label));
  const lines = routes.map(route => ({
    route,
    lane: lanes.get(route.label)!,
    line: L.polyline(route.path, { color: route.color, weight: lanes.get(route.label)!.weight,
      opacity: 0.95, className: 'map-route-line', smoothFactor: 0.5 }).addTo(map).bindTooltip(route.label),
  }));
  const draw = () => {
    const zoom = map.getZoom();
    for (const { route, lane, line } of lines) {
      const projected = route.path.map(p => map.project(p, zoom));
      line.setLatLngs(offsetRoute(projected, lane.offset).map(p => map.unproject(L.point(p.x, p.y), zoom)));
      const element = line.getElement();
      element?.setAttribute('data-route', route.label);
      element?.setAttribute('data-offset', String(lane.offset));
    }
  };
  map.whenReady(draw);
  map.on('zoomend', draw);
  return () => { map.off('load', draw); map.off('zoomend', draw); };
}
