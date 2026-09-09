import { describe, expect, it } from "vitest";
import type { StopDataVisit } from "../../../src/schema/stop-data";
import { compareModels, observedStand, preciseClock } from "./analysis";

const visit = (id: string, departedAt = 600_000) => ({ id, pinnedAt: 0, departedAt, outcome: "stopped" } as StopDataVisit);
describe("operator comparison accounting", () => {
  it("uses the physical departure clock for remaining truth, pairs queries, and weights visits equally", () => {
    const forecasts = [0, 100_000, 200_000].flatMap(issuedAt => ["baseline","candidate"].map(model => ({visitId:"a",issuedAt,model,totalSec:300,remainingSec:(600_000-issuedAt)/1000+60,first:issuedAt===0})));
    forecasts.push(...["baseline","candidate"].map(model => ({visitId:"b",issuedAt:0,model,totalSec:600,remainingSec:900,first:true})));
    forecasts.push({visitId:"a",issuedAt:300_000,model:"baseline",totalSec:9999,remainingSec:9999,first:false});
    const result = compareModels([visit("a"),visit("b")],forecasts,["baseline","candidate"]);
    expect(result[0]).toMatchObject({ firstCount:2,firstMae:150,remainingVisits:2,pairedQueries:4,remainingMae:180 });
    expect(result[1]).toEqual({...result[0],model:"candidate"});
  });
  it("does not promote a later pair into the original first display, or score a censored visit", () => {
    const rows = ["baseline","candidate"].map(model => ({visitId:"a",issuedAt:100_000,model,totalSec:300,remainingSec:null,first:model==="candidate"}));
    expect(compareModels([visit("a")],rows,["baseline","candidate"])[0].firstCount).toBe(0);
    expect(observedStand({...visit("a"),departedAt:null})).toBeNull();
    expect(observedStand({...visit("a"),outcome:"unresolved"})).toBeNull();
  });
  it("rejects duplicate arm clocks instead of double counting", () => {
    const p = {visitId:"a",issuedAt:0,model:"baseline",totalSec:300,remainingSec:300,first:true};
    expect(() => compareModels([visit("a")],[p,p],["baseline"])).toThrow("Duplicate");
  });
  it("formats the operator clock in Eastern time independent of host timezone", () => {
    expect(preciseClock(Date.parse("2026-09-08T12:00:00Z"))).toBe("8:00:00 AM");
  });
  it("keeps censored visits visible without treating their clock difference as a complete wait", () => {
    const censored = {...visit("a"),leftCensored:true,labelStatus:"censored"};
    expect(observedStand(censored)).toBeNull();
    const rows = ["baseline","candidate"].map(model => ({visitId:"a",issuedAt:0,model,totalSec:300,remainingSec:300,first:true}));
    expect(compareModels([censored],rows,["baseline","candidate"])[0].firstCount).toBe(0);
  });
  it("scores no query before the physical pin or at departure", () => {
    const v={...visit("a"),pinnedAt:100_000};
    const rows=[0,600_000].flatMap(issuedAt=>["baseline","candidate"].map(model=>({visitId:"a",issuedAt,model,totalSec:300,remainingSec:300,first:true})));
    expect(compareModels([v],rows,["baseline","candidate"])[0]).toMatchObject({firstCount:0,remainingVisits:0,pairedQueries:0});
  });
});
