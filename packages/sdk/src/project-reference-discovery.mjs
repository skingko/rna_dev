/** Public discovery evidence excludes source bodies, search queries and model
 * justifications. Counts describe recorded host operations, never capability
 * quality, installation, or coverage beyond the retained search responses. */
export function referenceDiscoveryReceipt(options) {
  const snapshot = options?.referencePolicy?.snapshot, context = options?.referenceContext;
  if (typeof snapshot !== 'function' && typeof context !== 'function') return undefined;
  const unavailable = () => ({ schemaVersion: 1, outcome: 'unavailable', installed: false, snapshotAvailable: false });
  let value;
  try { value = snapshot ? snapshot.call(options.referencePolicy) : context(); } catch { return unavailable(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.then === 'function') return unavailable();
  // referenceContext is intentionally generic in the public API. An unrelated
  // context object or malformed snapshot cannot prove nothing was attempted.
  if (!['searches', 'references', 'failures', 'packages'].every(key => Array.isArray(value[key]))) return unavailable();
  const rows = key => Array.isArray(value[key]) ? value[key] : [];
  const searches = rows('searches'), references = rows('references'), failures = rows('failures'), packages = rows('packages');
  const token = (input, max = 200) => typeof input === 'string' && input.length <= max && /^[A-Za-z0-9_./:@+-]+$/.test(input) ? input : undefined;
  const digest = (input, size) => typeof input === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(input) ? input : undefined;
  const pick = (row, fields) => Object.fromEntries(fields.flatMap(([key, validate]) => { const result = validate(row?.[key]); return result === undefined ? [] : [[key, result]]; }));
  const count = input => Number.isSafeInteger(input) && input >= 0 ? input : undefined;
  const searchRows = searches.slice(0, 16).map(row => ({ ...pick(row, [['provider', token]]), resultCount: Array.isArray(row?.results) ? row.results.length : 0, skippedUnsupported: count(row?.skippedUnsupported) ?? 0,
    ...(row?.coverage?.status && token(row.coverage.status) ? { coverage: row.coverage.status } : {}) }));
  const disposition = ['no_package_selected', 'existing_package_reused'].includes(value.disposition?.status) ? pick(value.disposition, [['status', token], ['skillId', token], ['packageHash', input => digest(input, 64)]]) : null;
  const incompleteSearch = searches.some(row => !Array.isArray(row?.results) || (count(row?.skippedUnsupported) ?? 0) > 0 || ['partial', 'unsupported', 'incomplete'].includes(row?.coverage?.status));
  // A failed/unsupported search cannot become evidence of an empty market.
  const outcome = packages.length ? 'acquired' : disposition?.status === 'existing_package_reused' ? 'existing_reused' : failures.length ? 'failed' : incompleteSearch ? 'incomplete' : disposition?.status === 'no_package_selected' ? 'no_package_selected' : searches.length && searches.every(row => Array.isArray(row?.results) && row.results.length === 0) ? 'empty' : searches.length || references.length ? 'incomplete' : 'not_attempted';
  return { schemaVersion: 1, outcome, installed: false, snapshotAvailable: true, counts: { searches: searches.length, filesRead: references.length, packages: packages.length, failures: failures.length },
    searches: searchRows,
    sources: references.slice(0, 32).map(row => pick(row, [['provider', token], ['id', input => token(input, 500)], ['commit', input => digest(input, 40)], ['contentHash', input => digest(input, 64)]])),
    failures: failures.slice(0, 16).map(row => pick(row, [['operation', token], ['provider', token], ['code', token]])),
    packages: packages.slice(0, 12).map(row => pick(row, [['skillId', token], ['provider', token], ['id', input => token(input, 500)], ['commit', input => digest(input, 40)], ['packageHash', input => digest(input, 64)]])), disposition,
    omitted: { searches: Math.max(0, searches.length - 16), sources: Math.max(0, references.length - 32), failures: Math.max(0, failures.length - 16), packages: Math.max(0, packages.length - 12) } };
}
