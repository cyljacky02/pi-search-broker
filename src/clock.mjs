// Time, for every module that waits on the clock. One seam, two adapters: realClock here, and the tests' fake clock
// (test/helpers.mjs), which fires any timeout or deadline on demand instead of after real milliseconds.
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
