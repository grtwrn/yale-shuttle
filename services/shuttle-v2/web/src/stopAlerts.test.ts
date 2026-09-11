import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { deliverPing } from "./leaveAlert";
import {
  ARRIVAL_ETA_SEC, CLOSE_GRACE_MS, DEFAULT_LEAD_MIN, LEAD_CHOICES, MAX_STOP_ALERTS,
  STOP_ALERTS_KEY, STOP_ALERT_TTL_MS,
  alertKey, stopAlertPermissionHint, armStopAlert, decide, disarmStopAlert, expireStopAlerts, findStopAlert,
  isStopAlertArmed, isStopAlertExpired, loadStopAlerts, markStopAlertFired, saveStopAlerts,
  stepStopAlerts, stopAlertMessage, stopAlertTag, updateStopAlert, type StopAlert,
} from "./stopAlerts";

const T0 = 1_757_600_000_000; // a fixed instant; nothing here reads the wall clock

function alert(over: Partial<StopAlert> = {}): StopAlert {
  return {
    routeId: "3", routeLabel: "Red", stopId: 11, stopName: "344 Winchester",
    leadMin: 3, createdAt: T0, ...over,
  };
}

describe("arming", () => {
  it("arms one alert and finds it by (line, stop)", () => {
    const a = armStopAlert([], alert());
    expect(a).toHaveLength(1);
    expect(isStopAlertArmed(a, "Red", 11)).toBe(true);
    expect(isStopAlertArmed(a, "Red", 12)).toBe(false);
    expect(isStopAlertArmed(a, "Blue Day", 11)).toBe(false);
    expect(findStopAlert(a, "Red", 11)?.stopName).toBe("344 Winchester");
  });

  it("IGNORES a duplicate arm — same array back, so a double tap cannot ping twice", () => {
    const first = armStopAlert([], alert());
    const second = armStopAlert(first, alert({ leadMin: 5, createdAt: T0 + 1000 }));
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
    expect(second[0]!.leadMin).toBe(3);
  });

  it("the same stop on a different line is a different alert", () => {
    let a = armStopAlert([], alert());
    a = armStopAlert(a, alert({ routeId: "1", routeLabel: "Blue Day" }));
    expect(a).toHaveLength(2);
    expect(alertKey("Red", 11)).not.toBe(alertKey("Blue Day", 11));
  });

  it("disarm removes exactly one row", () => {
    let a = armStopAlert([], alert());
    a = armStopAlert(a, alert({ stopId: 12, stopName: "Division / Prospect" }));
    const left = disarmStopAlert(a, "Red", 11);
    expect(left).toHaveLength(1);
    expect(left[0]!.stopId).toBe(12);
  });

  it("is bounded — the newest arms survive", () => {
    let a: StopAlert[] = [];
    for (let i = 0; i < MAX_STOP_ALERTS + 3; i++) {
      a = armStopAlert(a, alert({ stopId: 100 + i, createdAt: T0 + i }));
    }
    expect(a).toHaveLength(MAX_STOP_ALERTS);
    expect(a[a.length - 1]!.stopId).toBe(100 + MAX_STOP_ALERTS + 2);
  });

  it("updateStopAlert replaces in place by identity", () => {
    const a = armStopAlert(armStopAlert([], alert()), alert({ stopId: 12 }));
    const next = updateStopAlert(a, { ...a[0]!, leadMin: 5 });
    expect(next[0]!.leadMin).toBe(5);
    expect(next[1]).toBe(a[1]);
  });
});

