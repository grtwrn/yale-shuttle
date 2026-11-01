import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BusData } from './map-data';
import type { DwellTimes, SegmentTimes } from './arrivals';
import { haversineMeters, type LatLon } from './geo';
import { ROUTE_LISTS } from './routes';
import type { PublishedWindow } from './schedule';
import { routeDiscontinuedAt } from './schedule';
import { findTransferPaths, type TransferPath } from './transferPaths';
import { planLiveTransfers, type LiveTransferJourney } from './transferTiming';
import { planScheduledTransfers } from './transferSchedule';
import { chooseTransferOptions, transferRideStillServed, transferWalkingSec, transferAddsChoice, type TransferTiming } from './transferChoices';
import { loadTransferSelection, makeOnwardTransfer, saveTransferSelection, type TransferDestination } from './transferState';
import { TransferRideDetails, transferStopName, walkingLink } from './TransferRideDetails';
import { transferPickup } from './transferPickup';
import type { BoardedRide } from './boardedRide';
import { AT_PLACE_M, walkSecFromMeters } from './walk';
import { fmtMin, fmtWalk } from './format';
import { arrivalClock } from './journeyArrival';
import { ArrivalDetails } from './ArrivalDetails';
import { noteShown } from './shownLog';
import type { TripOption } from './planner';

