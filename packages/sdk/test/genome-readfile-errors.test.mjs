import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGenomeScript, PROJECT_GENOME_SCRIPT_API_CONTRACT, GENOME_READ_LIMIT_BYTES, GENOME_READ_BUDGET_BYTES } from '../src/project-genome.mjs';

// design2 §7 W3: a rejected readFile says why, in a stable prefix (not_found: / denied: / read_limit_exceeded:), and the
// bound is one the project's own files fit under. The real worker runs against real files.
// A script's result is bounded at 64,000 bytes, so the probe returns what it read as a length and a head, not the text.
const tool = { id: 'probe', name: 'Probe', description: 'Reads one file.', permission: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, smokeCases: [],
  script: 'try { const text = await api.readFile(input.path); return { chars: text.length, head: text.slice(0, 12) }; } catch (error) { return { rejected: String(error.message) }; }' };
async function workspace(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'rna-readfile-'))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const probe = async (root, path, extra = {}) => (await runGenomeScript({ ...tool, ...extra }, { path }, { workspace: root })).value;
/** A text of exactly `bytes` UTF-8 bytes (Chinese characters are three bytes each, so the file's length in characters is a third). */
const text = (bytes, unit = '去重索引一行\n') => { const size = Buffer.byteLength(unit), whole = Math.floor(bytes / size); return unit.repeat(whole) + 'x'.repeat(bytes - whole * size); };

test('a missing file, a missing folder and a folder are not_found, and no message carries the workspace\'s absolute path', async t => {
  const root = await workspace(t); await mkdir(join(root, 'dir'));
  assert.deepEqual(await probe(root, 'missing.txt'), { rejected: 'not_found: missing.txt (ENOENT)' });
  assert.deepEqual(await probe(root, 'no/such/file.md'), { rejected: 'not_found: no/such/file.md (ENOENT)' });
  assert.deepEqual(await probe(root, 'dir'), { rejected: 'not_found: dir is not a regular file' });
  // Never the file system's own text (it names the absolute path).
  for (const path of ['missing.txt', 'no/such/file.md', 'dir']) assert.ok(!JSON.stringify(await probe(root, path)).includes(root), path);
  const uncaught = { ...tool, script: 'return await api.readFile(input.path);' };
  await assert.rejects(runGenomeScript(uncaught, { path: 'missing.txt' }, { workspace: root }), error => error.message === 'not_found: missing.txt (ENOENT)' && !error.message.includes(root), 'the same message reaches a script that does not catch it, and still names the code a script written before the prefixes tests for');
});

test('private paths, escapes, absolute paths, symlinks and host-denied paths are denied:', async t => {
  const root = await workspace(t);
  await writeFile(join(root, '.env'), 'SECRET=1'); await writeFile(join(root, 'protected.json'), '{}'); await writeFile(join(root, 'real.txt'), 'real');
  await symlink(join(root, 'real.txt'), join(root, 'link.txt'));
  for (const path of ['.env', '../outside.txt', '/etc/hosts', 'link.txt', 'a/../../x']) assert.match((await probe(root, path)).rejected, /^denied: /, path);
  assert.match((await probe(root, '.env')).rejected, /^denied: Private paths are unavailable$/);
  assert.match((await probe(root, 'link.txt')).rejected, /^denied: Symlinks are unavailable to generated scripts$/);
  const refused = (await runGenomeScript(tool, { path: 'protected.json' }, { workspace: root, deniedPaths: [join(root, 'protected.json')] })).value;
  assert.match(refused.rejected, /^denied: .*private/);
});

test('the read bound: a file of exactly the limit is read, one byte more is read_limit_exceeded, and a 70,000 byte file (the old bound was 64,000) is read', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'edge.txt'), text(GENOME_READ_LIMIT_BYTES)); await writeFile(join(root, 'over.txt'), text(GENOME_READ_LIMIT_BYTES) + 'x'); await writeFile(join(root, 'grown.json'), text(70000));
  assert.equal((await probe(root, 'edge.txt')).chars, text(GENOME_READ_LIMIT_BYTES).length, 'read in full');
  assert.deepEqual(await probe(root, 'over.txt'), { rejected: `read_limit_exceeded: over.txt is ${GENOME_READ_LIMIT_BYTES + 1} bytes; the limit is ${GENOME_READ_LIMIT_BYTES}` });
  assert.equal((await probe(root, 'grown.json')).chars, text(70000).length, 'a project index that outgrew 64,000 bytes is read in full');
  assert.equal(GENOME_READ_LIMIT_BYTES, 1048576);
});

