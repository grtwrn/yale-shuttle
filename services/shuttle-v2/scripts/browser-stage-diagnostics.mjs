import fs from 'node:fs';

const LIMIT = 32 * 1024;

/** Best-effort diagnostics must never prevent an existing cleanup or failure. */
export function recordBrowserPhase(file, phase, details = {}) {
  let fd;
  try {
    const row = Buffer.from(JSON.stringify({ phase, at: Date.now(), pid: process.pid, ...details }) + '\n');
    if (row.length > 2048) return;
    fd = fs.openSync(file, 'a', 0o600);
    if (fs.fstatSync(fd).size + row.length <= LIMIT) fs.writeSync(fd, row);
  } catch { /* preserve the original check and its cleanup */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* diagnostic only */ } }
}

/** Only bounded local phase records are printed; no environment or argv dump. */
export function browserPhaseEvidence(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(bytes, LIMIT));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const rows = []; let malformedRows = 0;
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.phase !== 'string' || row.phase.length > 80 || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.at)) throw Error();
        rows.push(row);
      } catch { malformedRows++; }
    }
    return { rows, bytes, truncated: bytes > read, malformedRows };
  } catch (error) { return { rows: [], readError: error.code ?? error.name }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* diagnostic only */ } }
}
