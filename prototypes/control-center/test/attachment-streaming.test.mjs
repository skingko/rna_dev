import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { attachmentPrompt, attachmentTools } from '../session-attachments.mjs';

test('a large file streams in without a size cap, lands in the project attachments folder, and the agent is told where it is', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-attach-stream-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Novel', workspace: directory });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const line = '林七夜推开精神病院的铁门，雨下得很大。\n';
  const big = Buffer.from(line.repeat(Math.ceil(12.9 * 1024 * 1024 / Buffer.byteLength(line))));
  const upload = async (name, body) => { const response = await fetch(`${base}/api/sessions/${session.id}/attachments?name=${encodeURIComponent(name)}&type=text%2Fplain`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }); return { status: response.status, body: await response.json() }; };
  const { status, body: { attachment } } = await upload('我在精神病院学斩神.txt', big);
  assert.equal(status, 201);
  assert.equal(attachment.size, big.length); assert.equal(attachment.readable, true); assert.ok(attachment.size > 8 * 1024 * 1024);
  assert.equal(attachment.workspacePath, 'attachments/我在精神病院学斩神.txt');
  assert.deepEqual(readFileSync(join(directory, 'attachments', '我在精神病院学斩神.txt')), big);
  assert.equal(attachment.lineCount, big.toString().split('\n').length); assert.equal(attachment.inlineText, undefined, 'large text is not inlined');
  // Same bytes again reuse the project copy; different bytes never overwrite it.
  assert.equal((await upload('我在精神病院学斩神.txt', big)).body.attachment.workspacePath, 'attachments/我在精神病院学斩神.txt');
  assert.equal((await upload('我在精神病院学斩神.txt', Buffer.from('另一个版本'))).body.attachment.workspacePath, 'attachments/我在精神病院学斩神 (2).txt');
  // GBK text is recognized and small text is carried inline.
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GB18030
  const small = (await upload('note.txt', gbk)).body.attachment;
  assert.deepEqual([small.readable, small.encoding, small.inlineText], [true, 'gb18030', '你好']);
  const prompt = attachmentPrompt({ text: '参考这本书', attachments: [attachment, small] });
  assert.match(prompt, /我在精神病院学斩神\.txt：文本，\d+ 行，12\.\d MB；项目文件 attachments\/我在精神病院学斩神\.txt/);
  assert.match(prompt, /project_grep 搜索/);
  assert.match(prompt, /<file name="attachments\/note\.txt">\n你好\n<\/file>/);
  // The session copy is still readable (and decoded) through attachment_read.
  app.store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push({ id: 'm1', kind: 'user', text: 'x', attachments: [small] }); });
  const [tool] = attachmentTools(app.store, session.id);
  assert.match((await tool.execute('c', { id: small.id })).content[0].text, /^你好\n\n\[End of file: 1 lines\.\]$/);
  assert.ok(existsSync(join(directory, 'attachments')));
  void project;
});
