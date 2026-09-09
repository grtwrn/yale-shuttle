/**
 * The one failure this change can hide until production.
 *
 * `src/server/serverEta.ts` imports the estimator from `web/src/`, and the
 * runtime image is built from `src/` alone — only `web/dist` (the compiled
 * bundle) is copied into it. So a file the server imports and the Dockerfile
 * does not copy type-checks, unit-tests, builds and then crashes the process
 * on boot with a module-not-found. Every gate in the repo would be green.
 *
 * This walks the real import graph out of `serverEta.ts` and requires the
 * Dockerfile's backend stage to copy every `web/` file it reaches. TYPE-ONLY
 * imports count: `verbatimModuleSyntax` erases them today, but a later edit
 * that turns one into a value import must not be the thing that discovers
 * this, and the file is a few kilobytes either way.
 *
 * If this fails: add the file to the `COPY web/src/...` lines in the
 * Dockerfile. Do NOT relax the test — and think twice about the import, since
 * anything browser-only cannot run in the collector at all.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const ENTRY = path.join(ROOT, "src/server/serverEta.ts");

/** Relative static imports/re-exports, including multiline and type-only declarations. */
function importsFromSource(src: string, file = "source.ts"): string[] {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const spec = statement.moduleSpecifier;
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) out.push(spec.text);
  }
  return out;
}

function importsOf(file: string): string[] {
  return importsFromSource(fs.readFileSync(file, "utf8"), file);
}

function resolveSpec(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = resolveSpec(file, spec);
      expect(target, `${path.relative(ROOT, file)} imports ${spec}, which does not resolve`).not.toBeNull();
      queue.push(target!);
    }
  }
  return seen;
}

describe("static dependency extraction", () => {
  it("follows multiline imports, re-exports, type-only and side-effect imports", () => {
    const source = `
      import { analyticMixture, analyticResidual,
        atomQuantiles } from "./standingDistribution";
      export {
        atomQuantiles
      } from "./reexport";
      import type {
        Ring
      } from "./ring";
      export type { Dist } from "./dist";
      import "./register";
      import { external } from "external-package";
      // import { ignored } from "./comment";
      const text = 'export { ignored } from "./string"';
    `;
    expect(importsFromSource(source)).toEqual([
      "./standingDistribution", "./reexport", "./ring", "./dist", "./register",
    ]);
  });
});

describe("the estimator the server imports reaches the runtime image", () => {
  const files = [...closure(ENTRY)].map((f) => path.relative(ROOT, f)).sort();
  const web = files.filter((f) => f.startsWith("web/"));
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  // The backend stage only — the web stage copies web/ wholesale for the Vite
  // build, which proves nothing about what the runtime image holds.
  const backendStage = dockerfile.slice(dockerfile.indexOf("AS backend"), dockerfile.indexOf("# ---- Runtime"));

  it("reaches into web/ at all, and nowhere else surprising", () => {
    expect(web.length).toBeGreaterThan(5);
    // The one file outside both trees is the stop-order repair, which is
    // already in `src/` and therefore already in the image.
    for (const f of files) {
      expect(f.startsWith("src/") || f.startsWith("web/src/"), `unexpected file ${f}`).toBe(true);
    }
  });

  it("imports nothing browser-only", () => {
    // The estimator must run in the collector, where there is no window, no
    // document, no localStorage and no React.
    for (const f of web) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const bad of ["window.", "document.", "localStorage", "navigator.", "from \"react"]) {
        expect(src.includes(bad), `${f} touches ${bad}`).toBe(false);
      }
    }
  });

  it("includes the standing distribution behind the actual multiline import", () => {
    expect(importsOf(path.join(ROOT, "web/src/eta/standingForecast.ts"))).toContain("./standingDistribution");
    expect(web).toContain("web/src/eta/standingDistribution.ts");
  });

  it("detects an omitted transitive module even when its importer is copied", () => {
    const omitted = "web/src/eta/standingDistribution.ts";
    const incomplete = backendStage.replaceAll(omitted, "");
    expect(incomplete).toContain("web/src/eta/standingForecast.ts");
    expect(web.filter((file) => !incomplete.includes(file))).toEqual([omitted]);
  });

  it.each(web)("Dockerfile copies %s into the backend stage", (f) => {
    expect(backendStage).toContain(f);
  });
});
