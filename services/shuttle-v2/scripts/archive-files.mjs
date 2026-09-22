import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Resolve the immutable file selected by a manifest, or a legacy archive file. */
export function archiveTableFile(dir, table, manifest) {
  if (manifest === undefined) {
    const file = path.join(dir, "manifest.json");
    manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }
  const relative = manifest?.tables?.[table]?.file ?? `${table}.jsonl.gz`;
  const file = path.resolve(dir, relative);
  if (path.isAbsolute(relative) || !file.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`archive file escapes day directory: ${table}`);
  }
  return file;
}

export function readArchiveTable(dir, table, manifest) {
  const file = archiveTableFile(dir, table, manifest);
  if (!fs.existsSync(file)) return [];
  return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
}