describe("the fire decision", () => {
  it("the LEAD fires ONCE as the ETA crosses the rider's lead time", () => {
    const a = alert({ leadMin: 3 });
    expect(decide(a, 400, "#304", T0)).toBe(null);       // 6:40 out — nothing
    expect(decide(a, 181, "#304", T0)).toBe(null);       // 3:01 — still outside
    expect(decide(a, 180, "#304", T0)).toBe("lead");     // exactly 3 min
    const fired = markStopAlertFired(a, "lead", "#304");
    expect(decide(fired, 170, "#304", T0)).toBe(null);   // same bus, closer — silent
    expect(decide(fired, 200, "#304", T0)).toBe(null);   // ETA bounced up — still silent
  });

  it("the ARRIVAL fires ONCE, then the alert is silent for that bus", () => {
    const led = markStopAlertFired(alert(), "lead", "#304");
    expect(decide(led, ARRIVAL_ETA_SEC, "#304", T0)).toBe("arrival");
    const done = markStopAlertFired(led, "arrival", "#304");
    expect(decide(done, 5, "#304", T0)).toBe(null);
    expect(decide(done, 0, "#304", T0)).toBe(null);
  });

  it("a bus already at the stop when armed fires the ARRIVAL only — never both at once", () => {
    const a = alert({ leadMin: 5 });
    expect(decide(a, 12, "#310", T0)).toBe("arrival");
    const done = markStopAlertFired(a, "arrival", "#310");
    // `arrival` marks `lead` fired too, so no belated "5 min away".
    expect(done.fired).toEqual({ busName: "#310", lead: true, arrival: true });
    expect(decide(done, 240, "#310", T0)).toBe(null);
  });

  it("no live arrival is NOT an answer — the arm keeps waiting", () => {
    const a = alert();
    expect(decide(a, null, null, T0)).toBe(null);
    expect(decide(a, undefined, "#304", T0)).toBe(null);
    expect(decide(a, 100, null, T0)).toBe(null);
    expect(decide(a, Number.NaN, "#304", T0)).toBe(null);
    // and the arm is untouched, so the next bus still gets its ping
    expect(decide(a, 100, "#304", T0)).toBe("lead");
  });

  it("A NEW BUS AFTER A VANISHED ONE gets a fresh lead ping", () => {
    const led = markStopAlertFired(alert(), "lead", "#304");
    // #304 dropped off the feed; the next Red bus is a new promise.
    expect(decide(led, 150, "#316", T0)).toBe("lead");
    // ...and its own arrival, even though #304's lead had already fired.
    const led2 = markStopAlertFired(led, "lead", "#316");
    expect(led2.fired?.busName).toBe("#316");
    expect(decide(led2, 20, "#316", T0)).toBe("arrival");
  });

  it("an even earlier bus does not resurrect the finished one's flags", () => {
    const done = markStopAlertFired(alert(), "arrival", "#304");
    expect(decide(done, 25, "#316", T0)).toBe("arrival");
    expect(decide(done, 25, "#304", T0)).toBe(null);
  });

  it("an expired alert fires nothing, whatever the bus is doing", () => {
    const a = alert();
    expect(isStopAlertExpired(a, T0 + STOP_ALERT_TTL_MS - 1)).toBe(false);
    expect(isStopAlertExpired(a, T0 + STOP_ALERT_TTL_MS)).toBe(true);
    expect(decide(a, 10, "#304", T0 + STOP_ALERT_TTL_MS)).toBe(null);
    expect(decide(a, 120, "#304", T0 + STOP_ALERT_TTL_MS)).toBe(null);
  });

  it("every offered lead time is honoured", () => {
    for (const leadMin of LEAD_CHOICES) {
      const a = alert({ leadMin });
      expect(decide(a, leadMin * 60 + 1, "#304", T0)).toBe(null);
      expect(decide(a, leadMin * 60, "#304", T0)).toBe("lead");
    }
  });
});

