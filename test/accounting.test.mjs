// Accounting invariants exercised through a Brokered request and its Account pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { broker, config, exa, json } from './helpers.mjs';

test('Unknown Exa types that match object property names use the conservative estimate', async () => {
  for (const type of ['constructor', '__proto__', 'toString']) {
    // A service key makes the Allocations bound the credit, so `available` is a number.
    const b = broker(config({ ...exa('a', 'exa-key-aaaa'), adminKey: 'exa-admin-aaaa' }), async () => json({ results: [] }));
    const result = await b.call('/exa/search', { query: 'q', type });
    assert.equal(result.status, 200);
    assert.equal(b.account(0).allocations[0].spent, 0.015, type);
    assert.equal(b.account(0).available, 69.985, type);
  }
});
