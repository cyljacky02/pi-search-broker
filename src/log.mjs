/** Wrap an optional `(line) => void` logger so it never throws: logging must never break a request. */
export const quietLogger = (logger) => (line) => { try { logger?.(line); } catch { /* ignore */ } };
