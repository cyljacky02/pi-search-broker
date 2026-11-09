// Brokered request: run one client request across an account pool, attempt by attempt, until a provider answers
// or every account is used up. No HTTP server knowledge lives here: callers hand in a parsed body and get back
// { status, body } to send. Billing-safety rules (docs/research/exa.md, docs/research/tavily.md):
//  - every reservation ends exactly once (billed, possibly billed, or released);
//  - an attempt that may have been billed (timeout, client gone, unreadable 2xx) is never retried elsewhere;
//  - a refused request is never retried on another account.
import { PROVIDERS, ACTION, EFFECT, EXHAUST } from './providers.mjs';

/** Status returned when the caller aborted: nobody is listening, so there is nothing to send. */
export const CLIENT_CLOSED = 499;

const MAX_ERROR_BODY = 64 * 1024;
const STREAM_REJECTED = 'Streaming responses (stream: true) are not supported by the local search broker';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readErrorJson(response) {
  let text = '';
  try { text = (await response.text()).slice(0, MAX_ERROR_BODY); } catch { /* treat as empty */ }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param pool      account pool (see pool.mjs): reserve(route, estimate, excludedIds) -> Reservation | null
 * @param limits    { totalTimeoutMs, attemptTimeoutMs?, maxTransientRetries }
 * @param secrets   strings to redact from anything returned to the client
 */
export function createBroker({ pool, limits, secrets = [], fetchImpl = fetch, now = () => Date.now(), sleep = defaultSleep }) {
  /** Run one request. Never throws for upstream behaviour; always returns { status, body }. */
  async function execute(route, body, { headers = {}, signal } = {}) {
    const policy = PROVIDERS[route.provider];
    // An SSE reply cannot be parsed or metered here, and would be retried (and billed) on every account.
    if (body.stream) return { status: 400, body: policy.errorBody(STREAM_REJECTED, { tag: 'BROKER_UNSUPPORTED' }) };
    const estimate = policy.quote(route.path, body);
    const deadline = now() + limits.totalTimeoutMs;
    const clientGone = signal ?? new AbortController().signal;
    const attempted = new Set();
    const onceTagsUsed = new Set();
    const outcome = { [EXHAUST.QUOTA]: false, [EXHAUST.TRANSIENT]: false, request: null };
    let transientRetries = 0;

    // One attempt on one reserved account. Ends the reservation, then returns a final { status, body } or a loop step.
    async function attempt(reservation) {
      const prepared = policy.prepare(body, reservation.account, headers);
      const attemptMs = Math.max(1, Math.min(limits.attemptTimeoutMs ?? route.timeoutMs, deadline - now()));

      let upstream;
      try {
        upstream = await fetchImpl(`${policy.origin}${route.path}`, {
          method: 'POST', headers: prepared.headers, body: prepared.body, redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(attemptMs), clientGone])
        });
      } catch (err) {
        if (clientGone.aborted) {
          reservation.settleUncertain('client-closed');
          return { done: { status: CLIENT_CLOSED, body: null } };
        }
        if (err?.name === 'TimeoutError') {
          // The request was sent and may still be billed upstream. Never retry it on another account (that could
          // bill twice). 504 lets pi fall back to the other provider.
          reservation.settleUncertain('timeout');
          return { done: { status: 504, body: policy.errorBody(`${policy.name} did not answer within ${attemptMs} ms via the local broker; not retried to avoid double billing`) } };
        }
        // Connection-level failure before a response: nothing was billed. Short cooldown, try another account.
        reservation.fail({ status: 'network', effect: EFFECT.UPSTREAM });
        outcome[EXHAUST.TRANSIENT] = true;
        return { rotate: true };
      }

      if (!upstream.ok) {
        const code = upstream.status;
        const parsed = await readErrorJson(upstream);
        const verdict = policy.classify(code, parsed, upstream.headers, now());
        reservation.fail({
          status: code, effect: verdict.effect, tag: verdict.tag, retryAfterMs: verdict.retryAfterMs,
          requestId: policy.requestId(parsed, upstream.headers)
        });
        const upstreamError = { done: { status: code >= 400 && code < 500 ? code : 502, body: policy.sanitizeError(code, parsed, secrets) } };
        if (verdict.action === ACTION.PASSTHROUGH) return upstreamError;
        if (verdict.once) {
          // e.g. Exa FEATURE_DISABLED: try exactly one other account, then report the provider's answer.
          if (onceTagsUsed.has(verdict.tag)) return upstreamError;
          onceTagsUsed.add(verdict.tag);
        }
        if (verdict.exhaust === EXHAUST.REQUEST) outcome.request = { status: code, body: policy.sanitizeError(code, parsed, secrets) };
        else outcome[verdict.exhaust] = true;
        return verdict.action === ACTION.ROTATE ? { rotate: true } : { retry: true };
      }

      let data;
      try {
        data = await upstream.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid JSON');
      } catch {
        // A 2xx was probably billed. Do not retry on another account (it would bill again); let pi fall back.
        reservation.settleUncertain('invalid-response');
        return { done: { status: 502, body: policy.errorBody(`${policy.name} returned an invalid response body via the local broker`) } };
      }
      const reported = policy.reportedCost(data);
      reservation.settle({
        status: upstream.status, requestId: policy.requestId(data, upstream.headers),
        ...(reported === null ? { amount: estimate, exact: false } : { amount: reported, exact: true })
      });
      return { done: { status: 200, body: policy.finalize(data, prepared.clientWantsUsage) } };
    }

    while (now() < deadline && !clientGone.aborted) {
      const reservation = pool.reserve(route, estimate, attempted);
      if (!reservation) break;
      let step;
      try {
        step = await attempt(reservation);
      } finally {
        // Anything that throws before the reservation ended (e.g. while preparing the request) gives the credit back.
        if (reservation.open) reservation.abandon();
      }
      if (step.done) return step.done;
      if (step.rotate) { attempted.add(reservation.account.id); continue; }
      // ACTION.RETRY (Exa 503 SERVICE_OVERLOADED, not billed): back off and retry without penalising the account.
      if (transientRetries >= limits.maxTransientRetries) break;
      transientRetries++;
      await sleep(Math.min(250 * 2 ** (transientRetries - 1), Math.max(0, deadline - now())));
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
