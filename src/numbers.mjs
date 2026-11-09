export const round6 = (n) => Math.round(n * 1e6) / 1e6;
export const isNonNegativeNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
