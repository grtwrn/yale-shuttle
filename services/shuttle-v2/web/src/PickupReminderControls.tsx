import { useId, useRef, useState } from 'react';
import { fmtWalk } from './format';
import { AT_STOP_WALK_SEC } from './leaveAlert';
import {
  DEFAULT_REMINDER_TIMING, REMINDER_MINUTES, REMINDER_STOPS, reminderTimingLabel, type ReminderTiming,
} from './pickupReminder';

export function PickupReminderControls({ bus, stopName, walkToSec, activeTiming, onArm, onCancel }: {
  bus: string; stopName: string; walkToSec: number; activeTiming?: ReminderTiming;
  onArm: (timing: ReminderTiming) => void; onCancel: () => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [timing, setTiming] = useState<ReminderTiming>(activeTiming ?? DEFAULT_REMINDER_TIMING);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const edit = () => { setTiming(activeTiming ?? timing); setOpen(true); };
  const controlStyle = { boxSizing: 'border-box' as const, minWidth: 0, minHeight: 44, fontSize: 16, fontFamily: 'inherit', border: '1px solid #dadce0', borderRadius: 6, padding: '0 8px', width: '100%' };
  return <div style={{ gridColumn: '1 / -1' }} onClick={e => e.stopPropagation()} onKeyDown={e => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
  }}>
    <button ref={trigger} className="trip-action-button" style={{ width: '100%' }}
      aria-pressed={!!activeTiming} aria-expanded={open} aria-controls={open ? id : undefined}
      title={activeTiming ? `${reminderTimingLabel(activeTiming)} — tap to cancel` : 'Choose when to remind you before pickup'}
      onClick={() => { if (activeTiming) { onCancel(); close(); } else if (open) close(); else edit(); }}>
      {activeTiming ? `🔔 Reminding you for ${bus}` : `🔔 Remind me for ${bus}`}
    </button>
    {activeTiming && !open && <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
      <span role="status">{reminderTimingLabel(activeTiming)}</span>
      <button className="trip-action-button" style={{ width: 'auto', flexShrink: 0 }} onClick={edit}>Change reminder</button>
    </div>}
    {open && <div id={id} role="group" aria-label="Pickup reminder settings" aria-describedby={`${id}-hint`}
      style={{ padding: 10, marginTop: 6, border: '1px solid #dadce0', borderRadius: 8, background: '#f8f9fa', color: '#37474f' }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>Before {bus} reaches {stopName}</p>
      <label style={{ display: 'block' }}>Reminder timing
        <select aria-label="Reminder timing" autoFocus style={controlStyle} value={timing.mode} onChange={e => {
          const mode = e.target.value as ReminderTiming['mode'];
          setTiming(mode === 'leave' ? { mode } : { mode, value: mode === 'minutes' ? 5 : 2 });
        }}>
          <option value="minutes">Minutes before pickup</option>
          <option value="stops">Stops before pickup</option>
          {walkToSec >= AT_STOP_WALK_SEC && <option value="leave">When it’s time to leave</option>}
        </select>
      </label>
      {timing.mode !== 'leave' && <label style={{ display: 'block', marginTop: 8 }}>
        {timing.mode === 'minutes' ? 'Minutes before pickup' : 'Stops before pickup'}
        <select aria-label={timing.mode === 'minutes' ? 'Minutes before pickup' : 'Stops before pickup'} style={controlStyle} value={timing.value} onChange={e => setTiming({ mode: timing.mode as 'minutes' | 'stops', value: Number(e.target.value) })}>
          {(timing.mode === 'minutes' ? REMINDER_MINUTES : REMINDER_STOPS).map(value =>
            <option key={value} value={value}>{value} {timing.mode === 'minutes' ? 'min' : `stop${value === 1 ? '' : 's'}`}</option>)}
        </select>
      </label>}
      <p id={`${id}-hint`} style={{ margin: '8px 0', fontSize: 13, lineHeight: 1.4 }}>
        {timing.mode === 'leave' ? 'Reminds you five minutes before leaving and again when it’s time to walk. '
          : timing.mode === 'minutes' ? 'Uses the early end of the live pickup window. ' : 'Follows the bus and pickup shown in this trip. '}
        {walkToSec >= AT_STOP_WALK_SEC && `Allow ${fmtWalk(walkToSec)} to walk to pickup. `}
        {timing.mode === 'minutes' && timing.value * 60 < walkToSec + 30 && 'This reminder may be too late to walk. '}
        Keep this page open for your reminder.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="trip-action-button" onClick={() => { onArm(timing); close(); }}>Set reminder</button>
        <button className="trip-action-button" onClick={close}>Cancel reminder setup</button>
      </div>
    </div>}
  </div>;
}
