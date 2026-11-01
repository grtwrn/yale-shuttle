import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

// Execute only startup/first-gate behavior. Owned fake commands fail the very
// first gate, so these controls cannot build, stage, contact prod, or deploy.
function startup(image) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-deploy-startup-'));
  directories.push(directory);
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const gateMarker = path.join(directory, 'gate'), flyMarker = path.join(directory, 'fly');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "gate\\n" > "$DEPLOY_TEST_GATE_MARKER"\nexit 73\n', { mode: 0o700 });
  const fly = path.join(bin, 'flyctl');
  fs.writeFileSync(fly, '#!/bin/sh\nprintf "fly\\n" > "$DEPLOY_TEST_FLY_MARKER"\nexit 74\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [script], {
    cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { ...process.env, PATH: bin, TMPDIR: directory, SHUTTLE_DEPLOY_IMAGE: image,
      FLYCTL: fly, DEPLOY_TEST_GATE_MARKER: gateMarker, DEPLOY_TEST_FLY_MARKER: flyMarker },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(fs.existsSync(flyMarker)).toBe(false);
  expect(fs.readdirSync(directory).some(name => name.startsWith('shuttle-stage-'))).toBe(false);
  return { result, gateReached: fs.existsSync(gateMarker) };
}

describe('gated prebuilt image deployment startup', () => {
  it.each([
    'registry.fly.io/yale-shuttle:latest',
    'registry.fly.io/another-app@sha256:' + 'a'.repeat(64),
    'registry.fly.io/yale-shuttle@sha256:' + 'A'.repeat(64),
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(63),
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64) + '\n',
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64) + '\r',
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64) + '\u2028',
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64) + '\u2029',
    'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64) + '\n--detach',
    ' registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64),
  ])('refuses an invalid image before creating staging state or running gates: %s', image => {
    const { result, gateReached } = startup(image);
    expect(gateReached).toBe(false);
    expect(result.stderr).toContain('SHUTTLE_DEPLOY_IMAGE must be');
    expect(result.stdout).not.toContain('stage 1/6');
  });

  it.each(['', 'registry.fly.io/yale-shuttle@sha256:' + 'a'.repeat(64)])(
    'keeps the first mandatory gate for default or valid prebuilt image: %s', image => {
      const { result, gateReached } = startup(image);
      expect(gateReached).toBe(true);
      expect(result.stdout).toContain('stage 1/6: typecheck');
      expect(result.stderr).toContain('typecheck (backend + web) failed (exit 73)');
      expect(result.stdout).not.toContain('stage 2/6');
      expect(result.stdout).not.toContain('stage 5/6');
    },
  );
});
