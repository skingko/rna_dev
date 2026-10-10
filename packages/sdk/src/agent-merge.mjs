// agent_merge (worktree design 0.63 §4.1): the parent model's handle on the host merging a worker's work (or a
// background change set handed to this conversation) into its own files. Contract written by the lead: the name,
// schema and texts below are fixed English and never vary by project, so every purpose keeps one prompt prefix.
//
// T3 wires it in agent-delegation.mjs: createDelegationTools adds agentMergeTool(control.merge) to the background
// tool set (so `control` gains a `merge` handler), DELEGATION_TOOL_NAMES gains AGENT_MERGE_TOOL_NAME (children never
// get it), DELEGATE_TEXT's last sentence becomes DELEGATE_ISOLATION_TEXT, and index.mjs / index.d.ts export these.
// Only foreground turns register a real handler; background and proactive purposes declare the tool and refuse a
// call (tool_unavailable_for_purpose), as for the other delegation tools.
//
// The host never takes a path or commit id from the model: `take` paths must be in the conflict list the host made
// (invariant §0.3-6). Results are JSON text (see AGENT_MERGE_RESULT below); refusals are isError results whose
// details carry `code` (ISOLATION_ERRORS: merge_unknown, merge_not_finished, merge_shared_root,
// merge_path_not_conflicted, merge_take_denied, merge_unresolved, delegation_permission).

export const AGENT_MERGE_TOOL_NAME = 'agent_merge';
export const AGENT_MERGE_ACTIONS = Object.freeze(['merge', 'show', 'take', 'resolved', 'drop']);
export const AGENT_MERGE_SIDES = Object.freeze(['current', 'incoming']);

/** Replaces DELEGATE_TEXT's "Parallel workers each own different files: never have two workers change the same file." */
export const DELEGATE_ISOLATION_TEXT = 'Each worker works in its own copy made from your current files. When it finishes while this turn runs (or with continueAfter), the host merges its changes into your files and reports any conflict for you to resolve with agent_merge; the changes of a worker that did not finish, or that finished after this turn without continueAfter, wait for your agent_merge. Splitting work by file still avoids conflicts. When its receipt says shared_root (no git repository, or isolation unavailable), workers change your files directly: never have two of them change the same file.';

export const AGENT_MERGE_TEXT = "Settle a worker's changes with your files. When a worker finishes while your turn runs, the host merges its changes into your files by itself, and its result lists what was merged and any file that conflicts with changes made after it started. Call this only for those conflicts, for a worker the host did not merge (it did not finish, it finished while no turn of yours was running, it was cancelled, or the project was read-only), or to undo a merge. agentId names a worker of this conversation; changeId names a background change set the host handed to this conversation. action merge (default) merges again against your files as they are now and returns each conflict with a diff3 preview (the section under ||||||| is the common base) and currentSha256. show returns one conflicted file's full diff3, page by page. take keeps one side of listed conflicts ('current' = your files, 'incoming' = the worker's): use it for binary, deleted-versus-changed, file-versus-folder and both-added conflicts, or for a text file where one side is clearly right. resolved checks that every conflict was settled and closes the merge. drop discards the worker's changes; a merge already applied is rolled back where nothing changed since. To settle a text conflict, edit your file with project_edit or project_write using currentSha256 as expectedHash, keep both intents, leave no conflict marker, rerun the relevant checks, then call resolved. Conflicts involving submodules, links that point outside the project, or names differing only in case are left to the user.";

const ID = { type: 'string', minLength: 1, maxLength: 160 };
const PATH = { type: 'string', minLength: 1, maxLength: 4096 };
export const AGENT_MERGE_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    agentId: { ...ID, description: 'A worker of this conversation.' },
    changeId: { ...ID, description: 'A background change set handed to this conversation.' },
    action: { type: 'string', enum: [...AGENT_MERGE_ACTIONS], description: 'Default merge.' },
    path: { ...PATH, description: 'show: a path from the conflict list.' },
    page: { type: 'integer', minimum: 1, maximum: 10000, description: 'show: the page, from 1.' },
    take: { type: 'array', minItems: 1, maxItems: 64, description: 'take: paths from the conflict list and the side each keeps.',
      items: { type: 'object', properties: { path: PATH, side: { type: 'string', enum: [...AGENT_MERGE_SIDES] } }, required: ['path', 'side'], additionalProperties: false } },
  },
  additionalProperties: false,
  // Exactly one of agentId / changeId: "both" is refused by the schema, "neither" by the host (merge_unknown).
  not: { required: ['agentId', 'changeId'] },
});

/**
 * The JSON each action answers (the host's text content, parsed). Keys are English; paths are relative to the
 * parent's root. `conflicts[].kind` is one of CONFLICT_KINDS (prototypes/control-center/git-isolation/contract.mjs).
 *
 * merge    { status: 'merged'|'conflict'|'nothing'|'pending'|'dropped'|'shared_root', applied: string[],
 *            conflicts: [{ path, kind, currentSha256: string|null, preview?: string, truncated?: boolean, userOnly?: true }],
 *            notMerged: [{ path, reason }], notes: string[] }
 * show     { path, kind, page, pages, text }
 * take     { status, taken: [{ path, side }], applied: string[], conflicts: [...remaining, as merge] }
 * resolved { status: 'merged' } | { status: 'conflict', remaining: [{ path, reason: 'unchanged'|'markers' }] }
 * drop     { status: 'dropped', restored: string[], skipped: [{ path, reason }] }
 */
export const AGENT_MERGE_RESULT = Object.freeze({ previewBytes: 6 * 1024, showLinesPerPage: 2000 });

/**
 * The tool record. `merge(args, signal)` is the host handler (BuiltinAgentService, T3), receiving the validated
 * arguments plus `callId`, and returning a ToolResult.
 * @param {(args: { agentId?: string, changeId?: string, action?: string, path?: string, page?: number, take?: { path: string, side: string }[], callId: string }, signal: AbortSignal) => unknown} merge
 */
export function agentMergeTool(merge) {
  if (typeof merge !== 'function') throw new TypeError('An agent_merge handler is required.');
  return { name: AGENT_MERGE_TOOL_NAME, permission: 'write', effect: 'write', idempotent: false, description: AGENT_MERGE_TEXT, parameters: structuredClone(AGENT_MERGE_PARAMETERS),
    execute: (id, args, signal) => merge({ ...args, callId: id }, signal) };
}
