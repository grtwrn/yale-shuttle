import { DISPATCH_SOURCE, PICKUP_SERVICE_SOURCE, type PickupRequest } from './pickupService';

export function PickupRequestNotice({ request, compact = false }: { request: PickupRequest; compact?: boolean }) {
  if (compact) return <span data-testid="pickup-on-request" style={{ fontWeight: 600 }}>On request</span>;
  return <div role="note" data-testid="pickup-request-notice" onClick={event => event.stopPropagation()}
    style={{ padding: '8px 10px', borderRadius: 6, background: '#fff8e1', color: '#795000', fontSize: 12, lineHeight: 1.5 }}>
    <div>{request.message}</div>
    <div>A passing shuttle is not a confirmed pickup. Ask Dispatch for your pickup time.</div>
    <a href="tel:+12032815470" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, fontWeight: 600 }}>
      Call Dispatch: 203-281-5470 · option 1
    </a>
    <div><a href={PICKUP_SERVICE_SOURCE} target="_blank" rel="noreferrer">Yale service details</a>
      {' · '}<a href={DISPATCH_SOURCE} target="_blank" rel="noreferrer">Dispatch contact</a></div>
  </div>;
}