describe("one poll (stepStopAlerts)", () => {
  const arr = (eta: number, busName: string, over: Partial<{ routeLabel: string; stopId: number }> = {}) =>
    ({ eta, busName, routeLabel: "Red", stopId: 11, ...over });

  it("reads the FIRST entry for its (line, stop) — the one the row prints — and ignores every other line and stop", () => {
    const alerts = [alert({ leadMin: 3 })];
    const arrivals = [
      arr(20, "#1", { routeLabel: "Blue Day" }),   // another line at the same stop
      arr(25, "#2", { stopId: 12 }),               // the same line at another stop
      arr(150, "#304"),                             // THIS row: the soonest Red at 11
      arr(170, "#316"),                             // a later Red — not what the row prints
    ];
    const { alerts: next, pings } = stepStopAlerts(alerts, arrivals, T0);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({
      kind: "lead", busName: "#304", etaSec: 150, tag: "stop-alert-Red-11",
      message: "Red reaches 344 Winchester in about 2 min",
    });
    expect(next[0]!.fired).toEqual({ busName: "#304", lead: true, arrival: false });
  });

  it("an arrival ping DISARMS the alert", () => {
    const { alerts: next, pings } = stepStopAlerts([alert()], [arr(12, "#304")], T0);
    expect(pings.map((p) => p.kind)).toEqual(["arrival"]);
    expect(next).toHaveLength(0);
  });

  it("returns the SAME array when nothing fires, so the page does not re-render on every poll", () => {
    const alerts = [alert()];
    expect(stepStopAlerts(alerts, [arr(900, "#304")], T0).alerts).toBe(alerts);
    expect(stepStopAlerts(alerts, [], T0).alerts).toBe(alerts);
  });

  it("run poll after poll, a closing bus pings exactly twice and the alert is gone", () => {
    let alerts = [alert({ leadMin: 3 })];
    const said: string[] = [];
    for (const eta of [400, 300, 200, 175, 150, 90, 60, 40, 25, 10, 0]) {
      const step = stepStopAlerts(alerts, [arr(eta, "#304")], T0);
      said.push(...step.pings.map((p) => p.message));
      alerts = step.alerts;
    }
    expect(said).toEqual([
      "Red reaches 344 Winchester in about 2 min",
      "Red is at 344 Winchester now",
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("two alerts in one poll are decided independently", () => {
    const alerts = [alert(), alert({ stopId: 12, stopName: "Division / Prospect", leadMin: 5 })];
    const { alerts: next, pings } = stepStopAlerts(alerts, [arr(20, "#304"), arr(240, "#304", { stopId: 12 })], T0);
    expect(pings.map((p) => `${p.kind}@${p.alert.stopId}`)).toEqual(["arrival@11", "lead@12"]);
    expect(next.map((a) => a.stopId)).toEqual([12]);
  });
});

describe("expiry", () => {
  const scheduled = () => true;
  const closed = () => false;

  it("keeps live arms and returns the SAME array when nothing is dropped", () => {
    const a = [alert(), alert({ stopId: 12 })];
    expect(expireStopAlerts(a, T0 + 60_000, scheduled)).toBe(a);
  });

  it("drops an arm two hours old", () => {
    const a = [alert(), alert({ stopId: 12, createdAt: T0 + STOP_ALERT_TTL_MS })];
    const kept = expireStopAlerts(a, T0 + STOP_ALERT_TTL_MS + 1, scheduled);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.stopId).toBe(12);
  });

  it("drops an arm once its line has stopped running", () => {
    const a = [alert()];
    expect(expireStopAlerts(a, T0 + CLOSE_GRACE_MS + 1, closed)).toHaveLength(0);
  });

  it("but NOT inside the grace — a rider watching a live bus past the timetable keeps their arm", () => {
    const a = [alert()];
    expect(expireStopAlerts(a, T0 + CLOSE_GRACE_MS - 1, closed)).toBe(a);
  });

  it("asks the schedule about the alert's own line, at the alert's own clock", () => {
    const seen: string[] = [];
    expireStopAlerts([alert(), alert({ routeLabel: "Blue Day", stopId: 12 })],
      T0 + CLOSE_GRACE_MS + 1, (label, d) => { seen.push(`${label}@${d.getTime()}`); return true; });
    expect(seen).toEqual([`Red@${T0 + CLOSE_GRACE_MS + 1}`, `Blue Day@${T0 + CLOSE_GRACE_MS + 1}`]);
  });
});

describe("the words", () => {
  it("names the line, the stop and the time — 'min', never 'm'", () => {
    expect(stopAlertMessage("lead", alert(), 185)).toBe("Red reaches 344 Winchester in about 3 min");
    expect(stopAlertMessage("arrival", alert(), 8)).toBe("Red is at 344 Winchester now");
  });

  it("says plain words under a minute rather than 'in about <1 min'", () => {
    expect(stopAlertMessage("lead", alert(), 45)).toBe("Red reaches 344 Winchester in less than a minute");
    expect(stopAlertMessage("lead", alert(), 5)).toBe("Red reaches 344 Winchester in less than a minute");
  });

  it("never spells minutes 'm'", () => {
    for (const sec of [45, 61, 185, 540]) {
      expect(stopAlertMessage("lead", alert(), sec)).not.toMatch(/\b\d+\s?m\b/);
    }
  });

  it("one notification tag per (line, stop), and never the leave reminder's", () => {
    expect(stopAlertTag(alert())).toBe("stop-alert-Red-11");
    expect(stopAlertTag(alert({ stopId: 12 }))).not.toBe(stopAlertTag(alert()));
    expect(stopAlertTag(alert())).not.toBe("leave-reminder");
  });
});

describe("the chooser's permission line", () => {
  it("before the prompt, says what the prompt is for", () => {
    expect(stopAlertPermissionHint("default")).toMatch(/^Your browser will ask to allow notifications — that is how the ping reaches you\./);
  });
  it("granted, says only the limit of a client-side alert", () => {
    expect(stopAlertPermissionHint("granted")).toBe("Works while this app is open, even in the background.");
  });
  it("blocked or unsupported (iOS Safari), says where the alert WILL show", () => {
    for (const s of ["denied", "unsupported"] as const) {
      expect(stopAlertPermissionHint(s)).toMatch(/top of the app/);
    }
  });
});

describe("storage", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("round-trips an armed alert, fired state included", () => {
    const a = [markStopAlertFired(alert(), "lead", "#304")];
    saveStopAlerts(a);
    expect(JSON.parse(store[STOP_ALERTS_KEY]!)).toHaveLength(1);
    const back = loadStopAlerts();
    expect(back).toEqual(a);
  });

  it("an empty or missing store is an empty list", () => {
    expect(loadStopAlerts()).toEqual([]);
    store[STOP_ALERTS_KEY] = "";
    expect(loadStopAlerts()).toEqual([]);
  });

  it("SWALLOWS a corrupt blob, a non-array, and junk rows", () => {
    store[STOP_ALERTS_KEY] = "{not json";
    expect(loadStopAlerts()).toEqual([]);
    store[STOP_ALERTS_KEY] = JSON.stringify({ routeLabel: "Red" });
    expect(loadStopAlerts()).toEqual([]);
    store[STOP_ALERTS_KEY] = JSON.stringify([null, 5, "x", {}, { stopId: 11 }, { routeLabel: "Red" }]);
    expect(loadStopAlerts()).toEqual([]);
  });

  it("repairs a bad lead time and a missing stop name rather than dropping the arm", () => {
    store[STOP_ALERTS_KEY] = JSON.stringify([{ routeLabel: "Red", stopId: 11, leadMin: 99 }]);
    const back = loadStopAlerts();
    expect(back).toHaveLength(1);
    expect(back[0]!.leadMin).toBe(DEFAULT_LEAD_MIN);
    expect(back[0]!.stopName).toBe("Stop 11");
    expect(back[0]!.createdAt).toBe(0); // so `expireStopAlerts` retires it at once
  });

  it("de-duplicates and bounds what it reads back", () => {
    const rows = [alert(), alert({ leadMin: 5 })];
    for (let i = 0; i < MAX_STOP_ALERTS + 4; i++) rows.push(alert({ stopId: 200 + i }));
    store[STOP_ALERTS_KEY] = JSON.stringify(rows);
    const back = loadStopAlerts();
    expect(back.length).toBeLessThanOrEqual(MAX_STOP_ALERTS);
    expect(back.filter((a) => a.stopId === 11)).toHaveLength(0); // bounded out, not duplicated
    expect(new Set(back.map((a) => alertKey(a.routeLabel, a.stopId))).size).toBe(back.length);
  });

  it("BLOCKED STORAGE NEVER THROWS — neither read nor write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("The operation is insecure."); },
      setItem: () => { throw new Error("The operation is insecure."); },
    });
    expect(loadStopAlerts()).toEqual([]);
    expect(() => saveStopAlerts([alert()])).not.toThrow();
  });

  it("and neither does a missing localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadStopAlerts()).toEqual([]);
    expect(() => saveStopAlerts([alert()])).not.toThrow();
  });
});

