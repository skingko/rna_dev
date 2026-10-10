/**
 * The Codex client version Rna presents to the ChatGPT backend. The backend
 * gates its model catalog by it: GET /codex/models?client_version=X omits every
 * model whose minimal_client_version is above X (0.153 hid gpt-6-sol and
 * gpt-6-luna, which need 0.155; gpt-6.1-sol needs 0.159.3). A pinned version
 * goes stale as Codex releases, so the current release is read from the npm
 * registry (the @openai/codex package the Codex CLI ships as) and never goes
 * below the floor this SDK was verified with.
 */
export const CODEX_CLIENT_VERSION_FLOOR = '0.160.0';
const SOURCES = ['https://registry.npmjs.org/@openai/codex/latest', 'https://registry.npmmirror.com/@openai/codex/latest'];
const RELEASE = /^(\d{1,4})\.(\d{1,6})\.(\d{1,6})$/;
const MAX_AGE_MS = 6 * 3600000, RETRY_MS = 10 * 60000;

const parts = version => RELEASE.exec(version)?.slice(1).map(Number);
/** The later of two release versions (prereleases and anything malformed never win). */
export function laterVersion(a, b) {
  const x = parts(a), y = parts(b);
  if (!y) return x ? a : CODEX_CLIENT_VERSION_FLOOR;
  if (!x) return b;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  return a;
}

let current = CODEX_CLIENT_VERSION_FLOOR, checkedAt = -Infinity, failedAt = -Infinity, pending = null;
/** The version to present now: the newest one seen, or the floor before any check. */
export function codexClientVersion() { return current; }

/** Read the current Codex release (cached for hours; a failed check keeps the last known version). */
export function refreshCodexClientVersion({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  const at = now();
  if (at - checkedAt < MAX_AGE_MS || at - failedAt < RETRY_MS) return Promise.resolve(current);
  return pending ??= (async () => {
    const found = await Promise.all(SOURCES.map(async url => {
      try {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return undefined; }
        const version = (await response.json())?.version;
        return parts(version) ? version : undefined;
      } catch { return undefined; }
    }));
    const latest = found.filter(Boolean).reduce(laterVersion, undefined);
    if (latest) { current = laterVersion(current, latest); checkedAt = now(); } else failedAt = now();
    return current;
  })().finally(() => { pending = null; });
}

/** Test seam: forget what was learned. */
export function resetCodexClientVersion() { current = CODEX_CLIENT_VERSION_FLOOR; checkedAt = -Infinity; failedAt = -Infinity; pending = null; }
