// Brokered request: run one client request across an account pool, attempt by attempt, until a provider answers
// or every account is used up. No HTTP server knowledge lives here: callers hand in a parsed body and get back
// { status, body } to send. Billing-safety rules (docs/research/exa.md, docs/research/tavily.md):
//  - every reservation ends exactly once (billed, possibly billed, or released);
//  - an attempt that may have been billed (timeout, client gone, unreadable 2xx, ambiguous network) is never retried;
//  - a refused request is never retried on another account;
//  - an Attempt whose ending cannot be saved stops the request: aborted if it may have cost money, else paused.
import { PROVIDERS, ACTION, EFFECT, EXHAUST } from './providers.mjs';
import { POSSIBLY_BILLED, ENDING, StateNotSaved } from './pool.mjs';

/** Status returned when the caller aborted: nobody is listening, so there is nothing to send. */
export const CLIENT_CLOSED = 499;

const MAX_ERROR_BODY = 64 * 1024;
const STREAM_REJECTED = 'Streaming responses (stream: true) are not supported by the local search broker';
const PRE_DELIVERY_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const defaultSleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

async function sleepUnlessAborted(sleep, ms, signal) {
  if (signal.aborted) return;
  let onAbort;
  const aborted = new Promise((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
  try { await Promise.race([sleep(ms, signal), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

// Generic fetch errors, resets, and socket closes do not prove that the request was never delivered.
function isPreDeliveryConnectionError(error, seen = new Set()) {
  let found = false;
  while (error && (typeof error === 'object' || typeof error === 'function')) {
    if (seen.has(error)) return false;
    seen.add(error);
    // Node can aggregate connection attempts. Every member must independently prove pre-delivery failure.
    if (Array.isArray(error.errors)) {
      if (!error.errors.length || !error.errors.every((cause) => isPreDeliveryConnectionError(cause, seen))) return false;
      found = true;
    }
    if (error.code !== undefined) {
      if (!PRE_DELIVERY_CODES.has(error.code)) return false;
      found = true;
    }
    error = error.cause;
  }
  return found;
}

async function readErrorJson(response) {
  let text = '';
  try { text = (await response.text()).slice(0, MAX_ERROR_BODY); } catch { /* treat as empty */ }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param pool      account pool (see pool.mjs): attempt(route, estimate, excludedIds, use) runs `use` on a Reservation
 * @param limits    { totalTimeoutMs, attemptTimeoutMs?, maxTransientRetries }
 * @param secrets   strings to redact from anything returned to the client
 */
export function createBroker({ pool, limits, secrets = [], fetchImpl = fetch, now = () => Date.now(), sleep = defaultSleep }) {
  /** Run one request. Never throws for upstream behaviour or unsaved account state; always returns { status, body }. */
  async function execute(route, body, { headers = {}, signal } = {}) {
    const policy = PROVIDERS[route.provider];
    // An SSE reply cannot be parsed or metered here, and would be retried (and billed) on every account.
    if (body.stream) return { status: 400, body: policy.errorBody(STREAM_REJECTED, { tag: 'BROKER_UNSUPPORTED' }) };
    const estimate = policy.quote(body, route.path);
    const deadline = now() + limits.totalTimeoutMs;
    const clientGone = signal ?? new AbortController().signal;
    const attempted = new Set();
    const onceTagsUsed = new Set();
    const outcome = { [EXHAUST.QUOTA]: false, [EXHAUST.TRANSIENT]: false, request: null };
    let transientRetries = 0;

    // One attempt on one reserved account. Ends the reservation, then returns a final { status, body } or a loop step.
    async function attemptOn(reservation) {
      const prepared = policy.prepare(body, reservation.account, headers);
      const attemptMs = Math.max(1, Math.min(limits.attemptTimeoutMs ?? route.timeoutMs, deadline - now()));
      const timeoutSignal = AbortSignal.timeout(attemptMs);

      // Fetch and successful-body reads share this settlement; client closure takes precedence over timeout.
      function settleInterruption(err) {
        if (clientGone.aborted) {
          reservation.settlePossiblyBilled(POSSIBLY_BILLED.CLIENT_CLOSED);
          return { done: { status: CLIENT_CLOSED, body: null } };
        }
        if (timeoutSignal.aborted || err?.name === 'TimeoutError') {
          // The request was sent and may still be billed upstream. Never retry it on another account (that could
          // bill twice). 504 lets pi fall back to the other provider.
          reservation.settlePossiblyBilled(POSSIBLY_BILLED.TIMEOUT);
          return { done: { status: 504, body: policy.errorBody(`${policy.name} did not answer within ${attemptMs} ms via the local broker; not retried to avoid double billing`) } };
        }
        return null;
      }

      let upstream;
      try {
        upstream = await fetchImpl(`${policy.origin}${route.path}`, {
          method: 'POST', headers: prepared.headers, body: prepared.body, redirect: 'error',
          signal: AbortSignal.any([timeoutSignal, clientGone])
        });
      } catch (err) {
        const interruption = settleInterruption(err);
        if (interruption) return interruption;
        if (isPreDeliveryConnectionError(err)) {
          reservation.fail({ status: 'network', effect: EFFECT.UPSTREAM });
          outcome[EXHAUST.TRANSIENT] = true;
          return { rotate: reservation.account.id };
        }
        // A missing response does not establish whether the provider received and billed the request.
        reservation.settlePossiblyBilled(POSSIBLY_BILLED.AMBIGUOUS_NETWORK);
        return { done: { status: 503, body: policy.errorBody(`${policy.name} connection failed with delivery unknown via the local broker; not retried to avoid double billing`) } };
      }

      if (!upstream.ok) {
        const code = upstream.status;
        const parsed = await readErrorJson(upstream);
        const verdict = policy.classify(code, parsed, upstream.headers, now());
        reservation.fail({
          status: code, effect: verdict.effect, tag: verdict.tag, retryAfterMs: verdict.retryAfterMs,
          requestId: policy.requestId(parsed, upstream.headers)
        });
        if (clientGone.aborted) return { done: { status: CLIENT_CLOSED, body: null } };
        const upstreamError = { done: { status: code >= 400 && code < 500 ? code : 502, body: policy.sanitizeError(code, parsed, secrets) } };
        if (verdict.action === ACTION.PASSTHROUGH) return upstreamError;
        if (verdict.once) {
          // e.g. Exa FEATURE_DISABLED: try exactly one other account, then report the provider's answer.
          if (onceTagsUsed.has(verdict.tag)) return upstreamError;
          onceTagsUsed.add(verdict.tag);
        }
        if (verdict.exhaust === EXHAUST.REQUEST) outcome.request = { status: code, body: policy.sanitizeError(code, parsed, secrets) };
        else outcome[verdict.exhaust] = true;
        return verdict.action === ACTION.ROTATE ? { rotate: reservation.account.id } : { retry: true };
      }

      let data;
      try {
        data = await upstream.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid JSON');
      } catch (err) {
        const interruption = settleInterruption(err);
        if (interruption) return interruption;
        // A 2xx was probably billed. Do not retry on another account (it would bill again); let pi fall back.
        reservation.settlePossiblyBilled(POSSIBLY_BILLED.INVALID_RESPONSE);
        return { done: { status: 502, body: policy.errorBody(`${policy.name} returned an invalid response body via the local broker`) } };
      }
      const reported = policy.reportedCost(data);
      reservation.settle({
        status: upstream.status, requestId: policy.requestId(data, upstream.headers),
        ...(reported === null ? { amount: estimate, exact: false } : { amount: reported, exact: true })
      });
      return { done: { status: 200, body: policy.finalize(data, prepared.clientWantsUsage) } };
    }

    // The Account pool could not save the ending of this request's latest Attempt (or Attempts are paused).
    function unsaved(ending) {
      if (clientGone.aborted) return { status: CLIENT_CLOSED, body: null };
      if (ending === ENDING.BILLED || ending === ENDING.POSSIBLY_BILLED) {
        // pi-web-access looks for "abort" in the message before it looks at the status, so it neither retries nor falls
        // back to the other provider after an Attempt that cost, or may have cost, money (docs/research/pi-web-access.md).
        const billed = ending === ENDING.BILLED ? `${policy.name} billed this Attempt` : 'this Attempt may have been billed';
        return { status: 409, body: policy.errorBody(`Request aborted: ${billed}, but the local broker could not save its account state. New attempts are paused; check provider balances before retrying.`) };
      }
      // Nothing was billed, so this is transient and pi may fall back to the other provider.
      return { status: 503, body: policy.errorBody(`The local broker could not save its account state; new ${policy.name} attempts are paused until storage recovers`) };
    }

    const maxWaitMs = Math.max(0, deadline - now());
    const deadlineSignal = AbortSignal.timeout(maxWaitMs);
    while (now() < deadline && !clientGone.aborted && !deadlineSignal.aborted) {
      let step;
      try {
        // The pool gives the credit back if attemptOn throws before the reservation ended (e.g. while preparing).
        step = await pool.attempt(route, estimate, attempted, attemptOn);
      } catch (err) {
        if (err instanceof StateNotSaved) return unsaved(err.ending);
        throw err;
      }
      if (!step) break;
      if (step.done) return step.done;
      if (step.rotate) { attempted.add(step.rotate); continue; }
      // ACTION.RETRY (Exa 503 SERVICE_OVERLOADED, not billed): back off and retry without penalising the account.
      if (transientRetries >= limits.maxTransientRetries) break;
      transientRetries++;
      await sleepUnlessAborted(sleep, Math.min(250 * 2 ** (transientRetries - 1), Math.max(0, deadline - now())), AbortSignal.any([clientGone, deadlineSignal]));
    }

    if (clientGone.aborted) return { status: CLIENT_CLOSED, body: null };
    // pi-web-access maps 429 -> "quota" and 503 -> "transient"; both can trigger cross-provider fallback.
    // Quota wins so the outcome does not depend on attempt order.
    if (outcome[EXHAUST.QUOTA]) {
      return { status: 429, body: policy.errorBody(`No available ${policy.name} account: all exhausted, rate limited, disabled or cooling down (local broker)`) };
    }
    if (outcome[EXHAUST.TRANSIENT]) {
      return { status: 503, body: policy.errorBody(`${policy.name} is temporarily unavailable through the local broker (upstream failures on every attempt)`) };
    }
    if (outcome.request) return outcome.request;
    return { status: 429, body: policy.errorBody(`No available ${policy.name} account: all exhausted, disabled or cooling down (local broker)`) };
  }

  return { execute };
}
