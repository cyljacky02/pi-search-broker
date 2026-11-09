import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.mjs';
import { validateConfig } from '../src/config.mjs';

export const DATE = Date.parse('2026-11-09T06:00:00Z');
export const secret = 'local-only-secret-with-32-chars-12345';

export const exa = (id, key, promoExpiration = '2026-12-03T00:00:00Z') => ({
  id, provider: 'exa', apiKey: key,
  allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: promoExpiration }, { id: 'free', limit: 10, period: 'monthly' }]
});
export const tavily = (id, key) => ({ id, provider: 'tavily', apiKey: key, allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] });
export const config = (...accounts) => validateConfig({
  gateway: { host: '127.0.0.1', port: 19473, token: secret },
  totalTimeoutMs: 50000, accounts
});

export async function run(cfg, fetchImpl, fn, time = { ms: DATE }, extra = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-search-broker-'));
  const statePath = join(temp, 'state.json');
  const sleeps = [];
  const { server, manager, reconciler } = createGateway(cfg, {
    statePath, fetchImpl, now: () => time.ms, sleep: async (ms) => { sleeps.push(ms); }, ...extra
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token = secret, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  try { await fn({ base, post, manager, reconciler, statePath, time, sleeps }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
}

export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
