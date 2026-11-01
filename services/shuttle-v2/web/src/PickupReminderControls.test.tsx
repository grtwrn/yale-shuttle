import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PickupReminderControls } from './PickupReminderControls';

const props = { bus: 'Blue Day', stopName: 'Prospect/Canner', walkToSec: 120 };

// These cover the initially rendered availability states with the existing
// server-render harness. The real-SPA browser regression covers retained open
// drafts, focus and recovery across liveAvailable prop changes.
describe('pickup reminder controls while waiting for live data', () => {
  it('keeps an armed reminder editable and cancelable without fresh bus evidence', () => {
    const onArm = vi.fn(), onCancel = vi.fn();
    const html = renderToStaticMarkup(<PickupReminderControls {...props} liveAvailable={false}
      activeTiming={{ mode: 'stops', value: 2 }} onArm={onArm} onCancel={onCancel} />);

    expect(html).toContain('Reminding you for Blue Day');
    expect(html).toContain('2 stops before pickup');
    expect(html).toContain('Change reminder');
    expect(html).toContain('tap to cancel');
    expect(html).not.toContain('#undefined');
    expect(onArm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('withholds a new reminder control until live pickup evidence is available', () => {
    const onArm = vi.fn();
    const html = renderToStaticMarkup(<PickupReminderControls {...props} liveAvailable={false}
      onArm={onArm} onCancel={() => {}} />);

    expect(html).toBe('');
    expect(onArm).not.toHaveBeenCalled();
  });

  it('keeps the existing fresh-data behavior when availability is omitted', () => {
    const html = renderToStaticMarkup(<PickupReminderControls {...props} bus="#44"
      onArm={() => {}} onCancel={() => {}} />);

    expect(html).toContain('Remind me for #44');
    expect(html).toContain('Choose when to remind you before pickup');
    expect(html).not.toContain('Change reminder');
  });
});
