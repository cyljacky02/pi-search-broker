import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingWork } from '../src/pending-work.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveWork, rejectWork) => { resolve = resolveWork; reject = rejectWork; });
  return { promise, resolve, reject };
}

test('Pending work preserves promises and removes both fulfilled and rejected work', async () => {
  const pending = createPendingWork();
  assert.deepEqual(await pending.drain(), []);

  const fulfilled = Promise.resolve('done');
  const error = new Error('work failed');
  const rejected = Promise.reject(error);
  assert.equal(pending.track(fulfilled), fulfilled);
  assert.equal(pending.track(rejected), rejected);
  assert.equal(await fulfilled, 'done');
  await assert.rejects(rejected, (err) => err === error);
  assert.deepEqual(await pending.drain(), []);
});

test('Draining waits for every pending promise even when one rejects', async () => {
  const pending = createPendingWork();
  const first = deferred();
  const second = deferred();
  pending.track(first.promise);
  pending.track(second.promise);
  let drained = false;
  const draining = pending.drain().then((results) => { drained = true; return results; });

  const error = new Error('first failed');
  first.reject(error);
  await assert.rejects(first.promise, (err) => err === error);
  assert.equal(drained, false, 'a rejection does not abandon the remaining work');

  second.resolve('second finished');
  assert.deepEqual(await draining, [
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: 'second finished' }
  ]);
  assert.deepEqual(await pending.drain(), []);
});

test('Draining snapshots the current batch without closing admission', async () => {
  const pending = createPendingWork();
  const first = deferred();
  const later = deferred();
  pending.track(first.promise);
  const draining = pending.drain();
  pending.track(later.promise);

  first.resolve('first');
  assert.deepEqual(await draining, [{ status: 'fulfilled', value: 'first' }]);

  const nextDrain = pending.drain();
  later.resolve('later');
  assert.deepEqual(await nextDrain, [{ status: 'fulfilled', value: 'later' }]);
  assert.deepEqual(await pending.drain(), []);
});
