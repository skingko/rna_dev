import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSession } from '../src/session.mjs';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { COMPACTION_FILES_LEAD } from '../src/context.mjs';

// Alignment 2026-10-05 A6, edit safety. project_edit takes edits[] matched against the original text (pi edit.ts,
// without its fuzzy match); CRLF and a byte-order mark are set aside for matching only. project_write without
// expectedHash only replaces the version this conversation last observed (harness fs-observation-policy, zcode
// read-file-state). Fake providers only; no key reaches a provider.
const digest = text => createHash('sha256').update(text).digest('hex');
const model = { providerId: 'edit-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 200000, maxOutputTokens: 2000, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-edit-safety-')), root = join(directory, 'project'); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root, { includeMutations: true, execLogDir: join(directory, 'exec') });
  return { directory, root, tools, edit: tools.find(tool => tool.name === 'project_edit'), write: tools.find(tool => tool.name === 'project_write') };
}

test('several edits in one call are matched against the original, applied together, and refused whole when one fails', async t => {
  const f = await workspace(t), original = 'alpha beta gamma\nalpha2 delta\n'; await writeFile(join(f.root, 'a.txt'), original);
  // Matched against the original: "beta"→"gamma" does not make the second edit see a second "gamma".
  const both = await f.edit.execute('e1', { path: 'a.txt', edits: [{ oldText: 'beta', newText: 'gamma' }, { oldText: 'gamma\n', newText: 'GAMMA\n' }], expectedHash: digest(original) });
  assert.equal(both.isError, undefined, both.content[0].text); assert.equal(both.details.replacements, 2); assert.equal(both.details.firstChangedLine, 1);
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'alpha gamma GAMMA\nalpha2 delta\n');
  const current = await readFile(join(f.root, 'a.txt'), 'utf8');
  // Overlapping, repeated, missing or ambiguous edits fail without writing anything.
  for (const [edits, code] of [[[{ oldText: 'alpha gamma', newText: 'x' }, { oldText: 'gamma GAMMA', newText: 'y' }], 'overlapping_edits'], [[{ oldText: 'delta', newText: 'x' }, { oldText: 'delta', newText: 'y' }], 'overlapping_edits'],
    [[{ oldText: 'delta', newText: 'x' }, { oldText: 'missing', newText: 'y' }], 'no_match'], [[{ oldText: 'delta', newText: 'x' }, { oldText: 'alpha', newText: 'y' }], 'ambiguous_match']]) {
    const failed = await f.edit.execute('bad', { path: 'a.txt', edits });
    assert.equal(failed.isError, true); assert.equal(failed.details.code, code, JSON.stringify(edits)); assert.equal(failed.details.written, false);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), current);
  }
  assert.match((await f.edit.execute('bad', { path: 'a.txt', edits: [{ oldText: 'delta', newText: 'x' }, { oldText: 'missing', newText: 'y' }] })).content[0].text, /edits\[1\]\.oldText was not found/);
  // The older single-edit arguments are folded in (pi prepareArguments) and one expectedHash covers the call.
  assert.equal((await f.edit.execute('stale', { path: 'a.txt', edits: [{ oldText: 'delta', newText: 'x' }], expectedHash: digest(original) })).details.code, 'conflict');
  const folded = await f.edit.execute('legacy', { path: 'a.txt', oldText: 'delta', newText: 'DELTA', edits: [{ oldText: 'alpha2', newText: 'ALPHA2' }], expectedHash: digest(current) });
  assert.equal(folded.details.replacements, 2); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'alpha gamma GAMMA\nALPHA2 DELTA\n');
  assert.equal((await f.edit.execute('none', { path: 'a.txt' })).details.code, 'invalid_arguments');
  assert.equal((await f.edit.execute('empty', { path: 'a.txt', edits: [] })).details.code, 'invalid_arguments');
});

