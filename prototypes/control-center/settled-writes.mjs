import { projectEdits } from '../../packages/sdk/src/workspace-tools.mjs';

// What an earlier write call looks like once its turn is over (SDK context.settle): the text it wrote is in the
// file now, so the model sees a one-line note in its place instead of re-reading the whole chapter on every later
// request. The session journal keeps every original. Only text that went to disk is set aside: a write's content,
// an edit's old and new text, and the inline (heredoc) body of a shell command; paths, commands and results stay.

/** Inline bodies shorter than this stay (a short script is cheap to keep and may be worth re-reading). */
export const SETTLE_INLINE_MIN_CHARS = 400;
const HEREDOC = /(<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n)([\s\S]*?)(\n[ \t]*\3)(?=[ \t]*(?:\n|$|[;&|)]))/g;
const writtenNote = (count, path) => `[${count} characters written to ${path || 'this file'} in an earlier turn, set aside to keep the context small. Read the file for its current text.]`;
const editNote = (removed, added, path, count = 1) => `[Edit to ${path || 'this file'} in an earlier turn: ${count > 1 ? `${count} replacements, ` : ''}${removed} characters replaced with ${added}, set aside to keep the context small. Read the file for its current text.]`;
const inlineNote = count => `[${count} characters of inline text this command ran with in an earlier turn, set aside to keep the context small. Read the files it wrote for their current text.]`;

/** The command with each long heredoc body replaced by a note (unchanged when there is none). */
export function withoutInlineBodies(command) {
  return String(command).replace(HEREDOC, (match, head, _quote, _tag, body, tail) => body.length < SETTLE_INLINE_MIN_CHARS ? match : `${head}${inlineNote(body.length)}${tail}`);
}

/** SDK `settleArguments` hook: the smaller arguments a settled call shows, or null to keep it as it was. */
export function settledWriteArguments(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const name = String(toolName ?? '');
  if (/(^|_)project_write$/.test(name) && typeof args.content === 'string' && args.content.length >= SETTLE_INLINE_MIN_CHARS) return { ...args, content: writtenNote(args.content.length, args.path) };
  if (/(^|_)project_edit$/.test(name)) {
    // edits[] and the older single oldText/newText alike (SDK projectEdits).
    let edits; try { edits = projectEdits(args); } catch { return null; }
    const removed = edits.reduce((sum, edit) => sum + edit.oldText.length, 0), added = edits.reduce((sum, edit) => sum + edit.newText.length, 0);
    if (removed + added < SETTLE_INLINE_MIN_CHARS) return null;
    const { oldText, newText, edits: _edits, ...rest } = args; return { ...rest, newText: editNote(removed, added, args.path, edits.length) };
  }
  if (/(^|_)project_exec$/.test(name) && typeof args.command === 'string') { const command = withoutInlineBodies(args.command); return command === args.command ? null : { ...args, command }; }
  return null;
}
