import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, webSearchFragment, resolveSecret } from '../src/config.mjs';
import { baseUrl } from '../src/client.mjs';
import { config, exa, tavily, secret } from './helpers.mjs';

const withHost = (host) => validateConfig({ gateway: { host, port: 19473, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] });

test('gateway.host "localhost" is normalized so every base URL agrees', () => {
  assert.equal(withHost('localhost').gateway.host, '127.0.0.1');
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    const cfg = withHost(host);
    const fragment = webSearchFragment(cfg.gateway);
    assert.equal(fragment.exaBaseUrl, `${baseUrl(cfg)}/exa`, `fragment and wiring disagree for ${host}`);
    assert.equal(fragment.tavilyBaseUrl, `${baseUrl(cfg)}/tavily`);
  }
});

test('Config rejects non-loopback listeners, duplicate API keys and expiry dates without a timezone', () => {
  assert.throws(() => withHost('0.0.0.0'), /loopback/);
  assert.throws(() => config(tavily('a', 'tvly-key-1'), tavily('b', 'tvly-key-1')), /Duplicate apiKey/);
  assert.throws(() => config({ ...exa('a', 'exa-secret-1'), allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: '2026-11-30' }] }), /ISO expiresAt/);
});

test('Balance checks are optional: periodic checks are off by default', () => {
  assert.equal(config(tavily('t', 'tvly-aaaaaaaa')).reconcileIntervalMs, 0);
});

test('Secrets can come from $ENV and !command sources and are validated after resolution', () => {
  const env = { MY_TAVILY: 'tvly-from-env-123' };
  assert.equal(resolveSecret('$MY_TAVILY', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('${MY_TAVILY}', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('$$literal', 'k', { env }), '$literal');
  assert.equal(resolveSecret('!secret-tool read tavily', 'k', { runCommand: () => 'tvly-from-cmd-123\n' }), 'tvly-from-cmd-123');
  assert.throws(() => resolveSecret('$MISSING', 'k', { env }), /empty or unset/);
  assert.throws(() => resolveSecret('!x', 'k', { runCommand: () => { throw new Error('tvly-should-not-leak'); } }), (e) => !e.message.includes('tvly-should-not-leak'));
  const gateway = { host: '127.0.0.1', port: 19473, token: secret };
  assert.equal(validateConfig({ gateway, accounts: [tavily('t', '$MY_TAVILY')] }, { env }).accounts[0].apiKey, 'tvly-from-env-123');
  assert.throws(() => validateConfig({ gateway, accounts: [tavily('a', '$MY_TAVILY'), tavily('b', 'tvly-from-env-123')] }, { env }), /Duplicate apiKey/);
  // Exa onboarding bonus never expires.
  const never = validateConfig({
    gateway,
    accounts: [{ id: 'e', provider: 'exa', apiKey: 'exa-key-aaaa', allocations: [{ id: 'bonus', limit: 10, period: 'once', expires: 'never' }] }]
  });
  assert.equal(never.accounts[0].allocations[0].expires, 'never');
});
