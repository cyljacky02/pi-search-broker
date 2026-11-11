import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, webSearchFragment, resolveSecret, defaultConfigPath } from '../src/config.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { baseUrl } from '../src/control.mjs';
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

test('Config rejects non-loopback listeners, duplicate Account ids and expiry dates without a timezone', () => {
  assert.throws(() => withHost('0.0.0.0'), /loopback/);
  assert.throws(() => config(tavily('a', 'tvly-key-1'), tavily('a', 'tvly-key-2')), /Duplicate account id/);
  assert.throws(() => config({ ...exa('a', 'exa-secret-1'), allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: '2026-11-30' }] }), /ISO expiresAt/);
});

test('Balance checks are optional: periodic checks are off by default', () => {
  assert.equal(config(tavily('t', 'tvly-aaaaaaaa')).reconcileIntervalMs, 0);
});

test('Credential sources retain their syntax until local Gateway startup', () => {
  const env = { MY_TAVILY: 'tvly-from-env-123' };
  assert.equal(resolveSecret('$MY_TAVILY', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('${MY_TAVILY}', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('$$literal', 'k', { env }), '$literal');
  assert.equal(resolveSecret('!secret-tool read tavily', 'k', { runCommand: () => 'tvly-from-cmd-123\n' }), 'tvly-from-cmd-123');
  assert.throws(() => resolveSecret('$MISSING', 'k', { env }), /empty or unset/);
  assert.throws(() => resolveSecret('!x', 'k', { runCommand: () => { throw new Error('tvly-should-not-leak'); } }), (e) => !e.message.includes('tvly-should-not-leak'));
  const gateway = { host: '127.0.0.1', port: 19473, token: secret };
  assert.equal(validateConfig({ gateway, accounts: [tavily('t', '$MY_TAVILY')] }).accounts[0].apiKey, '$MY_TAVILY');
  assert.equal(config(tavily('t', '!unavailable-credential-command')).accounts[0].apiKey, '!unavailable-credential-command');
  for (const source of [undefined, '', '$malformed source', '! ']) {
    assert.throws(() => config(tavily('t', source)), /Missing|Malformed|Empty command/);
  }
  // Exa onboarding bonus never expires.
  const never = validateConfig({
    gateway,
    accounts: [{ id: 'e', provider: 'exa', apiKey: 'exa-key-aaaa', allocations: [{ id: 'bonus', limit: 10, period: 'once', expires: 'never' }] }]
  });
  assert.equal(never.accounts[0].allocations[0].expires, 'never');
});

test('The broker folder lives in pi\'s agent dir, unless PI_SEARCH_BROKER_CONFIG names another config', () => {
  assert.equal(defaultConfigPath({}), join(homedir(), '.pi', 'agent', 'pi-search-broker', 'config.json'));
  assert.equal(defaultConfigPath({ PI_CODING_AGENT_DIR: join('x', 'agent') }), join('x', 'agent', 'pi-search-broker', 'config.json'));
  assert.equal(defaultConfigPath({ PI_CODING_AGENT_DIR: join('x', 'agent'), PI_SEARCH_BROKER_CONFIG: join('y', 'c.json') }), join('y', 'c.json'));
});
