/** Historical ae3 verifier only. Never use this engine for current forecasts. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE_COMMIT = 'ae3ad3ba9fa5ba219b787a5dab185821d5981397';
const MANIFEST_SHA256 = '9bff7eaadb2ae8bec14d0f8f97d313c1c7e46383cf7141d7ee15fb0dd1b58d3a';
const root = fileURLToPath(new URL('./legacy-eta-ae3ad3ba/', import.meta.url));
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function boundedRead(file: string, cap: number) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(cap)) throw Error('Legacy Source extent/type changed');
    const raw = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < raw.length) {
      const count = fs.readSync(fd, raw, offset, Math.min(65536, raw.length - offset), offset);
      if (!count) throw Error('Legacy Source premature EOF');
      offset += count;
    }
    const identity = (v: fs.BigIntStats) => [v.dev, v.ino, v.size, v.mtimeNs, v.ctimeNs].join(':');
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) || identity(before) !== identity(fs.fstatSync(fd, { bigint: true }))
      || identity(before) !== identity(fs.lstatSync(file, { bigint: true }))) throw Error('Legacy Source identity changed');
    return raw;
  } finally { fs.closeSync(fd); }
}
const rawManifest = boundedRead(path.join(root, 'source-manifest.json'), 65536);
if (hash(rawManifest) !== MANIFEST_SHA256) throw Error('Legacy manifest changed');
const manifest = JSON.parse(rawManifest.toString()) as {
  sourceCommit: string; fileCount: number; totalBytes: number;
  files: { relative: string; bytes: number; sha256: string }[];
};
if (manifest.sourceCommit !== SOURCE_COMMIT || manifest.fileCount !== 41 || manifest.files.length !== 41
  || manifest.totalBytes !== 939668) throw Error('Legacy Source domain changed');
for (const entry of manifest.files) {
  if (path.isAbsolute(entry.relative) || entry.relative.split('/').some(p => p === '..' || !p))
    throw Error('Legacy Source path escaped archive');
  const raw = boundedRead(path.join(root, entry.relative), 262144);
  if (raw.length !== entry.bytes || hash(raw) !== entry.sha256) throw Error('Legacy Source bytes changed');
}
// Only import after all exact source bytes have been checked. Every relative
// dependency stays in this archived layout, including parameter/cache state.
const legacy = await import('./legacy-eta-ae3ad3ba/src/server/serverEta.js');
const routes = await import('./legacy-eta-ae3ad3ba/web/src/routes.js');
export const LEGACY_ETA_DOMAIN = Object.freeze({ sourceCommit: SOURCE_COMMIT, manifestSHA256: MANIFEST_SHA256 });
export const LEGACY_ROUTE_LISTS = routes.ROUTE_LISTS;

/** Adds an execution witness only; archived pricing and snapshots are untouched. */
export class LegacyRecordedServerEta extends legacy.ServerEta {
  private readonly pricingWitness: { calls: number };
  constructor(options: ConstructorParameters<typeof legacy.ServerEta>[0]) {
    const witness = { calls: 0 }, callback = options.onBaseForecasts;
    super({ ...options, onBaseForecasts: rows => { witness.calls++; callback?.(rows); } });
    this.pricingWitness = witness;
  }

  override contribute(...args: Parameters<InstanceType<typeof legacy.ServerEta>['contribute']>) {
    const before = this.pricingWitness.calls;
    const wire = super.contribute(...args);
    if (this.pricingWitness.calls !== before + 1) throw Error('Historical oracle must price a future frame, not reuse cached output');
    return wire;
  }
}
