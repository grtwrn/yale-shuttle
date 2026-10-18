import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { BusData } from './map-data';
import type { DwellTimes } from './arrivals';
import { haversineMeters, type LatLon } from './geo';
import type { TransferHandoff } from './transferState';
import type { PublishedWindow } from './schedule';
import type { BoardedRide } from './boardedRide';
import { transferRideStillServed } from './transferChoices';
import { transferPickup } from './transferPickup';
import { AT_PLACE_M, walkSecFromMeters } from './walk';
import { fmtWalk } from './format';
import { arrivalClock } from './journeyArrival';
import { TransferRideDetails, transferStopName } from './TransferRideDetails';

export function OnwardTransfer({ handoff, buses, available, origin, stopNames, stopCoords, routeStops, dwellTimes, routeHours,
  onContinue, onLocate, onBoard, onReplan, onDismiss, focusRef, renderMap, renderAlerts }: {
  handoff: TransferHandoff; buses: BusData[]; available: boolean; origin: LatLon | null;
  stopNames: Record<number, string>; stopCoords: Record<number, LatLon>; routeStops: Record<string, number[]>; dwellTimes: DwellTimes; routeHours: Record<string, PublishedWindow>;
  onContinue: () => void; onLocate: () => void; onBoard: (ride: BoardedRide) => void; onReplan: () => void; onDismiss: () => void;
  focusRef?: Ref<HTMLElement>; renderMap: (ride: BoardedRide, destination: TransferHandoff['onward']['destination']) => ReactNode;
  renderAlerts: (routeLabel: string, busNames: string[]) => ReactNode;
}) {
  const { onward, reason } = handoff, path = onward.next;
  const [pinned, setPinned] = useState(onward.nextBusName ?? '');
  const nextHeading = useRef<HTMLDivElement | null>(null);
  const served = transferRideStillServed(path, routeStops), ready = handoff.ready ?? !reason;
  const boardPoint = stopCoords[path.boardStopId], exitPoint = stopCoords[path.alightStopId];
  const walkM = origin && boardPoint ? haversineMeters(origin, boardPoint) : null;
  const walkToSec = walkM === null ? null : walkM < AT_PLACE_M ? 0 : walkSecFromMeters(walkM);
  const now = Date.now(), pickup = transferPickup(path, buses, walkToSec ?? 0, now, available && served, pinned, dwellTimes);
  useEffect(() => { if (pickup.boardingBusName && pickup.boardingBusName !== pinned) setPinned(pickup.boardingBusName); }, [pickup.boardingBusName]);
  useEffect(() => { if (ready) nextHeading.current?.focus(); }, [ready]);
  const explanation = reason === 'bus-gone' ? `Tracking stopped after ${onward.firstRouteLabel} disappeared from live updates. You may still be on board.`
    : reason === 'age' ? 'Tracking stopped after 2 hours. Your position at the transfer stop is unconfirmed.'
      : reason === 'off-bus' ? `Your location appears to be away from ${onward.firstRouteLabel}. You may have gotten off before the planned stop.` : null;
  const boarding = pickup.selection?.boarding;
  const walkRisk = walkToSec !== null && boarding && walkToSec > (boarding.source === 'forecast' ? boarding.lowSec : 0);
  const lastWalkSec = exitPoint ? walkSecFromMeters(haversineMeters(exitPoint, onward.destination)) : null;
  const arrivalAt = pickup.destination && lastWalkSec !== null ? pickup.destination.pointMs + lastWalkSec * 1000 : null;
  const board = (busName: string) => {
    if (!ready || !served) return;
    onBoard({ routeLabel: path.routeLabel, color: path.color, busName, boardStopId: path.boardStopId, alightStopId: path.alightStopId,
      startedAt: Date.now(), toLat: onward.destination.lat, toLon: onward.destination.lon, toText: onward.destination.text });
  };
  const mapRide: BoardedRide = { routeLabel: path.routeLabel, color: path.color, busName: pickup.boardingBusName,
    boardStopId: path.boardStopId, alightStopId: path.alightStopId, startedAt: handoff.stoppedAtMs };
  return <section ref={focusRef} tabIndex={-1} data-testid="transfer-handoff" aria-label="Continue your transfer trip"
    style={{ width: 'calc(100% - 32px)', maxWidth: 528, margin: '16px auto 8px', padding: 14, boxSizing: 'border-box', border: '1px solid #e0ddd8', borderRadius: 12, background: '#fff' }}>
    <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>Next: {path.routeLabel}</h2>
    <p style={{ fontSize: 14 }}>Continue to {onward.destination.text} via {transferStopName(path.boardStopId, stopNames)}.</p>
    {explanation && <p role="status" style={{ fontSize: 14, lineHeight: 1.45 }}>{explanation}</p>}
    {!ready ? <button className="trip-action-button" onClick={onContinue}>Continue to next pickup</button> : <div ref={nextHeading} tabIndex={-1} style={{ outline: 'none' }}>
      {renderAlerts(path.routeLabel, [...new Set([onward.nextBusName, pickup.boardingBusName].filter((name): name is string => !!name))])}
      {origin ? <p style={{ fontSize: 14 }}>{walkToSec === 0 ? 'You are near the pickup.' : `${fmtWalk(walkToSec!)} estimated walk from your current location.`}</p>
        : <button className="trip-action-button" onClick={onLocate}>Use my location for the walk to pickup</button>}
      {walkRisk && <p role="status">The bus could reach pickup before you do. Check the early arrival time and allow for the walk.</p>}
      {!served && Object.keys(routeStops).length > 0 && <p role="status">This route has changed. Find another route to your destination.</p>}
      {pickup.boardingBusName && onward.nextBusName && pickup.boardingBusName !== onward.nextBusName && <p role="status" style={{ fontSize: 13 }}>The live pickup now uses #{pickup.boardingBusName}.</p>}
      {arrivalAt !== null && <p style={{ fontSize: 14 }}>Arrive about {arrivalClock(arrivalAt)} if you catch this bus.</p>}
      {served && renderMap(mapRide, onward.destination)}
      <TransferRideDetails routeHours={routeHours} title="Second bus" path={path} buses={buses} available={available && served} walkToSec={walkToSec}
        stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops} dwellTimes={dwellTimes} pinnedBusName={pinned}
        {...(served ? { controls: { onBoard: board } } : {})} />
      {lastWalkSec !== null && <p style={{ fontSize: 14 }}>Then {fmtWalk(lastWalkSec)} walk to {onward.destination.text}.</p>}
    </div>}
    <button className="trip-action-button" style={{ marginTop: 10 }} onClick={onReplan}>Find another route</button>
    <button className="trip-action-button" style={{ marginTop: 8 }} onClick={onDismiss}>End this trip</button>
  </section>;
}