test('the bound is on the text the script is handed, not on the file: bytes that are not UTF-8 decode to larger text and are refused when that text is over the limit', async t => {
  const root = await workspace(t);
  // Each byte that is not UTF-8 decodes to U+FFFD, three bytes of text: 400,000 bytes on disk are 1,200,000 bytes of text.
  await writeFile(join(root, 'binary.dat'), Buffer.alloc(400000, 0xff));
  await writeFile(join(root, 'small.dat'), Buffer.alloc(1000, 0xff));
  assert.ok(400000 <= GENOME_READ_LIMIT_BYTES && 400000 * 3 > GENOME_READ_LIMIT_BYTES, 'the file passes the stat and its text does not');
  assert.deepEqual(await probe(root, 'binary.dat'), { rejected: `read_limit_exceeded: binary.dat is 1200000 bytes as text; the limit is ${GENOME_READ_LIMIT_BYTES}` });
  assert.equal((await probe(root, 'small.dat')).chars, 1000, 'a file whose text is within the limit is still read');
  // The refused text does not use the budget up: the next read of a small file is not refused for it.
  const after = { ...tool, script: 'try { await api.readFile("binary.dat"); } catch {} return (await api.readFile("small.dat")).length;' };
  assert.equal((await runGenomeScript(after, {}, { workspace: root })).value, 1000);
});

test('everything that could be read before can still be read: 50 reads of 64,000 bytes, the old maximum, all succeed with the same text', async t => {
  const root = await workspace(t);
  for (let index = 0; index < 50; index++) await writeFile(join(root, `f${index}.md`), text(64000));
  const many = { ...tool, script: 'let bytes = 0; for (let index = 0; index < 50; index++) bytes += (await api.readFile("f" + index + ".md")).length; return { bytes };' };
  const out = await runGenomeScript(many, {}, { workspace: root }); assert.equal(out.value.bytes, 50 * text(64000).length);
  assert.equal(GENOME_READ_BUDGET_BYTES, 50 * 64000, 'the budget is exactly what the old bound allowed in one execution');
});

test('one execution reads at most the budget in all: the memory ceiling is the one it always had', async t => {
  const root = await workspace(t);
  for (let index = 0; index < 4; index++) await writeFile(join(root, `big${index}.md`), text(GENOME_READ_LIMIT_BYTES - 10));
  const reads = { ...tool, script: 'const got = []; for (let index = 0; index < 4; index++) { try { got.push((await api.readFile("big" + index + ".md")).length > 0 ? "read" : "empty"); } catch (error) { got.push(String(error.message)); } } return got;' };
  const got = (await runGenomeScript(reads, {}, { workspace: root })).value;
  assert.deepEqual(got.slice(0, 3), ['read', 'read', 'read']);
  assert.equal(got[3], `read_limit_exceeded: big3.md is ${GENOME_READ_LIMIT_BYTES - 10} bytes; this run has read ${3 * (GENOME_READ_LIMIT_BYTES - 10)} of ${GENOME_READ_BUDGET_BYTES} bytes in all`);
  // A failed read does not use the budget up.
  const failing = { ...tool, script: 'for (let index = 0; index < 20; index++) { try { await api.readFile("missing.md"); } catch {} } return await api.readFile("big0.md");' };
  assert.equal((await runGenomeScript({ ...failing, script: failing.script.replace('return await api.readFile("big0.md");', 'return (await api.readFile("big0.md")).length;') }, {}, { workspace: root })).value, text(GENOME_READ_LIMIT_BYTES - 10).length);
});

