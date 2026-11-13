import fs from 'node:fs';

/** Read only the admitted descriptor extent, then one byte to prove EOF.
 * The maximum bounds payload bytes; actual reads are bounded by maximum + 1.
 * A growing, replaced or truncated input is refused, never read to a moving EOF. */
export function readBoundedFile(file: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid bounded input admission');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('Input exceeds admission or is not regular');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error('Input changed before admitted EOF');
      offset += count;
    }
    const extra = fs.readSync(fd, Buffer.alloc(1), 0, 1, null);
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    const unchanged = (value: typeof before) => value.isFile() && before.dev === value.dev && before.ino === value.ino
      && before.size === value.size && before.mtimeNs === value.mtimeNs && before.ctimeNs === value.ctimeNs;
    if (extra !== 0 || !unchanged(after) || !unchanged(named)) throw new Error('Input changed before EOF');
    return bytes;
  } finally { fs.closeSync(fd); }
}