test('the edit schema takes edits[] and the older single edit, and nothing else', async t => {
  const f = await workspace(t), check = args => validateToolArguments(f.edit.parameters, args);
  assert.doesNotThrow(() => check({ path: 'a', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'z', newText: '' }] }));
  assert.doesNotThrow(() => check({ path: 'a', oldText: 'x', newText: 'y', expectedHash: digest('a') }));
  for (const bad of [{ path: 'a', edits: [] }, { path: 'a', edits: [{ oldText: '', newText: 'y' }] }, { path: 'a', edits: [{ oldText: 'x', newText: 'y', extra: 1 }] }, { path: 'a', edits: [{ oldText: 'x' }] }]) assert.throws(() => check(bad), { code: 'invalid_arguments' }, JSON.stringify(bad));
});

test('CRLF and a byte-order mark are set aside for matching only; other bytes and Chinese punctuation stay exact', async t => {
  const f = await workspace(t);
  // project_read shows a CRLF file without \r; a multi-line oldText copied from it matches, and the file keeps CRLF.
  await writeFile(join(f.root, 'crlf.txt'), 'first\r\nsecond\r\nthird\r\n');
  const read = await f.tools.find(tool => tool.name === 'project_read').execute('r', { path: 'crlf.txt' });
  assert.match(read.content[0].text, /^1\tfirst\n2\tsecond$/m);
  const crlf = await f.edit.execute('e', { path: 'crlf.txt', edits: [{ oldText: 'first\nsecond', newText: 'one\ntwo\nmore' }] });
  assert.equal(crlf.isError, undefined, crlf.content[0].text);
  assert.equal(await readFile(join(f.root, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\nmore\r\nthird\r\n');
  // A BOM stays; lines the edit did not touch keep their own line breaks (pi would rewrite all of them).
  await writeFile(join(f.root, 'mixed.txt'), '\uFEFFa\r\nb\nc\r\nd\n');
  await f.edit.execute('e', { path: 'mixed.txt', edits: [{ oldText: 'a\nb', newText: 'A\nB' }, { oldText: 'd', newText: 'D' }] });
  assert.equal(await readFile(join(f.root, 'mixed.txt'), 'utf8'), '\uFEFFA\r\nB\nc\r\nD\n');
  // Exact matching only: ASCII quotes and colon do not match “” and ：, and the Chinese text is written as given.
  const novel = '他说：“好。”\n她点头，走了。\n'; await writeFile(join(f.root, 'novel.md'), novel);
  assert.equal((await f.edit.execute('ascii', { path: 'novel.md', edits: [{ oldText: '他说:"好。"', newText: '他说：“行。”' }] })).details.code, 'no_match');
  await f.edit.execute('exact', { path: 'novel.md', edits: [{ oldText: '他说：“好。”', newText: '他说：“行。”' }, { oldText: '她点头，', newText: '她点了点头，' }] });
  assert.equal(await readFile(join(f.root, 'novel.md'), 'utf8'), '他说：“行。”\n她点了点头，走了。\n');
  // GBK text is readable but never re-encoded by an edit or a write; the message says why.
  await writeFile(join(f.root, 'gbk.txt'), Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]));
  const gbk = await f.edit.execute('gbk', { path: 'gbk.txt', edits: [{ oldText: '第一', newText: '第二' }] });
  assert.equal(gbk.details.code, 'invalid_file'); assert.match(gbk.content[0].text, /GBK\/GB18030 text/);
});

/** A session whose model makes the calls in `steps` in order, one step per request, and answers "done" after them. */
async function scripted(t, steps, extra = {}) {
  const f = await workspace(t), requests = [];
  let next = 0;
  const provider = async function* (request) {
    requests.push(request);
    const step = steps[next++];
    if (step) for (const [index, [name, args]] of step.entries()) yield { type: 'tool_call', id: `call-${next}-${index}`, name, arguments: args };
    else yield { type: 'text_delta', delta: 'done' };
    yield { type: 'usage', usage }; yield step ? { type: 'done' } : { type: 'done', stopReason: 'stop' };
  };
  const session = await createSession({ sessionId: 'edit-safety', projectId: 'edit-safety', cwd: f.root, stateDir: join(f.directory, 'state'), model, provider, tools: f.tools, autoCompaction: false, ...extra });
  t.after(() => session.dispose());
  return { ...f, session, requests, results: () => session.snapshot().messages.filter(message => message.role === 'toolResult') };
}

test('a line shows its number, a tab, then its text; one separator too many on indented lines is taken off both texts', async t => {
  // Live to 2026-10-10: 15 of 31 unmatched edits had one extra leading space on every indented line, the space the read
  // format had after the colon ("12:   \"updatedAt\"" for a line indented by two); unindented lines were written right.
  const f = await workspace(t), read = f.tools.find(tool => tool.name === 'project_read'), grep = f.tools.find(tool => tool.name === 'project_grep');
  const json = '{\n  "meta": {\n   "updatedAt": "09:10",\n   "formal": 6\n  },\n  "items": []\n}\n'; await writeFile(join(f.root, 'news.json'), json);
  const shown = (await read.execute('r', { path: 'news.json' })).content[0].text;
  assert.match(shown, /^3\t   "updatedAt": "09:10",$/m, 'the tab ends the prefix; the three spaces are the file\'s');
  assert.match((await grep.execute('g', { query: 'formal', context: 1 })).content[0].text, /^  3-\t   "updatedAt": "09:10",\n  4:\t   "formal": 6\n  5-\t  },$/m);
  assert.match(read.description, /line number, a tab, then the line/); assert.match(f.edit.description, /strip the project_read line prefix \(line number \+ tab\)/); assert.match(f.edit.description, /as small as possible while still unique/);

  // The space of the older format, on every line of both texts: one call, two edits (the 2026-10-07 shape).
  const spaced = await f.edit.execute('e1', { path: 'news.json', edits: [{ oldText: '    "updatedAt": "09:10",', newText: '    "updatedAt": "17:40",' }, { oldText: '    "formal": 6\n   },', newText: '    "formal": 7,\n    "watchlist": 5\n   },' }] });
  assert.equal(spaced.isError, undefined, spaced.content[0].text);
  assert.equal(await readFile(join(f.root, 'news.json'), 'utf8'), '{\n  "meta": {\n   "updatedAt": "17:40",\n   "formal": 7,\n   "watchlist": 5\n  },\n  "items": []\n}\n', 'the new lines lose the same space, so the indentation is the file\'s');
  assert.deepEqual(spaced.details.linePrefixRemoved, [0, 1]); assert.match(spaced.content[0].text, /Note: edits\[0\], edits\[1\] were matched after removing one leading separator character/);
  // The tab of the current format, on a tab-indented file; oldText that starts inside a line keeps its first line.
  const go = 'func main() {\n\tif ok {\n\t\trun()\n\t}\n}\n'; await writeFile(join(f.root, 'main.go'), go);
  const tabbed = await f.edit.execute('e2', { path: 'main.go', oldText: '\t\tif ok {\n\t\t\trun()', newText: '\t\tif ok && ready {\n\t\t\trun()' });
  assert.equal(tabbed.isError, undefined, tabbed.content[0].text); assert.match(tabbed.content[0].text, /Note: the edit was matched after removing one leading separator character/);
  const inside = await f.edit.execute('e3', { path: 'main.go', oldText: 'ok && ready {\n\t\t\trun()\n\t\t}', newText: 'ok {\n\t\t\trun()\n\t\t\tdone()\n\t\t}' });
  assert.equal(inside.isError, undefined, inside.content[0].text);
  assert.equal(await readFile(join(f.root, 'main.go'), 'utf8'), 'func main() {\n\tif ok {\n\t\trun()\n\t\tdone()\n\t}\n}\n');

  // An exact match is never touched: text that really starts with a space is replaced as written.
  await writeFile(join(f.root, 'exact.txt'), 'a\n b\nb\n');
  const exact = await f.edit.execute('e4', { path: 'exact.txt', oldText: ' b\n', newText: ' c\n' });
  assert.equal(exact.details.linePrefixRemoved, undefined); assert.doesNotMatch(exact.content[0].text, /Note:/); assert.equal(await readFile(join(f.root, 'exact.txt'), 'utf8'), 'a\n c\nb\n');
  // The 2026-10-02 shape: an indented entry with the extra space, then a blank line and a heading written as they are.
  const log = '## 记录\n\n   （四）指针：ch14 为下一章。\n\n## 正文文件索引\n'; await writeFile(join(f.root, 'log.md'), log);
  const entry = await f.edit.execute('e5', { path: 'log.md', oldText: '    （四）指针：ch14 为下一章。\n\n## 正文文件索引', newText: '    （四）指针：ch14 为下一章。\n\n    57. 【ch14 重写】完成。\n\n## 正文文件索引' });
  assert.equal(entry.isError, undefined, entry.content[0].text);
  assert.equal(await readFile(join(f.root, 'log.md'), 'utf8'), '## 记录\n\n   （四）指针：ch14 为下一章。\n\n   57. 【ch14 重写】完成。\n\n## 正文文件索引\n', 'the added entry is indented like its neighbours, not one deeper');
  // Not repaired, and nothing written: without the extra space the text is there twice. The refusal says what to change.
  await writeFile(join(f.root, 'twice.txt'), 'x\n  k: 1\ny\n  k: 1\n');
  const twice = await f.edit.execute('e6', { path: 'twice.txt', oldText: '   k: 1', newText: '   k: 2' });
  assert.equal(twice.isError, true); assert.equal(twice.details.code, 'no_match'); assert.match(twice.content[0].text, /Without one leading space on its indented lines it matches more than one place.*Remove that space from the indented lines of oldText and newText/s);
  assert.equal(await readFile(join(f.root, 'twice.txt'), 'utf8'), 'x\n  k: 1\ny\n  k: 1\n');
  // Text that is not in the file either way keeps the plain refusal.
  const absent = await f.edit.execute('e7', { path: 'news.json', oldText: '    "missing": 1', newText: '    "missing": 2' });
  assert.equal(absent.isError, true); assert.match(absent.content[0].text, /^Exact oldText was not found\. Read the current file before retrying; nothing was written\.$/);
});
test('a write without expectedHash replaces only the version this conversation last observed; a partial read counts', async t => {
  const steps = [
    [['project_write', { path: 'outline.md', content: 'overwritten blind' }]],
    [['project_read', { path: 'outline.md', offset: 2, limit: 1 }]],
    [['project_write', { path: 'outline.md', content: 'after a partial read' }]],
    [['project_exec', { command: 'printf "\\nchanged by a command" >> outline.md' }]],
    [['project_write', { path: 'outline.md', content: 'over a command change' }]],
    [['project_write', { path: 'new.md', content: 'a new file needs no observation' }], ['project_write', { path: 'new.md', content: 'and its own write is an observation' }]],
  ];
  const f = await scripted(t, steps);
  await writeFile(join(f.root, 'outline.md'), '大纲\n第一卷\n第二卷\n');
  await f.session.prompt('Update the outline.');
  const results = f.results(), text = message => message.content.map(block => block.text).join('');
  assert.equal(results.length, 7);
  assert.equal(results[0].isError, true); assert.match(text(results[0]), /has not been read in this conversation/);
  assert.equal(results[2].isError, false, text(results[2]));
  assert.equal(results[4].isError, true); assert.match(text(results[4]), /changed since this conversation last read or wrote it/);
  assert.equal(results[5].isError, false); assert.equal(results[6].isError, false, text(results[6]));
  assert.match(await readFile(join(f.root, 'outline.md'), 'utf8'), /after a partial read\nchanged by a command$/);
  assert.equal(await readFile(join(f.root, 'new.md'), 'utf8'), 'and its own write is an observation');
});

