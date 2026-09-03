import { describe, expect, it } from "vitest";

import { attachErrorText, dragCarriesFile, imageFromTransfer, MAX_EDGE_PX, scaleFor } from "./screenshot";

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

  const transfer = (opts: { files?: File[]; items?: unknown[]; text?: string; types?: string[] }) =>
    ({
      files: opts.files, items: opts.items, types: opts.types,
      getData: (t: string) => (t === "text/plain" ? opts.text ?? "" : ""),
    } as unknown as DataTransfer);

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

describe("a clipboard carrying text as well as an image", () => {
  const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const both = ({
    files: [imageFile],
    types: ["text/plain", "Files"],
    getData: (t: string) => (t === "text/plain" ? "Q1\tQ2\n10\t20" : ""),
  } as unknown as DataTransfer);

  it("lets the text paste through — copying a spreadsheet range must not attach a picture", () => {
    // Excel, Word, LibreOffice and Numbers all publish a bitmap alongside the
    // text. Taking the image swallowed the rider's paste entirely.
    expect(imageFromTransfer(both)).toBeNull();
  });

  it("still attaches when the clipboard is an image only", () => {
    const imageOnly = ({
      files: [imageFile], types: ["Files"], getData: () => "",
    } as unknown as DataTransfer);
    expect(imageFromTransfer(imageOnly)).toBe(imageFile);
  });
});

describe("dragCarriesFile — what a browser exposes mid-drag", () => {
  it("sees a file drag from types alone, which is all protected mode gives", () => {
    // During dragover the files are unreadable and getAsFile() returns null,
    // so the old guard never fired and drop worked only by accident.
    const midDrag = ({
      types: ["Files"],
      files: { length: 0 },
      items: [{ kind: "file", type: "image/png", getAsFile: () => null }],
    } as unknown as DataTransfer);
    expect(dragCarriesFile(midDrag)).toBe(true);
    expect(imageFromTransfer(midDrag)).toBeNull();
  });

  it("says no to a text drag and to nothing at all", () => {
    expect(dragCarriesFile(({ types: ["text/plain"], items: [] } as unknown as DataTransfer))).toBe(false);
    expect(dragCarriesFile(null)).toBe(false);
  });

  it("survives a hostile transfer", () => {
    const hostile = { get types() { throw new Error("nope"); } } as unknown as DataTransfer;
    expect(() => dragCarriesFile(hostile)).not.toThrow();
    expect(dragCarriesFile(hostile)).toBe(false);
  });
});
