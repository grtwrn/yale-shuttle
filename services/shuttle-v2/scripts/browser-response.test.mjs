import { test } from 'vitest';
import assert from 'node:assert/strict';
import { waitForResponseBody, advanceUntilResponse } from './browser-response.mjs';

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

test('advancing to a response cannot cross a second poll and abort the selected request', async () => {
  let time = 0, polls = 0, selectedAborted = false, modelTime = 0;
  const page = { clock: { runFor: async ms => {
    const after = time + ms;
    for (let next = (Math.floor(time / 5000) + 1) * 5000; next <= after; next += 5000) {
      if (polls) selectedAborted = true;
      polls++;
    }
    time = after;
  } } };
  // The old5500ms jumps eventually leave4500ms on the clock; another jump
  // crosses both5000and10000 before the first response can finish.
  time = 4500;
  await advanceUntilResponse(page, polls, () => polls, ms => { modelTime += ms; });
  assert.equal(polls, 1); assert.equal(selectedAborted, false); assert.equal(time, 5000); assert.equal(modelTime, 500);
});
test('advancing without a new request fails instead of reusing an earlier response', async () => {
  await assert.rejects(advanceUntilResponse({ clock: { runFor: async () => {} } }, 3, () => 3, () => {}), /No new feed request/);
});
