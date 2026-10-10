import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Project instruction files shared with other agents (after pi's context-file
// discovery): AGENTS.override.md, AGENTS.md, CLAUDE.md at the workspace root,
// matched case-insensitively so an imported Claude project or a lower-case
// `agents.md` is never missed. The first candidate found wins. The file is the
// user's (pi resource-loader.ts:126-145): evolution reads it — its sections are
// "already covered" candidates when a rule is placed (EVO-15) — and never writes
// it; learned rules live in the project's own skills. AGENTS.md is the name
// suggested when there is none.
export const INSTRUCTION_CANDIDATES = Object.freeze(['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']);
export const DEFAULT_INSTRUCTION_FILE = 'AGENTS.md';
export const INSTRUCTION_MAX_CHARS = 32000;
const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The instruction file present at the workspace root, or null. */
export async function findProjectInstructions(workspace) {
  if (typeof workspace !== 'string' || !workspace) return null;
  let names; try { names = await readdir(workspace); } catch { return null; }
  for (const candidate of INSTRUCTION_CANDIDATES) {
    const name = names.find(entry => entry.toLowerCase() === candidate.toLowerCase());
    if (!name) continue;
    const path = join(workspace, name);
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) continue; } catch { continue; }
    return { name, path, kind: candidate.toLowerCase().startsWith('claude') ? 'claude' : 'agents' };
  }
  return null;
}

/** The file with its content (bounded), or null when none exists. */
export async function readProjectInstructions(workspace) {
  const found = await findProjectInstructions(workspace);
  if (!found) return null;
  let content; try { content = stripBom(await readFile(found.path, 'utf8')); } catch { return null; }
  const truncated = content.length > INSTRUCTION_MAX_CHARS;
  return { ...found, content: truncated ? content.slice(0, INSTRUCTION_MAX_CHARS) : content, truncated };
}

/** The project's instruction file name: the existing one, else AGENTS.md (the one to suggest; evolution does not write it). */
export async function instructionFileFor(workspace) { return (await findProjectInstructions(workspace))?.name ?? DEFAULT_INSTRUCTION_FILE; }

/** System-prompt rendering (pi's project_instructions block). The wrapper is fixed English, the model reads it; the file's own content is the user's. */
export function renderProjectInstructions(file) {
  if (!file?.content?.trim()) return '';
  return `\n\nProject instruction file ${file.name} (shared with other agents and kept with the project; its requirements take precedence over the collaboration rules above):\n<project_instructions path="${file.name}">\n${file.content.trim()}\n</project_instructions>${file.truncated ? '\n(The file is too long; only the first 32,000 characters were read.)' : ''}`;
}
