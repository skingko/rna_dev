import { resolve } from 'node:path';

// A host observation, not a quality score. Never infer that an arbitrary shell
// command or a model's final prose proves the requested artifact is correct.
export function deliveryReview({ snapshot, continuations }) {
  if (continuations > 0) return;
  const start = snapshot.messages.findLastIndex(message => message.role === 'user' && !['context', 'resume', 'finish-feedback'].includes(message.source));
  const messages = snapshot.messages.slice(Math.max(0, start));
  const calls = new Map();
  for (const message of messages) if (message.role === 'assistant') for (const item of message.content ?? []) if (item.type === 'toolCall') calls.set(`${message.id}/${item.id}`, item);
  const results = messages.filter(message => message.role === 'toolResult');
  const writes = results.flatMap((result, index) => {
    const call = calls.get(`${result.assistantId}/${result.toolCallId}`);
    return !result.isError && ['project_write', 'project_edit'].includes(result.toolName) && typeof call?.arguments?.path === 'string' ? [{ path: call.arguments.path, index }] : [];
  });
  if (!writes.length) return;
  const lastWrite = writes.at(-1).index;
  const later = results.slice(lastWrite + 1);
  const writtenPaths = new Set(writes.map(row => resolve(snapshot.cwd ?? '.', row.path)));
  const observedInspection = later.some(row => {
    if (row.isError) return false;
    const args = calls.get(`${row.assistantId}/${row.toolCallId}`)?.arguments;
    const artifactRead = row.toolName === 'project_read' && typeof args?.path === 'string' && writtenPaths.has(resolve(snapshot.cwd ?? '.', args.path));
    return artifactRead || row.toolName === 'project_exec' || row.toolName === 'agent_consult' && args?.role === 'reviewer' && args?.wait === true; // a background spawn has inspected nothing yet
  });
  const failedExecution = results.findLast(row => row.toolName === 'project_exec')?.isError === true;
  if (observedInspection && !failedExecution) return;
  return { feedback: [{ source: 'host-delivery-observation', text: JSON.stringify({
    observation: 'File writes completed, but the recorded delivery evidence needs attention.',
    changedPaths: [...new Set(writes.map(row => row.path))].slice(0, 30),
    noInspectionAfterLastWrite: !observedInspection, lastExecutionFailed: failedExecution,
    evidenceBoundary: 'This checks the recorded sequence only. It does not judge appearance, task correctness or whether an arbitrary command is a meaningful test.',
    nextStep: 'Inspect the delivered artifacts and perform relevant available validation before concluding. Address concrete failures within the existing task authorization. If a needed check cannot be performed, state precisely what remains unverified and why. Do not repeat a failed or uncertain external side effect merely to get a green result. For substantial artifacts, load rna-delivery-quality if useful. This is a single bounded review opportunity, not new user scope or permission.'
  }) }] };
}