test('reads that overlap cannot pass the budget together: a script that starts them all at once reads as many bytes as one that reads in turn', async t => {
  const root = await workspace(t);
  for (let index = 0; index < 6; index++) await writeFile(join(root, `big${index}.md`), text(GENOME_READ_LIMIT_BYTES - 10));
  const together = { ...tool, script: 'const settled = await Promise.allSettled([0, 1, 2, 3, 4, 5].map(index => api.readFile("big" + index + ".md"))); return settled.map(row => row.status === "fulfilled" ? "read" : String(row.reason.message).split(":")[0]);' };
  // Which three get in depends on which stat returns first; that three do, and the others are refused, does not.
  const got = (await runGenomeScript(together, {}, { workspace: root })).value;
  assert.deepEqual([got.filter(row => row === 'read').length, got.filter(row => row === 'read_limit_exceeded').length], [3, 3]);
});

test('a read in flight counts against the budget: a read that would not fit is refused before it opens its file', async t => {
  const root = await workspace(t);
  for (const name of ['a.md', 'b.md', 'c.md', 'locked.md']) await writeFile(join(root, name), text(GENOME_READ_LIMIT_BYTES - 10));
  await chmod(join(root, 'locked.md'), 0o000);
  // Two reads in turn use 2 of the 3.2 MB; then c.md and locked.md start together and only one of them fits.
  // Which of the two is looked at first is up to the file system. If c.md goes first it is counted while it is read, so
  // locked.md is refused for the budget without being opened. If locked.md goes first it is opened, denied, and gives its
  // share back, so c.md then fits and is read. Either is correct; what must hold is that they never both consume the
  // budget (c.md read twice over, or both read), and that the budget is not left held by the denied read (a third read
  // of a small file after them still fits: it would be refused if the denied read's bytes had not been released).
  const script = 'await api.readFile("a.md"); await api.readFile("b.md"); const rows = await Promise.allSettled([api.readFile("c.md"), api.readFile("locked.md")]); const after = await api.readFile("small.md").then(() => "read", reason => String(reason.message).split(":")[0]); return [...rows.map(row => row.status === "fulfilled" ? "read" : String(row.reason.message).split(":")[0]), after];';
  await writeFile(join(root, 'small.md'), 'small');
  const got = (await runGenomeScript({ ...tool, script }, {}, { workspace: root })).value;
  assert.equal(got.slice(0, 2).filter(row => row === 'read').length <= 1, true, `both reads got in: ${got}`);
  assert.ok(['read_limit_exceeded', 'denied'].includes(got[1]) || got[1] === 'read', `unexpected result for locked.md: ${got}`);
  // 2 of 3 files' worth are held by a and b, and c.md when it was read: 3.1 MB of 3.2 MB, so a few bytes still fit unless a
  // read's share was never given back.
  assert.equal(got[2], 'read', `the budget was left held: ${got}`);
});

test('the contract tells the author the prefixes, the bound the worker enforces, and where a rejected read goes', () => {
  const contract = PROJECT_GENOME_SCRIPT_API_CONTRACT;
  for (const word of ['not_found:', 'denied:', 'read_limit_exceeded:', 'unchecked: [{ path, reason }]', 'could not check', 'not a violation']) assert.ok(contract.includes(word), word);
  // Only a check tool's result is read by the host for `unchecked`, so only a check tool is told to return it.
  const line = contract.split('\n').find(row => row.startsWith('- A rejected readFile')) ?? '';
  assert.ok(/In a check tool \(a tool whose id starts with guard_[^)]*\), return \{ unchecked: \[\{ path, reason \}\] \}/.test(line), 'the unchecked field is asked for of a check tool');
  assert.ok(line.includes('Any other tool keeps its own result shape: the host reads no unchecked field from it'), 'and not of any other tool');
  assert.ok(contract.includes('at most 1,048,576 bytes (1 MiB)') && contract.includes('3,200,000 bytes in all'), 'the numbers are the worker\'s own constants');
  assert.ok(!contract.split('\n').find(line => line.startsWith('- await api.readFile(')).includes('64,000'), 'a read is no longer said to stop at 64,000 bytes');
  assert.ok(/writeFile\(relativePath, text\) accepts a UTF-8 string of at most 64,000 bytes/.test(contract), 'a write is still bounded at 64,000');
  assert.ok(contract.includes('Smoke fixture files stay under 64,000 bytes'), 'the author is not told to smoke-test a fixture the fixture rules refuse');
});
