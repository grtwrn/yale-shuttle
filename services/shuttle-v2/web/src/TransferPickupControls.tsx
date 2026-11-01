import { useEffect, useRef, useState } from 'react';
import type { BusData } from './map-data';
import type { DwellTimes } from './arrivals';
import type { TransferRidePath } from './transferPaths';
import { transferPickup } from './transferPickup';
import { PickupReminderControls } from './PickupReminderControls';
import { TripBoardingActions } from './TripBoardingActions';
import { computePickupReminder, pickupReminderMessage, type ReminderTiming } from './pickupReminder';
import { deliverPing, ensureNotifyPermission, liveReminderInput, markFired, NO_PINGS_FIRED, vibrateAlert } from './leaveAlert';
import { ArrivalDetails } from './ArrivalDetails';
import { noteShown } from './shownLog';
import type { LatLon } from './geo';
import { serviceStopCount } from './serviceStopCount';

export function TransferPickupControls({ path, buses, available, walkToSec, stopName, pinnedBusName = '', dwellTimes, routeStops, stopCoords, onBoard }: {
  path: TransferRidePath; buses: BusData[]; available: boolean; walkToSec: number | null;
  stopName: string; pinnedBusName?: string; dwellTimes: DwellTimes; onBoard: (busName: string) => void;
  routeStops: Record<string, number[]>; stopCoords: Record<number, LatLon>;
}) {
  const [reminder, setReminder] = useState<ReminderTiming | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const fired = useRef({ ...NO_PINGS_FIRED }), armGeneration = useRef(0), mounted = useRef(true);
  const latest = useRef({ path, buses, available, walkToSec, pinnedBusName, dwellTimes, routeStops, stopCoords });
  latest.current = { path, buses, available, walkToSec, pinnedBusName, dwellTimes, routeStops, stopCoords };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; armGeneration.current++; }; }, []);
  useEffect(() => { armGeneration.current++; setReminder(null); setBanner(null); }, [path.routeLabel, path.boardStopId, path.alightStopId]);
  const now = Date.now();
  const pickup = transferPickup(path, buses, walkToSec ?? 0, now, available, pinnedBusName, dwellTimes, { routeStops, stopCoords });
  useEffect(() => {
    if (!reminder) return;
    const check = () => {
      const p = latest.current, at = Date.now();
      const live = transferPickup(p.path, p.buses, p.walkToSec ?? 0, at, p.available, p.pinnedBusName, p.dwellTimes,
        { routeStops: p.routeStops, stopCoords: p.stopCoords });
      const input = live.option && (reminder.mode !== 'leave' || p.walkToSec !== null)
        ? liveReminderInput([live.option], p.path.routeLabel, { buses: p.buses, busUpdateFailed: !p.available, nowMs: at,
          boardStopId: p.path.boardStopId, alightStopId: p.path.alightStopId }) : null;
      if (!input) { setReminder(null); setBanner('Reminder stopped: live pickup timing is unavailable.'); return; }
      if (reminder.mode === 'stops' && serviceStopCount(input) === null) {
        setBanner('Reminder waiting for a live stop count.');
        return;
      }
      setBanner(previous => previous === 'Reminder waiting for a live stop count.' ? null : previous);
      const ping = computePickupReminder(input, fired.current, reminder);
      if (!ping) return;
      fired.current = markFired(fired.current, ping);
      const message = pickupReminderMessage(ping, reminder, p.path.routeLabel, input);
      void deliverPing(message, 'transfer-pickup').then(shown => {
        if (!shown && mounted.current) { setBanner(message); vibrateAlert(); }
      });
      if (reminder.mode !== 'leave' || ping === 'leave_now') setReminder(null);
    };
    check(); const timer = setInterval(check, 1000); return () => clearInterval(timer);
  }, [reminder]);
  const countdown = pickup.selection?.countdown;
  const row = countdown?.source === 'forecast' ? pickup.source.pickups.find(a => a.busName.replace(/^#/, '') === countdown.busName
    && a.stopId === countdown.stopId && a.stopsAhead === countdown.stopsAhead) : undefined;
  if (row) noteShown([row], 'trip', now);
  return <div data-testid="transfer-pickup-controls" style={{ marginTop: 10 }}>
    <div data-transfer-pickup role="status" style={{ fontSize: 14, marginBottom: 8 }}>
      {countdown ? <>
        <div>{path.routeLabel} #{pickup.busName}</div>
        {countdown.source === 'raw-at-stop' ? <div>At pickup now</div>
          : <ArrivalDetails routeLabel={path.routeLabel} busName={pickup.busName} etaSec={countdown.etaSec}
              lowSec={countdown.lowSec} highSec={countdown.highSec} computedAtMs={now} stopId={path.boardStopId}
              {...(row?.distribution ? { distributionSec: row.distribution } : {})} />}
      </> : pickup.departed ? 'The planned pickup is no longer catchable. Check the next bus.' : 'Live pickup timing unavailable'}
      {walkToSec === null && <div style={{ fontSize: 12, marginTop: 4 }}>Use your location to estimate the walk to pickup.</div>}
    </div>
    {banner && <p role="status" style={{ padding: 8, background: '#fff8e1', borderRadius: 6 }}>{banner}</p>}
    {pickup.boardingBusName && <div className="trip-actions">
      <TripBoardingActions pickup={pickup.busName} ride={pickup.boardingBusName} different={pickup.busName !== pickup.boardingBusName} onBoard={onBoard} />
      <PickupReminderControls key={walkToSec === null ? 'unknown-walk' : 'known-walk'}
        bus={`${path.routeLabel} #${pickup.boardingBusName}`} stopName={stopName} walkToSec={walkToSec ?? 0}
        {...(reminder ? { activeTiming: reminder } : {})}
        onCancel={() => { armGeneration.current++; setReminder(null); setBanner(null); }}
        onArm={timing => {
          const generation = ++armGeneration.current;
          void ensureNotifyPermission().then(() => {
            if (!mounted.current || generation !== armGeneration.current) return;
            fired.current = { ...NO_PINGS_FIRED }; setBanner(null); setReminder(timing);
          });
        }} />
    </div>}
  </div>;
}
