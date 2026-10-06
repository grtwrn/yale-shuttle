/** rideboardedmemory20261005: exercise the banner's real storage helpers.
 * Extract only the helper block so no DOM/Leaflet mock or parallel SPA
 * implementation can hide a regression. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getOffAlertDue, rideBoarded } from "./rideAlert";
import fixture from "./__fixtures__/ride-boarded-memory-2026-10-05.json";

const source = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
const start = source.indexOf('const RIDE_WINDOW_LS_KEY =');
const end = source.indexOf('// Two retired features', start);
if (start < 0 || end < start) throw new Error("ride storage helpers not found");
const js = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type Ride = { startedAt: number; busName: string; boardStopId: number; alightStopId: number };
type Helpers = { rideBoardedSeen(r: Ride): boolean; noteRideBoarded(r: Ride): void };
const key = "shuttle-ride-boarded";
function helpers(mode: "normal" | "blocked" | "write-blocked" | "access-blocked" = "normal", values = new Map<string, string>()) {
  const storage = {
    getItem(k: string) { if (mode === "blocked") throw new Error("SecurityError"); return values.get(k) ?? null; },
    setItem(k: string, v: string) { if (mode === "blocked" || mode === "write-blocked") throw new Error("QuotaExceededError"); values.set(k, v); },
  };
  const context = mode === "access-blocked"
    ? Object.defineProperty({}, "localStorage", { get() { throw new Error("SecurityError"); } })
    : { localStorage: storage };
  return runInNewContext(js + "\n({rideBoardedSeen, noteRideBoarded})", context) as Helpers;
}
const ride: Ride = { startedAt: 123, busName: "#308", boardStopId: 48, alightStopId: 72 };

describe("boarding remembered in the page even if storage fails", () => {
  for (const mode of ["blocked", "write-blocked", "access-blocked"] as const) {
    it("keeps the observed boarding when storage is " + mode, () => {
      const h = helpers(mode);
      expect(h.rideBoardedSeen(ride)).toBe(false);
      h.noteRideBoarded(ride);
      expect(h.rideBoardedSeen(ride)).toBe(true);
      expect(rideBoarded(h.rideBoardedSeen(ride), 2, 3)).toBe(true);
    });
  }
  it("does not transfer memory to a different ride, bus, pickup, or exit", () => {
    const h = helpers("blocked"); h.noteRideBoarded(ride);
    for (const other of [{...ride, startedAt: 124}, {...ride, busName: "#309"}, {...ride, boardStopId: 49}, {...ride, alightStopId: 73}]) {
      expect(h.rideBoardedSeen(other)).toBe(false);
      expect(rideBoarded(h.rideBoardedSeen(other), 2, 3)).toBe(false);
    }
    expect(h.rideBoardedSeen({...ride, busName: "308"})).toBe(true);
  });
  it("still restores boarding after a reload when storage works", () => {
    const values = new Map<string,string>(); helpers("normal", values).noteRideBoarded(ride);
    expect(values.get(key)).toBe("123:308:48:72");
    expect(helpers("normal", values).rideBoardedSeen(ride)).toBe(true);
    expect(helpers("normal", values).rideBoardedSeen({...ride, startedAt:124})).toBe(false);
  });
  it("does not invent boarding after a storage-blocked reload or exit-only start", () => {
    const h = helpers("blocked");
    expect(rideBoarded(h.rideBoardedSeen(ride), 2, 3)).toBe(false);
    h.noteRideBoarded(ride);
    expect(helpers("blocked").rideBoardedSeen(ride)).toBe(false);
  });
  it("keeps just the last remembered ride, not an unbounded history", () => {
    const h = helpers("blocked"); h.noteRideBoarded(ride);
    const next = {...ride, startedAt:124};h.noteRideBoarded(next);
    expect(h.rideBoardedSeen(next)).toBe(true);
    expect(h.rideBoardedSeen(ride)).toBe(false);
  });
  it("rejects foreign and corrupt persisted keys", () => {
    for (const v of ["garbage", "122:308:48:72", "123:308:48:72#rode"]) {
      expect(helpers("normal", new Map([[key,v]])).rideBoardedSeen(ride)).toBe(false);
    }
  });
  it("the SPA reads and records these helpers for the boarded alert guard", () => {
    expect(source).toContain("const boarded = rideBoarded(rideBoardedSeen(ride), busRow, rideCallList.length);");
    expect(source).toContain("useEffect(() => { if (boarded) noteRideBoarded(ride); }, [boarded, ride]);");
    expect(source).toContain("if (!boarded) return;");
  });
});

function firstAlert(r: typeof fixture.rides[number], mode: "normal" | "blocked") {
  const h = helpers(mode);
  const identity: Ride = {...ride, startedAt:Date.parse(r.boardedAt),busName:r.busName,boardStopId:r.boardStopId,alightStopId:r.alightStopId};
  for (const p of r.polls) {
    const boarded = rideBoarded(h.rideBoardedSeen(identity), p.bus ? p.row : -1, r.callCount);
    // OnBusBanner's effect follows render; the alert uses this render's boarded.
    if (boarded) h.noteRideBoarded(identity);
    if (p.bus && boarded && getOffAlertDue(p.count,p.eta,p.departNow,p.distM)) return p;
  }
  return null;
}
describe("the two independent-review recorded here-first alert losses", () => {
  for (const r of fixture.rides) {
    it(r.routeLabel + " " + r.boardStopId + "->" + r.alightStopId + " run " + r.runId + " alerts at the same here poll as working storage", () => {
      const working = firstAlert(r,"normal");
      expect(working?.count).toBe(0);
      expect(firstAlert(r,"blocked")).toEqual(working);
    });
  }
});


// PR387 moved this malformed-key access outside the protective catch.
// Do not tighten the loader: these recent legacy records used to restore.
describe("accepted legacy rides and invalid boarding identities", () => {
  const loaderStart = source.indexOf('const BOARDED_LS_KEY =');
  const loaderEnd = source.indexOf('// What this ride', loaderStart);
  const loaderJs = ts.transpileModule(source.slice(loaderStart, loaderEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const busName of [undefined, null, 308, {}, "", "#"]) {
    it("does not throw or remember invalid busName " + JSON.stringify(busName), () => {
      const restored = { ...ride, routeLabel: "Legacy Unknown", color: "#e53935", startedAt: Date.now(), busName };
      const loaded = runInNewContext(loaderJs + "\nloadBoardedRide()", {
        localStorage: { getItem: () => JSON.stringify(restored) },
      }) as Ride;
      expect(loaded).not.toBeNull();
      for (const mode of ["normal", "blocked", "write-blocked", "access-blocked"] as const) {
        const values = new Map<string, string>();
        const h = helpers(mode, values);
        h.noteRideBoarded(ride);
        expect(() => h.rideBoardedSeen(loaded)).not.toThrow();
        expect(h.rideBoardedSeen(loaded)).toBe(false);
        expect(() => h.noteRideBoarded(loaded)).not.toThrow();
        expect(h.rideBoardedSeen(loaded)).toBe(false);
        expect(h.rideBoardedSeen(ride)).toBe(true);
        if (mode === "normal") expect(values.get(key)).toBe("123:308:48:72");
      }
    });
  }
  it("keeps a valid legacy-route identity and normalized persisted key working", () => {
    const h = helpers("normal");
    const legacy = { ...ride, routeLabel: "Legacy Unknown" };
    h.noteRideBoarded(legacy);
    expect(h.rideBoardedSeen({ ...legacy, busName: "308" })).toBe(true);
  });
  it("does not remember malformed timestamps or stop identities", () => {
    const h = helpers("blocked"); h.noteRideBoarded(ride);
    for (const field of ["startedAt", "boardStopId", "alightStopId"] as const) {
      for (const value of [undefined, null, "123", NaN, Infinity]) {
        const invalid = { ...ride, [field]: value } as Ride;
        expect(() => h.noteRideBoarded(invalid)).not.toThrow();
        expect(h.rideBoardedSeen(invalid)).toBe(false);
        expect(h.rideBoardedSeen(ride)).toBe(true);
      }
    }
  });
  it("catches key computation before either memory comparison or assignment", () => {
    const h = helpers("blocked"); h.noteRideBoarded(ride);
    for (const field of ["busName", "startedAt", "boardStopId", "alightStopId"] as const) {
      const invalid = Object.defineProperty({ ...ride }, field, { get() { throw Error("corrupt identity"); } });
      expect(() => h.rideBoardedSeen(invalid)).not.toThrow();
      expect(h.rideBoardedSeen(invalid)).toBe(false);
      expect(() => h.noteRideBoarded(invalid)).not.toThrow();
      expect(h.rideBoardedSeen(ride)).toBe(true);
    }
  });
});
