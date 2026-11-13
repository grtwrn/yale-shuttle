import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readBoundedFile } from './bounded-read.js';

describe('bounded regular input custody', () => {
  it('refuses a growing descriptor after at most its admitted extent plus one EOF byte', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-bounded-'));
    const file = path.join(directory, 'input');
    fs.writeFileSync(file, 'abc');
    const actualRead = fs.readSync.bind(fs);
    let requested = 0, read = 0, grew = false;
    const spy = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      requested += length;
      if (!grew) { grew = true; fs.appendFileSync(file, Buffer.alloc(1024 * 1024)); }
      const count = actualRead(fd, buffer, offset, length, position); read += count; return count;
    }) as typeof fs.readSync);
    try {
      expect(() => readBoundedFile(file, 3)).toThrow(/changed/);
      expect(requested).toBe(4); expect(read).toBe(4);
    } finally { spy.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('accepts exact finite bytes and refuses oversize and symlink inputs before reading them', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-bounded-'));
    try {
      const file = path.join(directory, 'input'), link = path.join(directory, 'link');
      fs.writeFileSync(file, 'abc'); fs.symlinkSync(file, link);
      expect(readBoundedFile(file, 3).toString()).toBe('abc');
      expect(() => readBoundedFile(file, 2)).toThrow(/admission/);
      expect(() => readBoundedFile(link, 3)).toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
