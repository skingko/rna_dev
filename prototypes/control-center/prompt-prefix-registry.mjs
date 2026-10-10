// Latest provider-visible agent prefix per project (layers 1-2 plus seeded
// shared context), published by rna-runtime. Tool-free JSON purposes reuse it
// so their requests hit the cache written by foreground/background work.
// Declarations only: nothing here can execute a tool or grant permission.
const prefixes = new Map();
export function publishPrefix(projectId, { systemPrompt, tools, initialContext, cacheScope, modelKey }) {
  if (!projectId || typeof systemPrompt !== 'string') return;
  prefixes.set(projectId, { systemPrompt, tools: structuredClone(tools), initialContext: structuredClone(initialContext ?? []), cacheScope, modelKey, publishedAt: Date.now() });
}
/** Only a prefix built for the same provider/model can share its cache. */
export function sharedPrefixFor(projectId, model) {
  const value = prefixes.get(projectId);
  return value && (!value.modelKey || value.modelKey === modelKeyOf(model)) ? value : null;
}
/** The project's latest published prefix whichever model built it (a copy; null when none was published since the daemon
 * started). The system prompt and the tool declarations do not depend on the model; the paired schedule-text replay
 * (benchmark/schedule-text-replay.mjs) swaps the schedule texts of this one prefix and sends it on the model it chooses. */
export function latestPrefixFor(projectId) {
  const value = prefixes.get(projectId);
  return value ? structuredClone(value) : null;
}
export const modelKeyOf = model => model ? `${model.providerId ?? ''}/${model.modelId ?? model.id ?? ''}` : '';
export function forgetPrefix(projectId) { prefixes.delete(projectId); }
/** Every published prefix built for `model`, newest first (copies). The C5 compaction-fork probe falls back to another
 * project's when the probed project has published none since the daemon started. */
export function prefixesFor(model) { return [...prefixes].filter(([, value]) => !value.modelKey || value.modelKey === modelKeyOf(model)).map(([projectId, value]) => ({ projectId, ...structuredClone(value) })).sort((a, b) => b.publishedAt - a.publishedAt); }
