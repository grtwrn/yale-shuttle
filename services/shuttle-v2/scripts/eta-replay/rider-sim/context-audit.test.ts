import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  activationCheck, classifyLookup, createAudit, instrumentSource, SUPPORTED_SOURCE_SHA256,
} from "./context-audit.mjs";

const clientRoot = path.resolve(process.env.STANDING_AUDIT_CLIENT_ROOT ?? process.cwd());
const requireClient = createRequire(path.join(clientRoot, "package.json"));
const { transformSync } = requireClient("esbuild");
const clientSourcePath = path.join(clientRoot, "web/src/eta/standingForecast.ts");
const rawSource = fs.readFileSync(clientSourcePath, "utf8");
const auditUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "context-audit.mjs")).href;
const START = 1_780_000_000_000;
const prior = {
  route_id: 3, route_pattern_id: "audit-positive-fixture", canonical_stop_ids: [11, 48], stop_id: 11, stop_index: 0,
  observed_visit_start_at: START, previous_departed_at: START - 3_600_000, history_available_at: START - 60_000,
  phase_slot_at: START + 600_000, phase_error_q: [-60, 0, 60], phase_weight: 0.75,
  duration_dist: { xs: [0, 200, 400, 800], ps: [0, 0.3, 0.7, 0.95], tail_hazard: 0.01 },
  fitted_at: START - 86_400_000, valid_until: START + 86_400_000,
};
const contexts = (overrides = {}) => new Map([[0, { prior: { ...prior, ...overrides } }]]);
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("offline standing activation audit", () => {
  it("distinguishes absent maps, empty maps and a missing occurrence from clock rejection", () => {
    expect(classifyLookup(null, 0, START)).toEqual(["missing_context_map"]);
    expect(classifyLookup(new Map(), 0, START)).toEqual(["empty_context_map"]);
    expect(classifyLookup(contexts(), 1, START)).toEqual(["no_context_for_occurrence"]);
    expect(classifyLookup(contexts(), 0, START)).toEqual([]);
    expect(classifyLookup(contexts(), 0, Number.NaN)).toEqual(["invalid_visit_start"]);
    expect(classifyLookup(contexts({ previous_departed_at: START }), 0, START)).toEqual(["previous_departure_not_before_start"]);
    expect(classifyLookup(contexts({ history_available_at: START + 1 }), 0, START)).toEqual(["history_after_start"]);
    expect(classifyLookup(contexts({ fitted_at: START + 1 }), 0, START)).toEqual(["fit_after_start"]);
    expect(classifyLookup(contexts({ valid_until: START }), 0, START)).toEqual(["expired_at_start"]);
    expect(classifyLookup(contexts({ history_available_at: START, fitted_at: START }), 0, START)).toEqual([]);
  });

  it("records simultaneous clock failures without relabeling them as missing contexts", () => {
    const { hooks, report } = createAudit();
    const map = contexts({ history_available_at: START + 1, fitted_at: START + 1 });
    hooks.lookup(map, 0, START);
    expect(report.realLookupHits).toBe(0);
    expect(report.rejectionReasons).toEqual({ history_after_start: 1, fit_after_start: 1 });
    expect(report.rejectionCombinations).toEqual({ "history_after_start+fit_after_start": 1 });
    expect(report.lookupByOccurrence).toEqual({ "3:11:0": 1 });
  });

  it("keeps the original bus clocks when the client passes only the context array", () => {
    const { hooks, report } = createAudit();
    const offered = [prior];
    hooks.observeBus({ bus_id: 40, bus_name: "#40", route_id: 3, standing_forecasts: offered,
      stationary_since: "2026-09-04T12:00:00", at_stop_id: 11, at_stop_since: "2026-09-04T12:01:00", lat: 41.3, lon: -72.9,
      unrelated: "must not be copied",
    }, START);
    const map = contexts();
    hooks.readEnd(map, { route_id: 3, standing_forecasts: offered }, { routeId: "3" }, START + 5000, false);
    hooks.lookup(map, 0, START);
    hooks.hit();
    expect(report.firstHits[0]).toMatchObject({ bus: "#40", payloadObservedAt: START, payload: {
      bus_id: 40, bus_name: "#40", route_id: 3, stationary_since: "2026-09-04T12:00:00",
      at_stop_since: "2026-09-04T12:01:00", lat: 41.3, lon: -72.9,
    } });
    expect(report.firstHits[0].payload).not.toHaveProperty("unrelated");
    hooks.lookup(map, 0, START);
    hooks.hit();
    expect(report.realLookupHits).toBe(2);
    expect(report.firstHits).toHaveLength(1);
    expect(report.firstAtStopHits).toHaveLength(1);
    expect(report.firstAtStopHits[0].payload.at_stop_id).toBe(11);
  });

  it("fails a claimed candidate with zero hits or an unused required occurrence", () => {
    const { report } = createAudit();
    expect(activationCheck(report, { expected: true })).toEqual({ ok: false, status: "audit_source_not_loaded" });
    report.source = { sha256: SUPPORTED_SOURCE_SHA256 };
    expect(activationCheck(report, { expected: true })).toEqual({ ok: false, status: "candidate_unused" });
    expect(activationCheck(report, { expected: true, allowUnused: true })).toEqual({ ok: true, status: "unused_diagnostic_only" });
    expect(activationCheck(report, { expected: true, allowUnused: true, requiredCells: ["3:11:0"] }))
      .toEqual({ ok: false, status: "required_cells_unused", missingCells: ["3:11:0"] });
    report.expectedLookupHits = 1;
    expect(activationCheck(report, { expected: true }).status).toBe("audit_accounting_mismatch");
    report.realLookupHits = 1;
    report.hitByOccurrence["3:11:0"] = 1;
    expect(activationCheck(report, { expected: true, requiredCells: ["3:11:0"] }))
      .toEqual({ ok: true, status: "positive_weight_lookup_observed" });
  });

  it("fails closed when client source or transformed instrumentation anchors change", () => {
    const transformed = transformSync(rawSource, {
      loader: "ts", format: "esm", target: "es2022", minifyWhitespace: true, keepNames: true,
    }).code;
    expect(() => instrumentSource(transformed, rawSource)).not.toThrow();
    expect(() => instrumentSource(transformed, rawSource + "\n")).toThrow("source hash changed");
    expect(() => instrumentSource(transformed.replace("const phase=atomQuantiles(", "const changed=atomQuantiles("), rawSource))
      .toThrow("transform guard failed");
    expect(() => instrumentSource(transformed + "const phase=atomQuantiles(", rawSource)).toThrow("transform guard failed");
  });

  it("preserves existing audit evidence instead of overwriting an earlier run", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "standing-audit-existing-"));
    temporary.push(directory);
    const outputPath = path.join(directory, "audit.json");
    fs.writeFileSync(outputPath, "previous evidence\n");
    const source = `
      const {installStandingAudit} = await import(${JSON.stringify(auditUrl)});
      try {
        installStandingAudit(${JSON.stringify(clientRoot)}, ${JSON.stringify(outputPath)});
        throw new Error('existing output was accepted');
      } catch (error) {
        if (!/already exists|refus.*overwrite/i.test(error.message)) throw error;
      }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: clientRoot, encoding: "utf8", timeout: 20_000,
    });
    expect(fs.readFileSync(outputPath, "utf8")).toBe("previous evidence\n");
  });

  it("refuses a source edit between hook installation and module loading", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "standing-audit-edited-"));
    temporary.push(directory);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const fixtureSource = path.join(directory, "web/src/eta/standingForecast.ts");
    fs.mkdirSync(path.dirname(fixtureSource), { recursive: true });
    fs.writeFileSync(fixtureSource, rawSource);
    const source = `
      const fs = await import('node:fs');
      const {installStandingAudit} = await import(${JSON.stringify(auditUrl)});
      installStandingAudit(${JSON.stringify(directory)}, ${JSON.stringify(path.join(directory, "audit.json"))});
      fs.appendFileSync(${JSON.stringify(fixtureSource)}, '\\n');
      try {
        await import(${JSON.stringify(pathToFileURL(fixtureSource).href)});
        throw new Error('edited source was accepted');
      } catch (error) {
        if (!/source.*chang|hash.*chang|changed.*source/i.test(error.message)) throw error;
      }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: clientRoot, encoding: "utf8", timeout: 20_000,
    });
    const report = JSON.parse(fs.readFileSync(path.join(directory, "audit.json"), "utf8"));
    expect(report.source).toBeNull();
    expect(report.incomplete).toBe(true);
  });

  it("observes real successful client lookup without changing distribution outputs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "standing-audit-test-"));
    temporary.push(directory);
    const reportPath = path.join(directory, "audit.json");
    const run = (instrumented: boolean) => {
      // A fresh process avoids an already-imported ESM client bypassing load
      // hooks. This is the same Node + tsx loading path as the rider replay.
      const source = `
        const auditModule = await import(${JSON.stringify(auditUrl)});
        const audit = ${instrumented ? `auditModule.installStandingAudit(${JSON.stringify(clientRoot)}, ${JSON.stringify(reportPath)})` : "null"};
        const client = await import(${JSON.stringify(pathToFileURL(clientSourcePath).href)});
        const prior = ${JSON.stringify(prior)};
        const ring = {routeId: '3', stops: [11,48], N: 2};
        const now = ${START};
        const contexts = client.standingForecastsFor({route_id:3,bus_name:'#40',standing_forecasts:[prior]},ring,now);
        const current = client.forecastForStand(contexts,0,now);
        if (!current) throw new Error('positive-weight client context was unused');
        const output = {
          total: client.standingTotalAtArrival(current),
          remaining: [0,30,180,600,900].map(elapsed => [0.05,0.5,0.95].map(level => client.standingRemaining(current,now+elapsed*1000)(level))),
          departure: [0,30,180,595,600].map(elapsed => client.standingDepartureProbability(current,now+elapsed*1000,5)),
          rejected: [client.forecastForStand(contexts,1,now),client.forecastForStand(contexts,0,now-120000)],
        };
        if (audit) {
          const check = audit.finish({expected:true,requiredCells:['3:11:0']});
          if (!check.ok) throw new Error(JSON.stringify(check));
        }
        console.log(JSON.stringify(output));
      `;
      return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        cwd: clientRoot, encoding: "utf8", timeout: 20_000,
      }));
    };
    const baseline = run(false);
    const instrumented = run(true);
    expect(instrumented).toEqual(baseline);
    expect(baseline.total).toBeGreaterThan(500);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.source.sha256).toBe(SUPPORTED_SOURCE_SHA256);
    expect(report.observationalOnly).toBe(true);
    expect(report.acceptedContexts).toBe(1);
    expect(report.expectedLookupHits).toBe(1);
    expect(report.realLookupHits).toBe(1);
    expect(report.hitByOccurrence).toEqual({ "3:11:0": 1 });
    expect(report.rejectionReasons).toEqual({ no_context_for_occurrence: 1, history_after_start: 1 });
    expect(report.activation).toEqual({ ok: true, status: "positive_weight_lookup_observed" });
  }, 30_000);
});
