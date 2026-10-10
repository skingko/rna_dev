/** Checks the project's public GitHub releases for a newer Rna Agent build.
 * While the repository is private the release endpoint answers 404, reported
 * as `source_unavailable`; nothing is downloaded or installed here. */
export const UPDATE_REPOSITORY = 'skingko/rna_dev';
const parts = version => String(version ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(Number);
export function newerVersion(latest, current) {
  const [a, b] = [parts(latest), parts(current)];
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export async function checkForUpdate({ current, fetchImpl = globalThis.fetch, signal } = {}) {
  const checkedAt = new Date().toISOString(), source = `https://github.com/${UPDATE_REPOSITORY}/releases`;
  let response;
  try { response = await fetchImpl(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'rna-agent-update-check' }, signal: signal ?? AbortSignal.timeout(8000) }); }
  catch { return { status: 'unreachable', current, source, checkedAt }; }
  if (response.status === 404) return { status: 'source_unavailable', current, source, checkedAt };
  if (!response.ok) return { status: 'unreachable', current, source, checkedAt, httpStatus: response.status };
  let release; try { release = await response.json(); } catch { return { status: 'unreachable', current, source, checkedAt }; }
  const latest = String(release?.tag_name ?? '').replace(/^v/i, '');
  return { status: newerVersion(latest, current) ? 'available' : 'current', current, latest: latest || null, source, checkedAt, ...(typeof release?.html_url === 'string' ? { releaseUrl: release.html_url } : {}) };
}
