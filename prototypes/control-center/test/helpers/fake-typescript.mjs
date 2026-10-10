import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The parts of the `typescript` package the diagnostics worker uses, as a fake: every file is read through the
// worker's host (so its pre-write overlay is what a check sees); an error on each line that says BAD, and on an
// import from './b' that b.ts (as the host reads it) does not export.
export const FAKE_TYPESCRIPT = `const fs = require('fs'), path = require('path');
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } };
Object.assign(exports, { version: '5.0.0', ScriptTarget: { ES2022: 9 }, ModuleKind: { ESNext: 99 }, ModuleResolutionKind: { Bundler: 100 }, JsxEmit: { ReactJSX: 4 }, DiagnosticCategory: { Warning: 0, Error: 1, Suggestion: 2, Message: 3 },
  sys: { readFile: read, fileExists: p => fs.existsSync(p), readDirectory: () => [], directoryExists: p => fs.existsSync(p), getDirectories: () => [] },
  findConfigFile: () => undefined, readConfigFile: () => ({ config: {} }), parseJsonConfigFileContent: () => ({ options: {}, fileNames: [] }), getDefaultLibFilePath: () => 'lib.d.ts',
  createDocumentRegistry: () => ({}), ScriptSnapshot: { fromString: text => ({ text }) }, flattenDiagnosticMessageText: text => String(text) });
exports.createLanguageService = host => {
  const text = file => host.getScriptSnapshot(file)?.text ?? '';
  const at = body => ({ getLineAndCharacterOfPosition: position => { const lines = body.slice(0, position).split('\\n'); return { line: lines.length - 1, character: lines.at(-1).length }; } });
  return { getSyntacticDiagnostics: () => [], getSemanticDiagnostics: file => {
    const body = text(file), found = [], source = at(body), other = text(path.join(path.dirname(file), 'b.ts'));
    for (const match of body.matchAll(/import \\{ (\\w+) \\} from '\\.\\/b'/g)) if (!other.includes('export const ' + match[1] + ' ')) found.push({ file: source, start: match.index, category: 1, code: 2305, messageText: "Module './b' has no exported member '" + match[1] + "'." });
    for (let index = body.indexOf('BAD'); index >= 0; index = body.indexOf('BAD', index + 1)) found.push({ file: source, start: index, category: 1, code: 9999, messageText: 'BAD is not allowed.' });
    return found;
  } };
};
`;

/** The fake as the workspace's own `typescript` (major 5: the diagnostics service's language-service worker). */
export function installFakeTypescript(workspace) {
  const dir = join(workspace, 'node_modules', 'typescript');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"typescript","version":"5.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'index.js'), FAKE_TYPESCRIPT);
}
