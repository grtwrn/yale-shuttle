// Research-only external-effect sink. Nothing in this module performs I/O.
export const boundary = { draft: null as any, signals: [] as {at:number; message:string}[], shown:0, permissionAttempts:0 };
export const loadTripDraft = () => boundary.draft;
export const saveTripDraft = () => {};
export const noteShown = () => { boundary.shown++; };
export const deliverPing = async (message:string) => { boundary.signals.push({at:Date.now(),message}); return true; };
export const ensureNotifyPermission = async () => { boundary.permissionAttempts++; return false; };
export const notifyPermissionState = () => 'denied';
export const vibrateAlert = () => { throw Error('Research cannot vibrate'); };
