// Loaded before every test file (npm test: node --import ./test/setup.mjs). Tests never reach a real Provider: any
// fetch beyond loopback fails, so a Gateway's default balance sync cannot leave the machine.
const loopbackFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return Promise.reject(new TypeError('fetch failed (tests stay on loopback)'));
  return loopbackFetch(input, init);
};
