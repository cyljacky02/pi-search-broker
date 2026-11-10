// Time for the Brokered request, which waits on the clock: attempt timeouts, the request deadline and backoff.
// One seam, two adapters: realClock here, and the tests' fake clock (test/helpers.mjs), which fires any timeout or
// deadline on demand instead of after real milliseconds. Modules that only read the time take `now` alone.
//   now()              milliseconds since the epoch
//   sleep(ms, signal)  resolves after `ms`, or as soon as `signal` aborts; never rejects
//   timeout(ms)        an AbortSignal that aborts with a TimeoutError after `ms` (like AbortSignal.timeout)

export const realClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  }),
  timeout: (ms) => AbortSignal.timeout(ms)
});