export function TransferTrips({ query, from, to, liveOrigin, buses, available, routeStops, stopCoords, stopNames, segmentTimes,
  dwellTimes, routeHours, targetAtMs, directOptions, hidden, onDetailChange, onBoard, onPlanNow, renderMap, renderAlerts }: {
  query: string; from: LatLon; to: TransferDestination; liveOrigin: LatLon | null; buses: BusData[]; available: boolean;
  routeStops: Record<string, number[]>; stopCoords: Record<number, LatLon>; stopNames: Record<number, string>;
  segmentTimes: SegmentTimes; dwellTimes: DwellTimes; routeHours: Record<string, PublishedWindow>; targetAtMs: number | null;
  directOptions: readonly TripOption[]; hidden: boolean; onDetailChange: (open: boolean) => void; onBoard: (ride: BoardedRide) => void; onPlanNow: () => void;
  renderMap: (path: TransferPath, firstBus: string, secondBus: string) => ReactNode;
  renderAlerts: (path: TransferPath, firstBus: string, secondBus: string) => ReactNode;
}) {
  const [selection, setSelection] = useState(() => loadTransferSelection(query));
  const [showAll, setShowAll] = useState(false);
  const heading = useRef<HTMLElement | null>(null), listTrigger = useRef<HTMLButtonElement | null>(null);
  const now = Date.now(), future = targetAtMs !== null && targetAtMs - now > 60_000;
  const roster = future ? `future/${targetAtMs}` : [...new Set(buses.map(b => b.route_id))].sort((a, b) => a - b).join(',');
  const geography = useMemo(() => JSON.stringify([routeStops, stopCoords, segmentTimes]), [routeStops, stopCoords, segmentTimes]);
  const published = useMemo(() => JSON.stringify(routeHours), [routeHours]);
  const paths = useMemo(() => {
    const configs = ROUTE_LISTS.filter(cfg => future
      ? !routeDiscontinuedAt(cfg.label, new Date(targetAtMs!))
      : buses.some(b => cfg.busRouteIds.includes(b.route_id)));
    return findTransferPaths({ from, to, routeStops, stopCoords, segmentTimes, routeConfigs: configs });
    // Geometry/calibration is stable across ordinary live position polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.lat, from.lon, to.lat, to.lon, geography, roster]);
  const forecastBuses = future ? null : buses;
  const timings = useMemo(() => future
    ? planScheduledTransfers(paths, targetAtMs!, Date.now(), routeHours)
    : planLiveTransfers(paths, buses, Date.now(), available),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paths, forecastBuses, available, future, targetAtMs, published]);
  const choices = useMemo(() => chooseTransferOptions(paths, timings), [paths, timings]);
  const selected = selection?.query === query ? selection : null;
  const selectedPath = selected ? (paths.find(p => p.key === selected.path.key) ?? selected.path) : undefined;
  const walkTo = selectedPath && !future && liveOrigin && stopCoords[selectedPath.first.boardStopId]
    ? haversineMeters(liveOrigin, stopCoords[selectedPath.first.boardStopId]!) : null;
  const changeFrom = selectedPath && stopCoords[selectedPath.first.alightStopId], changeTo = selectedPath && stopCoords[selectedPath.second.boardStopId];
  const finalExit = selectedPath && stopCoords[selectedPath.second.alightStopId];
  const currentPath = selectedPath ? { ...selectedPath,
    walkToSec: walkTo === null ? selectedPath.walkToSec : walkTo < AT_PLACE_M ? 0 : walkSecFromMeters(walkTo),
    transferWalkSec: changeFrom && changeTo ? walkSecFromMeters(haversineMeters(changeFrom, changeTo)) : selectedPath.transferWalkSec,
    walkFromSec: finalExit ? walkSecFromMeters(haversineMeters(finalExit, to)) : selectedPath.walkFromSec } : null;
  const stillServed = currentPath && transferRideStillServed(currentPath.first, routeStops) && transferRideStillServed(currentPath.second, routeStops);
  const firstPickup = currentPath && !future && stillServed
    ? transferPickup(currentPath.first, buses, currentPath.walkToSec, now, available, selected?.firstBusName, dwellTimes, { routeStops, stopCoords }) : null;
  const preferred = firstPickup?.boardingBusName || selected?.firstBusName || '';
  const currentTimings = currentPath && stillServed && (!future || paths.some(p => p.key === currentPath.key)) ? future
    ? planScheduledTransfers([currentPath], targetAtMs!, now, routeHours)
    : planLiveTransfers([currentPath], buses, now, available).filter(t => !preferred || t.first.busName === preferred) : [];
  const timing = currentTimings[0];
  const firstBus = timing?.timing === 'live' ? timing.first.busName : preferred;
  const secondBus = timing?.timing === 'live' ? timing.second.busName : selected?.secondBusName ?? '';
  useEffect(() => { onDetailChange(!!selected && !hidden); }, [selected?.path.key, hidden]); // callback uses setters only
  useEffect(() => { if (hidden && selected) setSelection(null); }, [hidden]);
  useEffect(() => { saveTransferSelection(selected); }, [selected]);
  useEffect(() => { if (selected && !hidden) heading.current?.focus(); }, [selected?.path.key, hidden]);
  useEffect(() => {
    if (selected && ((preferred && preferred !== selected.firstBusName) || (secondBus && secondBus !== selected.secondBusName))) {
      setSelection({ ...selected, ...(preferred ? { firstBusName: preferred } : {}), ...(secondBus ? { secondBusName: secondBus } : {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred, secondBus, selected?.path.key]);
  if (hidden || (!choices.length && !selected)) return null;
  const close = () => { setSelection(null); onDetailChange(false); setTimeout(() => listTrigger.current?.focus(), 0); };
  const describeTiming = (value: TransferTiming | undefined) => !value ? 'Connection timing unavailable'
    : value.timing === 'typical' ? `Typical trip ${fmtMin(value.totalSec)} · arrive about ${arrivalClock(value.arrivalAtMs)}`
      : `Arrive about ${arrivalClock(value.arrivalAtMs)} if you make the connection`;
  if (!currentPath && !showAll && !choices.some(c => transferAddsChoice(c, directOptions, future))) return <section aria-label="Trips with a transfer" style={{ margin: '10px 0' }}>
    <button ref={listTrigger} className="trip-action-button" onClick={() => setShowAll(true)}>Show {choices.length} transfer options</button>
  </section>;
  if (!currentPath) return <section data-testid="transfer-options" aria-label="Trips with a transfer" style={{ margin: '14px 0', padding: 12, border: '1px solid #e0ddd8', borderRadius: 12, background: '#fff' }}>
    <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>With a transfer</h2>
    {(showAll ? choices : choices.slice(0, 2)).map((choice, index) => <button key={choice.key} ref={index === 0 ? listTrigger : undefined}
      aria-label={`View ${choice.path.first.routeLabel} to ${choice.path.second.routeLabel} transfer from ${transferStopName(choice.path.first.boardStopId, stopNames)}`}
      onClick={() => setSelection({ query, path: choice.path, ...(choice.timing?.timing === 'live' ? { firstBusName: choice.timing.first.busName, secondBusName: choice.timing.second.busName } : {}) })}
      style={{ display: 'block', width: '100%', minHeight: 44, marginTop: 8, padding: 10, textAlign: 'left', border: '1px solid #dadce0', borderRadius: 8, background: '#fff', font: 'inherit', cursor: 'pointer' }}>
      <strong><span style={{ color: choice.path.first.color }}>{choice.path.first.routeLabel}</span> → <span style={{ color: choice.path.second.color }}>{choice.path.second.routeLabel}</span></strong>
      <span style={{ display: 'block', fontSize: 13, marginTop: 4 }}>{transferStopName(choice.path.first.boardStopId, stopNames)} · {fmtWalk(transferWalkingSec(choice.path))} walking · 1 change</span>
      <span style={{ display: 'block', fontSize: 13, marginTop: 4 }}>{describeTiming(choice.timing)}</span>
      {choice.preferences.includes('closest-pickup') && <span style={{ display: 'block', fontSize: 12, marginTop: 3, color: '#546e7a' }}>Closest pickup for this connection</span>}
    </button>)}
    {!showAll && choices.length > 2 && <button className="trip-action-button" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>Show {choices.length - 2} more transfer options</button>}
  </section>;
  const boardFirst = (busName: string) => {
    const nextStop = stopCoords[currentPath.second.boardStopId];
    if (!nextStop || !stillServed) return;
    onBoard({ routeLabel: currentPath.first.routeLabel, color: currentPath.first.color, busName,
      boardStopId: currentPath.first.boardStopId, alightStopId: currentPath.first.alightStopId, startedAt: Date.now(),
      toLat: nextStop.lat, toLon: nextStop.lon, toText: transferStopName(currentPath.second.boardStopId, stopNames),
      onward: makeOnwardTransfer(currentPath, to, Date.now(), secondBus) });
  };
  if (timing?.timing === 'live') noteShown([timing.second.pickup], 'trip', now);
  return <section ref={heading} tabIndex={-1} data-testid="transfer-detail" aria-label="Transfer itinerary" style={{ marginTop: 8, outline: 'none' }}>
    <button className="trip-action-button" onClick={close}>← All routes</button>
    {!future && renderAlerts(currentPath, firstBus, secondBus)}
    <h2 style={{ fontSize: 18 }}>{currentPath.first.routeLabel} → {currentPath.second.routeLabel}</h2>
    <p style={{ fontSize: 14 }}>{describeTiming(timing)}</p>
    {timing?.timing === 'live' && (timing.connection.uncertain || timing.firstPickupUncertain) && <p role="status" style={{ padding: 10, background: '#fff8e1', borderRadius: 8, fontSize: 14 }}>
      {timing.firstPickupUncertain ? 'Allow enough time to reach the first pickup. ' : ''}The connection may be tight. If the first bus is late, you may need a later {currentPath.second.routeLabel} shuttle.
    </p>}
    {!stillServed && Object.keys(routeStops).length > 0 && <p role="status">The route has changed. Return to all routes to plan again.</p>}
    {renderMap(currentPath, firstBus, secondBus)}
    <TransferRideDetails routeHours={routeHours} atMs={targetAtMs ?? now} title="1. First bus" path={currentPath.first} buses={buses} available={!future && available}
      walkToSec={currentPath.walkToSec} stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops} dwellTimes={dwellTimes}
      pinnedBusName={firstBus} {...(!future && stillServed ? { controls: { onBoard: boardFirst } } : {})}>
      {timing?.timing === 'typical' && <p data-transfer-pickup>Typical pickup around {arrivalClock(timing.first.pickupAtMs)} · {fmtWalk(currentPath.walkToSec)} walk</p>}
    </TransferRideDetails>
    <div data-testid="transfer-walk" style={{ padding: '14px 6px', fontSize: 14 }}>
      <strong>2. Change at {transferStopName(currentPath.first.alightStopId, stopNames)}</strong>
      <div>{currentPath.first.alightStopId === currentPath.second.boardStopId ? 'Stay at this stop for' : `${fmtWalk(currentPath.transferWalkSec)} walk to`} {transferStopName(currentPath.second.boardStopId, stopNames)} · {currentPath.second.routeLabel}</div>
      {stopCoords[currentPath.first.alightStopId] && stopCoords[currentPath.second.boardStopId] && currentPath.transferWalkSec > 0 && <a href={walkingLink(stopCoords[currentPath.second.boardStopId]!, stopCoords[currentPath.first.alightStopId]!)} target="_blank" rel="noopener noreferrer">Walking directions between stops</a>}
    </div>
    <TransferRideDetails routeHours={routeHours} atMs={targetAtMs ?? now} preview previewArrival={timing?.timing === 'live' ? timing.second.pickup : undefined} title="3. Second bus" path={currentPath.second} buses={buses} available={!future && available}
      walkToSec={null} stopNames={stopNames} stopCoords={stopCoords} routeStops={routeStops} dwellTimes={dwellTimes} pinnedBusName={secondBus}>
      {timing?.timing === 'live' ? <div data-transfer-pickup style={{ marginTop: 8, fontSize: 14 }}>
        <div>{currentPath.second.routeLabel} #{secondBus}</div>
        <ArrivalDetails routeLabel={currentPath.second.routeLabel} busName={secondBus} stopId={currentPath.second.boardStopId}
          etaSec={timing.second.pickup.eta} lowSec={timing.second.pickup.low} highSec={timing.second.pickup.high} computedAtMs={timing.computedAtMs}
          {...(timing.second.pickup.distribution ? { distributionSec: timing.second.pickup.distribution } : {})} />
        <div>Track this pickup after your first ride.</div>
      </div> : <p data-transfer-pickup>{timing?.timing === 'typical' ? `Typical pickup around ${arrivalClock(timing.second.pickupAtMs)}` : 'Connection timing unavailable'}</p>}
    </TransferRideDetails>
    <p style={{ fontSize: 14, padding: '4px 6px' }}>Then {fmtWalk(currentPath.walkFromSec)} walk to {to.text}.</p>
    {future && <button className="trip-action-button" onClick={onPlanNow}>Plan for now to use live boarding and reminders</button>}
  </section>;
}
