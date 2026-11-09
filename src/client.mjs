// Authenticated loopback client for a running gateway (used by the CLI and by non-owner pi processes).

export function baseUrl(config) {
  const host = config.gateway.host === 'localhost' ? '127.0.0.1' : config.gateway.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.gateway.port}`;
}

export async function gatewayRequest(config, method, path, body, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const res = await fetchImpl(`${baseUrl(config)}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.gateway.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gateway request failed: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
  return data;
}