// Review 2026-10-05 (tool-safety): on a case-insensitive volume (APFS by default) readme.md and README.md, and an NFC
// and an NFD spelling of a name, are one file. A read records the name on disk; the write looks up the same name.
test('a read and a write that spell an existing file differently (case, Unicode normalization) still count as observed', { skip: process.platform !== 'darwin' && 'needs a case-insensitive volume' }, async t => {
  const nfc = '笔记-é.md', nfd = nfc.normalize('NFD');
  const steps = [
    [['project_read', { path: 'readme.md' }]],
    [['project_write', { path: 'readme.md', content: 'after a read in another case' }]],
    [['project_write', { path: 'README.md', content: 'its own write counts in either case' }]],
    [['project_read', { path: nfd }]],
    [['project_write', { path: nfc, content: 'after a read in NFD' }]],
  ];
  const f = await scripted(t, steps);
  await writeFile(join(f.root, 'README.md'), 'readme\n'); await writeFile(join(f.root, nfc), 'nfc\n');
  try { await readFile(join(f.root, 'readme.md')); } catch { t.skip('the temporary folder is case-sensitive'); return; }
  await f.session.prompt('Update the readme.');
  const results = f.results(), text = message => message.content.map(block => block.text).join('');
  assert.equal(results.length, 5);
  assert.match(text(results[0]), /^File: README\.md\n/, 'a read reports the name on disk');
  for (const index of [1, 2, 4]) assert.equal(results[index].isError, false, text(results[index]));
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'its own write counts in either case');
  assert.equal(await readFile(join(f.root, nfc), 'utf8'), 'after a read in NFD');
});

