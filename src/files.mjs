// Private file writes shared by the config (config.mjs) and the Account pool state (pool/store.mjs).
import { mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Replace `path` with `value` as JSON: write a temp file (mode 0600) next to it, then rename it into place. */
export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* no-op */ }
    throw err;
  }
}
