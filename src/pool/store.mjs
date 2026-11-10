// Where account pool state lives between processes. Two adapters behind one seam: { load() -> state | null, save(state) }.
//  - fileStore: pool-state.json next to the config (atomic write, mode 0600), optionally read-only for offline status;
//  - memoryStore: tests, and any caller that wants nothing on disk.
// State never contains key material: the pool stores account ids, spend and health only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from '../files.mjs';

export const STATE_VERSION = 2;
/**
 * Where 0.2.x kept v1 state. A new state file starts from it once; it is never written, so 0.2.x pi processes still
 * running during an upgrade keep working with their own file instead of failing on a version they cannot read.
 */
const V1_STATE_FILE = 'state.json';

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

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function fileStore(path, { readOnly = false } = {}) {
  const v1Path = join(dirname(path), V1_STATE_FILE);
  return {
    load() {
      if (existsSync(path)) return upgrade(readJson(path));
      return v1Path !== path && existsSync(v1Path) ? upgrade(readJson(v1Path)) : null;
    },
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