test('observations before the latest compaction or behind a rewind do not count', async t => {
  const steps = [
    [['project_read', { path: 'notes.md' }]], null,
    null,
    [['project_write', { path: 'notes.md', content: 'after compaction' }]], null,
    [['project_read', { path: 'notes.md' }]], null,
    [['project_write', { path: 'notes.md', content: 'after rewind' }]], null,
  ];
  const f = await scripted(t, steps);
  await writeFile(join(f.root, 'notes.md'), 'notes\n');
  await f.session.prompt('Read the notes.'); await f.session.prompt('Think.');
  const compacted = await f.session.compact({ summary: 'The notes were read.', keepLastTurns: 1 });
  assert.equal(compacted.compacted, true);
  await f.session.prompt('Write the notes.');
  // The checkpoint lists the file as read and says those reads no longer count; the refusal says the same.
  const projected = JSON.stringify(f.requests.at(-2).messages);
  assert.ok(projected.includes(JSON.stringify(COMPACTION_FILES_LEAD).slice(1, -1)), 'the checkpoint carries the file lead');
  assert.match(projected, /<read-files>\\nnotes\.md\\n<\/read-files>/); assert.match(COMPACTION_FILES_LEAD, /read a file again before overwriting it/);
  assert.match(f.results().at(-1).content[0].text, /^notes\.md has not been read since this conversation was last compacted/, 'the read is behind the compaction boundary');
  assert.doesNotMatch(f.results().at(-1).content[0].text, /has not been read in this conversation/, 'not "never read": the checkpoint lists it');
  await f.session.prompt('Read them again.');
  const reread = f.session.snapshot().messages.find(message => message.role === 'user' && message.content[0].text === 'Read them again.');
  await f.session.rewind(reread.id);
  await f.session.prompt('Write them now.');
  assert.match(f.results().at(-1).content[0].text, /has not been read since this conversation was last compacted/, 'the rewound read is gone; the one before the boundary still does not count');
  assert.equal(await readFile(join(f.root, 'notes.md'), 'utf8'), 'notes\n');
});

test('after a compaction, a file the conversation never read is still refused as never read', async t => {
  const steps = [[['project_read', { path: 'notes.md' }]], null, null, [['project_write', { path: 'other.md', content: 'blind' }]], null];
  const f = await scripted(t, steps);
  await writeFile(join(f.root, 'notes.md'), 'notes\n'); await writeFile(join(f.root, 'other.md'), 'other\n');
  await f.session.prompt('Read the notes.'); await f.session.prompt('Think.');
  assert.equal((await f.session.compact({ summary: 'The notes were read.', keepLastTurns: 1 })).compacted, true);
  await f.session.prompt('Write the other file.');
  assert.match(f.results().at(-1).content[0].text, /^other\.md already exists and has not been read in this conversation/);
  assert.equal(await readFile(join(f.root, 'other.md'), 'utf8'), 'other\n');
});
