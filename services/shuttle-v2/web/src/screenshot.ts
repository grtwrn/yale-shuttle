// Attaching a screenshot: one implementation, used by the report form and by
// a follow-up reply.
//
// Phones produce 12 MP screenshots and nobody triages bugs at 12 MP, so the
// browser shrinks to <=1280 px and re-encodes as JPEG before anything is sent.
// The server caps the decoded image at 2 MB and verifies the magic bytes; this
// is the polite half of that contract, not a security boundary.

/** Longest edge, in pixels, of what we send. */
export const MAX_EDGE_PX = 1280;
/** Base64 is 4/3 of the bytes, so this is the server's 2 MB cap with headroom. */
export const MAX_DATA_URL_LEN = 2.6 * 1024 * 1024;

/** Scale factor that fits the longest edge into MAX_EDGE_PX. Never enlarges. */
export function scaleFor(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return Math.min(1, MAX_EDGE_PX / longest);
}

export type AttachResult =
  | { dataUrl: string }
  | { error: "not_an_image" | "unreadable" | "too_large" };

/** Human text for an AttachResult error — the panels share the wording. */
export function attachErrorText(error: "not_an_image" | "unreadable" | "too_large"): string {
  switch (error) {
    case "not_an_image": return "That's not an image";
    case "too_large": return "Image too large";
    default: return "Couldn't read the image";
  }
}

/**
 * The image in a paste or a drop, if there is one.
 *
 * A phone screenshot copied from the share sheet, or a desktop
 * screenshot on the clipboard, arrives as a `File` in `clipboardData.items`
 * — the rider should not have to save it somewhere and then go find it in a
 * file picker. Returns null for a plain text paste, which must keep its
 * normal behaviour.
 */
export function imageFromTransfer(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  try {
    const files = data.files;
    if (files) {
      for (const f of Array.from(files)) {
        if (f && f.type.startsWith("image/")) return f;
      }
    }
    const items = data.items;
    if (items) {
      for (const it of Array.from(items)) {
        if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  } catch {
    /* a clipboard we are not allowed to read is the same as an empty one */
  }
  return null;
}

/**
 * Downscale a picked file to a JPEG data URL. Never throws: every failure
 * comes back as an `error`, because a screenshot that will not load must not
 * cost the rider the words they already typed.
 */
export function downscaleToDataUrl(file: File | undefined | null): Promise<AttachResult> {
  return new Promise((resolve) => {
    if (!file) return resolve({ error: "unreadable" });
    if (!file.type.startsWith("image/")) return resolve({ error: "not_an_image" });
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      return resolve({ error: "unreadable" });
    }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const scale = scaleFor(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const g = canvas.getContext("2d");
        if (!g) return resolve({ error: "unreadable" });
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        if (dataUrl.length > MAX_DATA_URL_LEN) return resolve({ error: "too_large" });
        resolve({ dataUrl });
      } catch {
        resolve({ error: "unreadable" });
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ error: "unreadable" });
    };
    img.src = url;
  });
}
