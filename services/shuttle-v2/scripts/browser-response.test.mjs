import { test } from 'vitest';
import assert from 'node:assert/strict';
import { waitForResponseBody } from './browser-response.mjs';

test('a completed body needs no clock advance', async () => {
  let steps = 0;
  await waitForResponseBody({ clock: { runFor: async () => { steps++; } } }, { finished: async () => null });
  assert.equal(steps, 0);
});
test('a response body queued behind the paused browser clock is awaited', async () => {
  let finish, steps = 0;
  const body = new Promise(resolve => { finish = resolve; });
  await waitForResponseBody({ clock: { runFor: async ms => { assert.equal(ms, 1); steps++; if (steps === 2) finish(null); } } }, { finished: () => body });
  assert.equal(steps, 2);
});
test('a response loading error still fails the browser check', async () => {
  await assert.rejects(waitForResponseBody({ clock: { runFor: async () => {} } }, { finished: async () => new Error('loading failed') }), /loading failed/);
});
test('neither a missing body nor a stuck clock command can hang the completion gate', async () => {
  for (const clock of [{ runFor: async () => {} }, { runFor: () => new Promise(() => {}) }]) {
    await assert.rejects(waitForResponseBody({ clock }, { finished: () => new Promise(() => {}) }, 30), /Response body did not finish within 30 ms/);
  }
});