describe("delivery — the leave reminder's plumbing, under the alert's own tag", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubPageNotification() {
    const shown: { title: string; opts: { body: string; tag: string }; n: { onclick: null | (() => void); close: () => void } }[] = [];
    const focus = vi.fn();
    class FakeNotification {
      static permission = "granted";
      onclick: null | (() => void) = null;
      close = vi.fn();
      constructor(title: string, opts: { body: string; tag: string }) {
        shown.push({ title, opts, n: this });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("window", { Notification: FakeNotification, focus });
    return { shown, focus };
  }

  it("passes the alert's tag, so two arms never overwrite each other's ping", async () => {
    const { shown } = stubPageNotification();
    vi.stubGlobal("navigator", {});
    const a = alert();
    expect(await deliverPing(stopAlertMessage("lead", a, 185), stopAlertTag(a))).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.opts).toEqual({ body: "Red reaches 344 Winchester in about 3 min", tag: "stop-alert-Red-11" });
  });

  it("leaves the leave reminder's tag exactly as it was", async () => {
    const { shown } = stubPageNotification();
    vi.stubGlobal("navigator", {});
    await deliverPing("Time to leave");
    expect(shown[0]!.opts.tag).toBe("leave-reminder");
  });

  it("TAPPING THE NOTIFICATION FOCUSES THE APP", async () => {
    const { shown, focus } = stubPageNotification();
    vi.stubGlobal("navigator", {});
    await deliverPing("Red is at 344 Winchester now", "stop-alert-Red-11");
    shown[0]!.n.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(shown[0]!.n.close).toHaveBeenCalledTimes(1);
  });

  it("prefers the service worker registration, with the same tag", async () => {
    const { shown } = stubPageNotification();
    const showNotification = vi.fn(async () => {});
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ showNotification }) } });
    expect(await deliverPing("Red is at 344 Winchester now", "stop-alert-Red-11")).toBe(true);
    expect(showNotification).toHaveBeenCalledWith("Yale Shuttle Tracker", { body: "Red is at 344 Winchester now", tag: "stop-alert-Red-11" });
    expect(shown).toHaveLength(0);
  });

  it("the service worker handles the tap too — a registration notification has no page behind it", () => {
    const sw = fs.readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
    expect(sw).toMatch(/addEventListener\("notificationclick"/);
    expect(sw).toMatch(/clients\.matchAll\(/);
    expect(sw).toMatch(/\.focus\(\)/);
  });

  it("without permission it shows nothing, so the caller falls back to the in-app line", async () => {
    stubPageNotification();
    (globalThis as unknown as { Notification: { permission: string } }).Notification.permission = "denied";
    vi.stubGlobal("navigator", {});
    expect(await deliverPing("Red is at 344 Winchester now", "stop-alert-Red-11")).toBe(false);
  });
});

