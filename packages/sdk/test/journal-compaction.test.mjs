import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journalCheckpointFile, openJournal, readVerifiedJournal } from '../src/journal.mjs';
import { compactJournal, compactionBackups, removeCompactionBackups } from '../src/journal-compaction.mjs';
import { createSession } from '../src/session.mjs';

const journalURL = new URL('../src/journal.mjs', import.meta.url).href;
const sessionURL = new URL('../src/session.mjs', import.meta.url).href;
const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', contextWindow: 1000000, maxOutputTokens: 1000 };
async function workspace(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'rna-compaction-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function child(cwd, source) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', value => { stdout += value; }); process.stderr.on('data', value => { stderr += value; });
  const result = await new Promise((resolve, reject) => { process.once('error', reject); process.once('close', (code, signal) => resolve({ code, signal })); });
  return { ...result, stdout, stderr, json: () => JSON.parse(stdout) };
}
const noModel = async function* () { throw new Error('replay must not request a model'); };
const snapshotOf = async (dir, sessionFile) => { const session = await createSession({ stateDir: join(dir, 'state'), sessionFile, sessionId: 'old', projectId: 'p', cwd: dir, model, provider: noModel }); const value = session.snapshot(); await session.dispose(); return value; };
const records = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
// An 0.24-era journal: one event per streamed token.
function legacyJournal(dir) {
  const journal = openJournal({ stateDir: join(dir, 'state'), sessionId: 'old', projectId: 'p' }), token = (requestId, messageId, type, delta) => journal.appendEvent({ type: 'message_update', requestId, messageId, assistantMessageEvent: { type, delta } });
  journal.append('message', { message: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: 1 } });
  journal.append('request_started', { requestId: 'r1', message: { id: 'a1', role: 'assistant', content: [], timestamp: 2 } });
  for (let i = 0; i < 400; i++) token('r1', 'a1', i < 100 ? 'thinking_delta' : 'text_delta', `t${i} `);
  journal.appendEvent({ type: 'message_update', requestId: 'r1', messageId: 'a1', assistantMessageEvent: { type: 'text_delta', delta: 'kept' }, message: { legacy: 'snapshot' } });
  journal.append('request_completed', { requestId: 'r1', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'final answer' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: 'stop', timestamp: 3 } });
  journal.appendEvent({ type: 'message_end', message: { id: 'a1' } });
  journal.append('run_started', { runId: 'interrupted' });
  journal.append('request_started', { requestId: 'r2', message: { id: 'a2', role: 'assistant', content: [], timestamp: 4 } });
  for (let i = 0; i < 300; i++) token('r2', 'a2', i % 100 < 30 ? 'thinking_delta' : 'text_delta', `p${i}🙂`);
  const file = journal.file; journal.close(); return file;
}

test('live stream deltas are journaled as segments; a crash mid-stream recovers the flushed prefix as an aborted message', { timeout: 30000 }, async t => {
  const dir = await workspace(t);
  const script = `import{createSession}from${JSON.stringify(sessionURL)};
const session=await createSession({sessionId:'crash',cwd:'.',stateDir:'state',model:${JSON.stringify(model)},provider:async function*(){
  for(let group=0;group<3;group++){for(let i=0;i<1500;i++)yield{type:'text_delta',delta:'g'+group+'-'+String(i).padStart(4,'0')+'-'+'z'.repeat(40)+'|'};await new Promise(r=>setTimeout(r,300));}
  process.kill(process.pid,'SIGKILL');}});await session.prompt('Stream a long answer.');`;
  const crashed = await child(dir, script); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const file = join(dir, 'state', readdirSync(join(dir, 'state')).find(name => name.endsWith('.rna.jsonl')));
  const updates = records(file).filter(row => row.type === 'event' && row.data.type === 'message_update');
  assert.ok(updates.length > 2 && updates.length < 40, `segments, not ${updates.length} per-token records`);
  assert.ok(updates.every(row => row.data.deltas > 1 && row.data.assistantMessageEvent.delta.length <= 32 * 1024));
  const full = Array.from({ length: 3 }, (_, group) => Array.from({ length: 1500 }, (_, i) => `g${group}-${String(i).padStart(4, '0')}-${'z'.repeat(40)}|`).join('')).join('');
  const session = await createSession({ sessionId: 'crash', cwd: dir, stateDir: join(dir, 'state'), model, provider: noModel }), recovered = session.snapshot().messages.at(-1);
  assert.equal(recovered.stopReason, 'aborted'); const text = recovered.content.map(part => part.text).join('');
  assert.ok(text.length >= 64 * 1024 && full.startsWith(text), `recovered ${text.length} chars as an exact prefix`);
  assert.equal(text, updates.map(row => row.data.assistantMessageEvent.delta).join(''));
  await session.dispose();
});

