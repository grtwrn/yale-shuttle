import type { ReactNode } from 'react';
import type { BusData } from './map-data';
import type { UpcomingArrival, DwellTimes } from './arrivals';
import type { LatLon } from './geo';
import type { TransferRidePath } from './transferPaths';
import { ROUTE_LISTS } from './routes';
import { boardHops, publishedWindowFor, routeHoursCaption } from './planner';
import { isWindowActiveAt, type PublishedWindow } from './schedule';
import { rideApproach } from './liveAnchor';
import { liveAnchorStore } from './eta';
import { liveBusAvailable } from './etaSource';
import { transferPickup } from './transferPickup';
import { TransferPickupControls } from './TransferPickupControls';
import { serviceStopCount } from './serviceStopCount';

export const transferStopName = (id: number, names: Record<number, string>) => (names[id] ?? `Stop ${id}`).replace(/\s*\/\s*/g, '/');
export function walkingLink(destination: LatLon, origin?: LatLon): string {
  return `https://www.google.com/maps/dir/?api=1${origin ? `&origin=${origin.lat},${origin.lon}` : ''}&destination=${destination.lat},${destination.lon}&travelmode=walking`;
}
export function TransferRideDetails({ title, path, buses, available, walkToSec, stopNames, stopCoords, routeStops, dwellTimes,
  pinnedBusName = '', controls, children, preview = false, previewArrival, routeHours = {}, atMs }: {
  title: string; path: TransferRidePath; buses: BusData[]; available: boolean; walkToSec: number | null;
  stopNames: Record<number, string>; stopCoords: Record<number, LatLon>; routeStops: Record<string, number[]>;
  dwellTimes: DwellTimes; pinnedBusName?: string; preview?: boolean; previewArrival?: UpcomingArrival; routeHours?: Record<string, PublishedWindow>; atMs?: number; controls?: { onBoard: (busName: string) => void }; children?: ReactNode;
}) {
  const now = Date.now(), pickup = transferPickup(path, buses, walkToSec ?? 0, now, available, pinnedBusName, dwellTimes, { routeStops, stopCoords });
  const cfg = ROUTE_LISTS.find(c => c.label === path.routeLabel);
  const evidence = pickup.selection?.countdown;
  const row = preview ? previewArrival : evidence?.source === 'forecast'
    ? pickup.source.pickups.find(a => a.busName.replace(/^#/, '') === evidence.busName
      && a.stopsAhead === evidence.stopsAhead && a.stopId === evidence.stopId) : undefined;
  const name = previewArrival?.busName.replace(/^#/, '') ?? pickup.busName;
  const bus = available && cfg ? buses.find(b => b.bus_name.replace(/^#/, '') === name
    && cfg.busRouteIds.includes(b.route_id) && liveBusAvailable(b, cfg.label, now)) : undefined;
  const approach = bus && cfg && (preview ? !!row : !!evidence)
    ? rideApproach(bus, cfg, routeStops, stopCoords, path.boardStopId,
      row ? boardHops(row, pickup.source.visits, path.boardStopId, path.alightStopId) : undefined, now, liveAnchorStore) : null;
  const stopsAway = row ? serviceStopCount(row) : evidence?.source === 'raw-at-stop' ? 0 : approach?.length ?? null;
  const hours = cfg ? routeHoursCaption(cfg, routeHours, new Date(atMs ?? now)) : null;
  const published = cfg ? publishedWindowFor(cfg, routeHours) : null;
  const pickupAt = preview ? row ? now + row.eta * 1000 : null
    : evidence ? now + (evidence.source === 'forecast' ? evidence.etaSec * 1000 : 0) : null;
  const outsideHours = published && pickupAt !== null && !isWindowActiveAt([published], new Date(pickupAt));
  return <section data-feedback-transfer-ride data-route={path.routeLabel} data-pickup={path.boardStopId} data-alight={path.alightStopId}
    data-board-bus={preview ? previewArrival?.busName : pickup.boardingBusName || undefined}
    data-countdown-bus={preview ? previewArrival?.busName : pickup.selection?.countdown.busName}
    data-board-stops-ahead={preview ? previewArrival?.stopsAhead : pickup.selection?.boarding.source === 'forecast' ? pickup.selection.boarding.stopsAhead : pickup.selection ? 0 : undefined}
    aria-label={`${title}: ${path.routeLabel}`} style={{ marginTop: 14, padding: 12, border: '1px solid #e0ddd8', borderRadius: 10, background: '#fff' }}>
    <h3 style={{ margin: '0 0 8px', fontSize: 16 }}><span style={{ color: path.color }}>{title} · {path.routeLabel}</span></h3>
    {hours && <p style={{ margin: '0 0 8px', fontSize: 12, color: '#5f6368' }}>{hours}</p>}
    {outsideHours && <p role="status" style={{ fontSize: 13 }}>This pickup is outside published hours. The bus may be finishing its run; check the updated time before heading to the stop.</p>}
    <div style={{ fontSize: 14 }}><strong>Board {transferStopName(path.boardStopId, stopNames)}</strong></div>
    {stopCoords[path.boardStopId] && <a className="trip-action-button" style={{ marginTop: 8, textDecoration: 'none', color: '#1a73e8' }}
      href={walkingLink(stopCoords[path.boardStopId]!)} target="_blank" rel="noopener noreferrer">Walking directions to pickup</a>}
    {controls && <TransferPickupControls path={path} buses={buses} available={available} walkToSec={walkToSec}
      stopName={transferStopName(path.boardStopId, stopNames)} pinnedBusName={pinnedBusName} dwellTimes={dwellTimes}
      routeStops={routeStops} stopCoords={stopCoords} onBoard={controls.onBoard} />}
    {children}
    {approach && approach.length > 0 && <details style={{ marginTop: 10, fontSize: 13 }}>
      <summary>#{name} · {stopsAway === null ? 'Stop count unavailable' : `${stopsAway} ${stopsAway === 1 ? 'stop' : 'stops'} before pickup`}</summary>
      <ol aria-label="Stops before transfer pickup" style={{ paddingLeft: 22, margin: '8px 0' }}>
        {approach.map((id, index) => <li key={`${index}/${id}`} style={{ margin: '4px 0' }}>{transferStopName(id, stopNames)}</li>)}
      </ol>
    </details>}
    <details style={{ marginTop: 10, fontSize: 13 }}>
      <summary>{path.stops.length - 1} {path.stops.length === 2 ? 'stop' : 'stops'} on this ride</summary>
      <ol data-transfer-ride-stops aria-label={`${path.routeLabel} ride stops`} style={{ paddingLeft: 22, margin: '8px 0' }}>
        {path.stops.map((id, index) => <li key={`${index}/${id}`} style={{ padding: '3px 0', fontWeight: index === 0 || index === path.stops.length - 1 ? 600 : 400 }}>
          {index === 0 ? 'Board · ' : index === path.stops.length - 1 ? 'Get off · ' : ''}{transferStopName(id, stopNames)}
        </li>)}
      </ol>
    </details>
    <p style={{ margin: '10px 0 0', fontSize: 14 }}><strong>Get off at {transferStopName(path.alightStopId, stopNames)}</strong></p>
  </section>;
}