describe("the page's engine asks the ONE estimator (source-level — TransitMap cannot be rendered here)", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./TransitMap.tsx", import.meta.url)), "utf8");
  const start = src.indexOf("THE ENGINE — one pass per poll");
  const end = src.indexOf("}, [stopAlerts, buses, routeStops, stopCoords, segmentTimes, dwellTimes]);", start);
  const engine = src.slice(start, end);

  it("exists, and is a single effect keyed on the poll", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("prices through computeUpcomingArrivals with the shared belief store — no second arithmetic", () => {
    expect(engine).toMatch(/computeUpcomingArrivals\(\s*targets, buses, routeStops, stopCoords, segmentTimes, nowMs, dwellTimes, liveAnchorStore,/);
    // ...and hands that answer, unfiltered, to the pure step.
    expect(engine).toMatch(/stepStopAlerts\(live, arrivals, nowMs\)/);
    // Nothing on this path re-derives an ETA from the tables or the feed.
    for (const forbidden of ["segmentTimes[", "dwellTimes[", ".avg", "at_stop_since", "haversine"]) {
      expect(engine).not.toContain(forbidden);
    }
  });

  it("does not log what it computed as SHOWN — nobody saw it", () => {
    expect(engine).not.toContain("noteShown(");
  });

  it("keeps the arms in the page shell, out of the hiddenRoutes reset", () => {
    expect(src).toMatch(/useState<StopAlert\[\]>\(\(\) => loadStopAlerts\(\)\)/);
    expect(engine).not.toContain("hiddenRoutes");
  });
});
