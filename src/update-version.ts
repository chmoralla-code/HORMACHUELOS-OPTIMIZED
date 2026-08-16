/** Compare Hormachuelos Optimized versions, including revision builds like 1.2.11-1. */

export function parseAppVersion(value: string): number[] | null {
  const tokens = String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .filter(Boolean);
  if (tokens.length < 3 || !tokens.every((token) => /^\d+$/.test(token))) return null;
  return tokens.map((token) => Number.parseInt(token, 10));
}

export function compareAppVersion(candidate: string, current: string): number {
  const next = parseAppVersion(candidate);
  const installed = parseAppVersion(current);
  if (!next) return 0;
  if (!installed) return 1;
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (next[index] || 0) - (installed[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  return compareAppVersion(candidate, current) > 0;
}
