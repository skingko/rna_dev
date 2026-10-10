import test from 'node:test';
import assert from 'node:assert/strict';
import { settledWriteArguments, withoutInlineBodies } from '../settled-writes.mjs';

const chapter = `# 第五章 首单\n\n${'顾昭接的第一单，不是打鬼。'.repeat(80)}`;

test('a settled write shows a note instead of the text it wrote; paths and commands stay', () => {
  const write = settledWriteArguments('project_write', { path: '正文/卷一/第005章.md', content: chapter });
  assert.equal(write.path, '正文/卷一/第005章.md'); assert.match(write.content, /^\[\d+ characters written to 正文\/卷一\/第005章\.md in an earlier turn/);
  assert.equal(settledWriteArguments('project_write', { path: 'a.md', content: '短' }), null, 'short text stays');
  // Seen live: chapters written through python heredocs in project_exec.
  const command = `cd 正文/卷一 && python3 << 'PYEOF'\nch5 = '''${chapter}'''\nopen('第005章.md', 'w').write(ch5)\nPYEOF\nwc -m 第005章.md`;
  const exec = settledWriteArguments('project_exec', { command });
  assert.match(exec.command, /^cd 正文\/卷一 && python3 << 'PYEOF'\n\[\d+ characters of inline text this command ran with/);
  assert.match(exec.command, /\nPYEOF\nwc -m 第005章\.md$/, 'the rest of the command stays');
  assert.equal(settledWriteArguments('project_exec', { command: "python3 << EOF\nprint(1)\nEOF" }), null, 'a short script stays');
  assert.equal(settledWriteArguments('project_read', { path: 'a.md' }), null);
  assert.equal(withoutInlineBodies(`cat > a.md <<-"END"\n${chapter}\n\tEND`).includes('顾昭'), false);
});

test('a settled edit keeps its path and says how much it replaced; a small edit stays', () => {
  const edit = settledWriteArguments('project_edit', { path: 'src/game.js', oldText: 'a'.repeat(300), newText: 'b'.repeat(500), expectedHash: 'h' });
  assert.deepEqual(Object.keys(edit).sort(), ['expectedHash', 'newText', 'path']);
  assert.match(edit.newText, /^\[Edit to src\/game\.js in an earlier turn: 300 characters replaced with 500/);
  assert.equal(settledWriteArguments('project_edit', { path: 'a.js', oldText: 'x', newText: 'y' }), null);
});
