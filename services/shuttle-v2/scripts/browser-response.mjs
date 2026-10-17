import { performance } from 'node:perf_hooks';

/** A clock-driven browser can expose response headers before completing its
 * body. Let the browser make small steps while retaining the completion gate.
 * The wall deadline also bounds a stalled clock command. */
export async function waitForResponseBody(page, response, timeoutMs = 5000) {
  let complete = false, failure;
  Promise.resolve().then(() => response.finished()).then(error => {
    failure = error; complete = true;
  }, error => { failure = error; complete = true; });
  const deadline = performance.now() + timeoutMs;
  const bounded = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Response body did not finish within ${timeoutMs} ms`)), Math.max(1, deadline - performance.now()));
      })]);
    } finally { clearTimeout(timer); }
  };
  while (!complete) {
    await bounded(new Promise(resolve => setTimeout(resolve, 10)));
    if (!complete) await bounded(page.clock.runFor(1));
  }
  if (failure) throw failure;
}