test('compaction merges token events, re-chains, verifies and preserves replay exactly; dry-run and reruns change nothing', async t => {
  const dir = await workspace(t), file = legacyJournal(dir), copy = join(dir, 'state', 'reference.rna.jsonl'); copyFileSync(file, copy);
  const original = readFileSync(file), before = await snapshotOf(dir, copy);
  assert.equal(before.messages.find(row => row.id === 'a2').stopReason, 'aborted');
  const dry = compactJournal(file, { dryRun: true });
  assert.equal(dry.changed, false); assert.ok(dry.mergedEvents > 600 && dry.compactedRecords < dry.records / 10);
  assert.deepEqual(readFileSync(file), original); assert.deepEqual(compactionBackups(file), []);
  const report = compactJournal(file);
  assert.equal(report.changed, true); assert.equal(report.compactedBytes, statSync(file).size); assert.ok(report.compactedBytes < original.length / 3);
  assert.deepEqual(readFileSync(report.backup), original, 'the original is kept byte for byte');
  const rows = records(file), verified = readVerifiedJournal(file);
  assert.equal(verified.sequence, rows.length); assert.equal(verified.tornBytes, 0);
  assert.ok(rows.some(row => row.data?.message?.legacy === 'snapshot'), 'unusual stream records pass through unchanged');
  assert.deepEqual(rows.filter(row => row.type !== 'event').map(row => [row.type, row.time, row.data]), records(report.backup).filter(row => row.type !== 'event').map(row => [row.type, row.time, row.data]));
  // Opening the compacted journal (and its fresh checkpoint) replays identically.
  const after = await snapshotOf(dir, file);
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.recovery, before.recovery);
  const again = compactJournal(file); assert.equal(again.changed, false); assert.equal(again.mergedEvents, 0); assert.equal(compactionBackups(file).length, 1);
  // A backup that no longer matches the journal is never removed.
  const forged = `${file}.precompact-1-${report.compactedRecords}`; writeFileSync(forged, readFileSync(copy, 'utf8').replace('first question', 'first questioN'));
  const removal = removeCompactionBackups(file);
  assert.deepEqual(removal.removed.map(row => row.backup), [report.backup]); assert.deepEqual(removal.kept, [forged]); assert.ok(!existsSync(report.backup));
});

test('compaction refuses a journal with a live writer and skips a torn tail untouched', async t => {
  const dir = await workspace(t), file = legacyJournal(dir), writer = openJournal({ stateDir: join(dir, 'state'), sessionId: 'old', projectId: 'p' });
  assert.throws(() => compactJournal(file), { code: 'journal_locked' }); writer.close();
  appendFileSync(file, '{"seq":999,"torn'); const bytes = readFileSync(file);
  const report = compactJournal(file); assert.equal(report.skipped, 'torn_tail'); assert.deepEqual(readFileSync(file), bytes); assert.deepEqual(compactionBackups(file), []);
});

