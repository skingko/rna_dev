import { deliveryReview } from './delivery-review.mjs';

// Recorded observations, never an aesthetic score or an implied new permission.
// Syntax checks and a read-back do not establish that a rendered interface works.
export function browserDeliveryReview(input, browserToolNames = []) {
  const base = deliveryReview(input);
  if (input.continuations > 0 || !browserToolNames.length) return base;
  const { snapshot } = input;
  const start = snapshot.messages.findLastIndex(row => row.role === 'user' && !['context', 'resume', 'finish-feedback'].includes(row.source));
  const messages = snapshot.messages.slice(Math.max(0, start)), calls = new Map();
  for (const row of messages) if (row.role === 'assistant') for (const part of row.content ?? []) if (part.type === 'toolCall') calls.set(`${row.id}/${part.id}`, part);
  const results = messages.filter(row => row.role === 'toolResult');
  const writes = results.flatMap((row, index) => {
    const path = calls.get(`${row.assistantId}/${row.toolCallId}`)?.arguments?.path;
    return !row.isError && ['project_write', 'project_edit'].includes(row.toolName) && typeof path === 'string' && /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i.test(path) ? [{ path, index }] : [];
  });
  if (!writes.length) return base;
  const observations = new Set(browserToolNames), later = results.slice(writes.at(-1).index + 1);
  const observedPage = later.some(row => !row.isError && observations.has(row.toolName));
  if (observedPage) return base;
  return { feedback: [...(base?.feedback ?? []), { source: 'host-browser-delivery-observation', text: JSON.stringify({
    observation: 'Frontend files were changed, and a browser is assigned, but this turn has no recorded successful page snapshot or screenshot after the last frontend change.',
    changedPaths: [...new Set(writes.map(row => row.path))].slice(0, 30),
    evidenceBoundary: 'A successful tool or syntax check is not visual acceptance. A snapshot establishes page structure; screenshot pixels require a vision-capable model. Neither alone proves usability or aesthetic quality.',
    nextStep: 'Use the relevant browser-verification skill. Open the actual artifact (project_preview supports static HTML only), inspect the rendered page, and exercise relevant normal and boundary interactions within existing permission. Inspect a screenshot when the model supports images. If execution or image inspection is unavailable, state the precise unverified checks instead of claiming visual validation. This is one bounded review opportunity, not new task scope or permission.'
  }) }] };
}
