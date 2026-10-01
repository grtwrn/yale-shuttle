import { announcementsForRoutes, isGroceryTransitionAnnouncement, type ServiceAnnouncement } from './announcements';
import { groceryServiceNotice } from './schedule';

/** Service changes belong before the route choice, including when no bus reports. */
export function TripServiceNotices({ routeLabels, announcements, at, groceryNoticeVisible }: {
  routeLabels: string[];
  announcements: readonly ServiceAnnouncement[];
  at: Date;
  groceryNoticeVisible: boolean;
}) {
  const notices = announcementsForRoutes(routeLabels, announcements).filter(a => !isGroceryTransitionAnnouncement(a));
  const groceryLabel = routeLabels.find(label => label === 'Grocery Ham' || label === 'Grocery TJ');
  const grocery = !groceryNoticeVisible && groceryLabel ? groceryServiceNotice(groceryLabel, at) : null;
  if (!notices.length && !grocery) return null;
  return <div data-testid="trip-service-alerts" role="region" aria-label="Service alerts for this trip"
    style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: '#FFF8E1',
      border: '1px solid #FFE082', color: '#795548', fontSize: 13, lineHeight: 1.45 }}>
    <strong style={{ display: 'block', marginBottom: 4 }}>Service update</strong>
    {notices.map((notice, i) => <div key={notice.id} role="note" style={{ marginTop: i ? 8 : 0 }}>{notice.message}</div>)}
    {grocery && <div role="note" style={{ marginTop: notices.length ? 8 : 0 }}>{grocery}</div>}
  </div>;
}