// Cold opens run in fresh processes (no in-process verified-prefix memory);
// `bytes` counts journal bytes read, `parsed` whether the chain was re-hashed.
const coldOpen = (dir, extra = '') => child(dir, `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
const{openJournal}=await import(${JSON.stringify(journalURL)});const file='state/'+fs.readdirSync('state').find(n=>n.endsWith('.rna.jsonl'));const identity=fs.statSync(file);let bytes=0;
const read=fs.readSync;fs.readSync=(fd,b,o,l,p)=>{const n=read(fd,b,o,l,p);try{const s=fs.fstatSync(fd);if(s.ino===identity.ino&&s.dev===identity.dev)bytes+=n;}catch{}return n;};syncBuiltinESMExports();
const started=performance.now();let journal;try{journal=openJournal({stateDir:'state',sessionId:'cold'});}catch(error){console.log(JSON.stringify({error:error.code}));process.exit(0);}
const openMs=performance.now()-started;${extra}const seq=journal.seq;journal.close();console.log(JSON.stringify({bytes,size:identity.size,seq,openMs}));`);

test('a persisted checkpoint makes a cold open verify only the boundary; tampering or foreign writes fall back to verification', { timeout: 60000 }, async t => {
  const dir = await workspace(t);
  const built = await child(dir, `const{openJournal}=await import(${JSON.stringify(journalURL)});const j=openJournal({stateDir:'state',sessionId:'cold'});
for(let i=0;i<9000;i++){if(i%50===0)j.append('message',{message:{id:'m'+i,role:'user',content:[{type:'text',text:'x'.repeat(600)}]}});j.appendEvent({type:'tool_execution_update',text:'y'.repeat(600)});}j.close();console.log(JSON.stringify({seq:j.seq}));`);
  assert.equal(built.code, 0, built.stderr); const { seq } = built.json(), file = join(dir, 'state', readdirSync(join(dir, 'state')).find(name => name.endsWith('.rna.jsonl')));
  assert.ok(statSync(file).size > 5 * 1024 * 1024 && existsSync(journalCheckpointFile(file)));
  const warm = (await coldOpen(dir)).json();
  assert.equal(warm.seq, seq); assert.ok(warm.bytes <= 4 * 64 * 1024, `cold open read ${warm.bytes} of ${warm.size} bytes`);
  // A crashed writer (appended, never closed) leaves a stale checkpoint: the
  // prefix is checked by its segment digests and only the tail is verified.
  const crashed = await child(dir, `const{openJournal}=await import(${JSON.stringify(journalURL)});const j=openJournal({stateDir:'state',sessionId:'cold'});j.append('message',{message:{id:'tail',role:'user',content:[]}});process.exit(0);`);
  assert.equal(crashed.code, 0, crashed.stderr);
  const resumed = (await coldOpen(dir)).json(); assert.equal(resumed.seq, seq + 1); assert.ok(resumed.bytes >= resumed.size, 'segment digests read the prefix');
  assert.ok((await coldOpen(dir)).json().bytes <= 4 * 64 * 1024, 'the next clean close checkpoints the new size');
  // A forged checkpoint (wrong boundary hash) is ignored: full verification.
  const saved = JSON.parse(readFileSync(journalCheckpointFile(file), 'utf8')); writeFileSync(journalCheckpointFile(file), JSON.stringify({ ...saved, hash: 'f'.repeat(64) }));
  const forged = (await coldOpen(dir)).json(); assert.equal(forged.seq, seq + 1); assert.ok(forged.bytes >= forged.size);
  // An in-place edit of a prefix byte (same size) is detected.
  const bytes = readFileSync(file), at = bytes.indexOf(Buffer.from('"m1000"')); bytes[at + 2] = 110; writeFileSync(file, bytes);
  assert.deepEqual((await coldOpen(dir)).json(), { error: 'journal_corrupt' });
  bytes[at + 2] = 49; writeFileSync(file, bytes); assert.equal((await coldOpen(dir)).json().seq, seq + 1);
  // A foreign complete line after the checkpoint is verified and rejected.
  appendFileSync(file, '{"seq":1,"prevHash":null,"time":"x","type":"event","data":{},"hash":"0"}\n');
  assert.deepEqual((await coldOpen(dir)).json(), { error: 'journal_corrupt' });
});
