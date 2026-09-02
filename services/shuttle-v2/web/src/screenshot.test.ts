import { describe, expect, it } from "vitest";

import { attachErrorText, imageFromTransfer, MAX_EDGE_PX, scaleFor } from "./screenshot";

describe("scaleFor", () => {
  it("shrinks the longest edge to the cap", () => {
    expect(scaleFor(4032, 3024)).toBeCloseTo(MAX_EDGE_PX / 4032);
    expect(scaleFor(1170, 2532)).toBeCloseTo(MAX_EDGE_PX / 2532);
  });

  it("never enlarges a small screenshot", () => {
    expect(scaleFor(390, 844)).toBe(1);
    expect(scaleFor(10, 10)).toBe(1);
  });

  it("survives nonsense dimensions rather than producing NaN", () => {
    for (const [w, h] of [[0, 0], [-5, 10], [NaN, 100], [Infinity, 1]]) {
      const s = scaleFor(w as number, h as number);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe("attachErrorText", () => {
  it("has wording for every failure the picker can produce", () => {
    expect(attachErrorText("not_an_image")).toMatch(/image/i);
    expect(attachErrorText("too_large")).toMatch(/large/i);
    expect(attachErrorText("unreadable")).toMatch(/read/i);
  });
});

describe("imageFromTransfer — pasting a screenshot", () => {
  const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });

  const transfer = (opts: { files?: File[]; items?: unknown[] }) =>
    ({ files: opts.files, items: opts.items } as unknown as DataTransfer);

  it("finds an image among the pasted files", () => {
    expect(imageFromTransfer(transfer({ files: [textFile, imageFile] }))).toBe(imageFile);
  });

  it("finds an image among clipboard items when files is empty", () => {
    const items = [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => imageFile },
    ];
    expect(imageFromTransfer(transfer({ items }))).toBe(imageFile);
  });

  it("returns null for a plain text paste, so typing is unaffected", () => {
    expect(imageFromTransfer(transfer({ files: [textFile] }))).toBeNull();
    expect(imageFromTransfer(transfer({ items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] }))).toBeNull();
    expect(imageFromTransfer(transfer({}))).toBeNull();
    expect(imageFromTransfer(null)).toBeNull();
    expect(imageFromTransfer(undefined)).toBeNull();
  });

  it("survives a clipboard that throws on access", () => {
    const hostile = {
      get files() { throw new Error("The operation is insecure."); },
    } as unknown as DataTransfer;
    expect(() => imageFromTransfer(hostile)).not.toThrow();
    expect(imageFromTransfer(hostile)).toBeNull();
  });
});
