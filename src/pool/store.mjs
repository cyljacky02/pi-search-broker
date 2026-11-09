// Where account pool state lives between processes. Two adapters behind one seam: { load() -> state | null, save(state) }.
//  - fileStore: state.json next to the config (atomic write, mode 0600), optionally read-only for offline status;
//  - memoryStore: tests, and any caller that wants nothing on disk.
// State never contains key material: the pool stores account ids, spend and health only.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATE_VERSION = 2;

const RENAMED_IN_V2 = Object.freeze({ buckets: 'allocations', blockedUntil: 'quotaRetryAt', reconciled: 'providerBalance' });

/** Bring older state up to STATE_VERSION (v1 used the pre-glossary field names); reject anything else. */
function upgrade(state) {
  if (state?.version === 1 && state.accounts && typeof state.accounts === 'object') {
    for (const entry of Object.values(state.accounts)) {
      for (const [from, to] of Object.entries(RENAMED_IN_V2)) {
        if (from in entry) { entry[to] = entry[from]; delete entry[from]; }
      }
    }
    state.version = 2;
  }
  if (state?.version !== STATE_VERSION || !state.accounts || typeof state.accounts !== 'object') {
    throw new Error('Unsupported/corrupt state version');
  }
  return state;
}

function atomicWriteJson(path, value) {
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

export function fileStore(path, { readOnly = false } = {}) {
  return {
    load: () => (existsSync(path) ? upgrade(JSON.parse(readFileSync(path, 'utf8'))) : null),
    save: (state) => { if (!readOnly) atomicWriteJson(path, state); }
  };
}

export function memoryStore(initial = null) {
  let saved = initial ? upgrade(structuredClone(initial)) : null;
  return {
    load: () => (saved ? structuredClone(saved) : null),
    save: (state) => { saved = structuredClone(state); }
  };
}
