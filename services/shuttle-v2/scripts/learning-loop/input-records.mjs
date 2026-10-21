import fs from 'node:fs';
import path from 'node:path';
import { createGunzip, constants as zlibConstants } from 'node:zlib';

const MiB = 1024 * 1024;
// A source page draws from the producer's 16 MiB ring; its escaped frames
// plus current public view fit within 64 MiB. Whole hours need not fit in a
// JavaScript string. Budgets refuse oversized input rather than omit records.
export const INPUT_READ_LIMITS = Object.freeze({ compressedBytes: 256 * MiB,
  decodedBytes: 4 * 1024 * MiB, recordBytes: 64 * MiB });

export function inputFiles(directory) {
  return fs.readdirSync(directory).filter(name => /^feed-.*\.jsonl\.gz$/.test(name)).sort()
    .map(name => path.join(directory, name));
}

/** Read the exact complete lines, including concatenated gzip members and
 * an open gzip/JSON tail, without materializing a whole hour in one string. */
export async function* readInputLines(file, limits = INPUT_READ_LIMITS) {
  for (const key of ['compressedBytes', 'decodedBytes', 'recordBytes'])
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw Error('Invalid input read budget');
  const size = fs.statSync(file).size;
  if (size > limits.compressedBytes) throw Error('Retained input compressed-file budget exceeded');
  if (!size) return;
  const source = fs.createReadStream(file, { start: 0, end: size - 1 });
  const decoder = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
  source.once('error', error => decoder.destroy(error));
  source.pipe(decoder);
  let parts = [], carried = 0, decoded = 0;
  try {
    for await (const chunk of decoder) {
      decoded += chunk.length;
      if (decoded > limits.decodedBytes) throw Error('Retained input decoded-file budget exceeded');
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const segment = chunk.subarray(start, end), length = carried + segment.length;
        if (length > limits.recordBytes) throw Error('Retained input record budget exceeded');
        const raw = (parts.length ? Buffer.concat([...parts, segment], length) : segment).toString('utf8');
        parts = []; carried = 0; start = end + 1;
        if (raw.length) yield raw;
      }
      if (start < chunk.length) {
        const tail = chunk.subarray(start); carried += tail.length;
        if (carried > limits.recordBytes) throw Error('Retained input record budget exceeded');
        parts.push(tail);
      }
    }
    // A tail without a newline does not attest a complete JSON record.
  } finally {
    source.destroy(); decoder.destroy();
  }
}

export async function* readInputRecords(directory, limits = INPUT_READ_LIMITS) {
  for (const file of inputFiles(directory)) for await (const raw of readInputLines(file, limits))
    yield { raw, input: JSON.parse(raw) };
}
