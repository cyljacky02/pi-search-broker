import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, webSearchFragment } from '../src/config.mjs';
import { baseUrl } from '../src/client.mjs';
import { tavily, secret } from './helpers.mjs';

const withHost = (host) => validateConfig({ gateway: { host, port: 19473, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] });

test('gateway.host "localhost" is normalized so every base URL agrees', () => {
  assert.equal(withHost('localhost').gateway.host, '127.0.0.1');
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    const config = withHost(host);
    const fragment = webSearchFragment(config.gateway);
    assert.equal(fragment.exaBaseUrl, `${baseUrl(config)}/exa`, `fragment and wiring disagree for ${host}`);
    assert.equal(fragment.tavilyBaseUrl, `${baseUrl(config)}/tavily`);
  }
});
