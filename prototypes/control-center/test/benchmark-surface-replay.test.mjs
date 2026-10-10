import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayJournal, replaySurface, summarize } from '../benchmark/surface-replay.mjs';

// The equivalence check for the lean scheduled surface (token-burn T2): journals built the way the SDK writes them,
// with only what the check reads.
const SCRIPT = fileURLToPath(new URL('../benchmark/surface-replay.mjs', import.meta.url));
const record = (seq, type, data) => JSON.stringify({ seq, prevHash: seq === 1 ? null : 'ab', time: '2026-10-05T01:00:00.000Z', type, data, hash: 'cd' });
const authorization = ({ purpose = 'background-work', executable, unavailable = [], notDeclared } = {}) => ({ id: `auth-${executable.join('-')}`, role: 'user', content: [{ type: 'text', text: 'Host instructions for this request.' }], source: 'context',
  context: [{ source: 'host-authorization', text: JSON.stringify({ purpose, authorization: 'execute', readOnly: false, executableTools: executable, declaredButUnavailable: unavailable, ...(notDeclared ? { notDeclaredHere: notDeclared, notDeclaredRule: 'Tools in notDeclaredHere are not available in this run; do not call them.' } : {}), rule: 'x' }) }] });
/** `steps`: { auth }, { call: name, result?: {...} } | { requested: name, error: text } in order. A call is a request whose response carries one tool call. */
function journal(steps, { header = { format: 'rna-session', version: 1, sessionId: 's' } } = {}) {
  const lines = [record(1, 'session_header', header)];
  let seq = 2, request = 0;
  for (const step of steps) {
    if (step.auth) { lines.push(record(seq++, 'message', { message: authorization(step.auth) })); lines.push(record(seq++, 'event', { type: 'message_end' })); continue; }
    const name = step.call ?? step.requested, messageId = `m${request++}`, callId = `c${request}`;
    lines.push(record(seq++, 'request_completed', { requestId: `r${request}`, message: { id: messageId, role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: {} }], usage: {} } }));
    if (step.call) lines.push(record(seq++, 'tool_intent', { callKey: `${messageId}/${callId}`, toolCallId: callId, toolName: name, arguments: {}, effect: 'read', idempotent: true }));
    // As the SDK writes it: `isError` beside the result (only a refusal carries it inside too), and the tool-result message.
    const result = step.result ?? { content: [{ type: 'text', text: step.error ?? 'ok' }] };
    lines.push(record(seq++, 'tool_completed', { callKey: `${messageId}/${callId}`, result, ...(step.error || result.isError ? { isError: true } : {}), message: { id: `t${request}`, role: 'toolResult', toolCallId: callId, toolName: name, assistantId: messageId, content: result.content } }));
  }
  return `${lines.join('\n')}\n`;
}
const REFUSED = { isError: true, content: [{ type: 'text', text: 'refused' }], details: { code: 'tool_unavailable_for_purpose', executed: false } };
const NOT_ASSIGNED = 'Tool is not assigned to this session.';

test('a run whose calls all name executable tools passes; a call to a stub fails the check with its tool and why', () => {
  const clean = replayJournal(journal([{ auth: { executable: ['project_read', 'web_fetch'], unavailable: ['agent_consult'] } }, { call: 'project_read' }, { call: 'web_fetch' }]), { file: 'clean.jsonl' });
  assert.deepEqual({ purpose: clean.purpose, calls: clean.calls, checked: clean.checked, violations: clean.violations, stubHits: clean.stubHits }, { purpose: 'background-work', calls: 2, checked: 2, violations: [], stubHits: 0 });
  const stub = replayJournal(journal([{ auth: { executable: ['project_read'], unavailable: ['agent_consult'] } }, { call: 'agent_consult', result: REFUSED }]), { file: 'stub.jsonl' });
  assert.equal(stub.stubHits, 1); assert.deepEqual(stub.violations.map(row => [row.tool, row.reason]), [['agent_consult', 'declared_but_unavailable']]);
  const unlisted = replayJournal(journal([{ auth: { executable: ['project_read'] } }, { call: 'mystery' }]));
  assert.deepEqual(unlisted.violations.map(row => row.reason), ['unlisted']);
});

test('the latest authorization block before a call is the one it is checked against', () => {
  const run = replayJournal(journal([{ auth: { executable: ['project_read'], unavailable: ['project_write'] } }, { call: 'project_read' }, { auth: { executable: ['project_read', 'project_write'] } }, { call: 'project_write' }]));
  assert.equal(run.authorizations, 2); assert.deepEqual(run.violations, [], 'project_write became executable before it was called');
  const before = replayJournal(journal([{ auth: { executable: ['project_read'], unavailable: ['project_write'] } }, { call: 'project_write' }, { auth: { executable: ['project_read', 'project_write'] } }]));
  assert.deepEqual(before.violations.map(row => row.tool), ['project_write'], 'a later block does not excuse an earlier call');
});

test('a lean run: the tools it did not declare are not violations, a call to one is counted as "not assigned", and the run is marked lean', () => {
  const run = replayJournal(journal([{ auth: { executable: ['project_read'], notDeclared: ['agent_consult', 'ask_user'] } }, { requested: 'agent_consult', error: NOT_ASSIGNED }, { call: 'project_read' }]), { file: 'schedule-work-x/lean.jsonl' });
  assert.equal(run.lean, true); assert.deepEqual(run.violations, []); assert.equal(run.stubHits, 0);
  assert.deepEqual(run.notAssigned.map(row => row.tool), ['agent_consult'], 'attributed to the tool the model asked for');
  assert.equal(run.calls, 1, 'a call to an undeclared tool has no tool_intent');
});

test('the scan: only SDK journals count; older background journals are checked against the stubs; a foreground journal without a block is not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-surface-replay-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (path, text) => { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text); };
  // Two authorized background runs establish the stubs: agent_consult and ask_user are declared-but-unavailable and never executable there.
  await put('state.json.rna/initiative/p/a1/one.rna.jsonl', journal([{ auth: { executable: ['project_read', 'project_write'], unavailable: ['agent_consult', 'ask_user'] } }, { call: 'project_read' }]));
  await put('state.json.rna/initiative/p/schedule-work-b2/two.rna.jsonl', journal([{ auth: { executable: ['project_read'], unavailable: ['agent_consult', 'ask_user', 'project_write'] } }, { call: 'project_read' }, { call: 'project_read' }]));
  // A foreground journal can run ask_user; one without a block is not a background run and is not checked.
  await put('state.json.rna/session-1/fg.rna.jsonl', journal([{ call: 'ask_user' }]));
  await put('state.json.rna/session-2/fg.rna.jsonl', journal([{ auth: { purpose: 'foreground', executable: ['ask_user', 'agent_consult'] } }, { call: 'agent_consult' }]));
  // An older background journal (no block) that never called a stub, and a ledger-like jsonl that is no journal at all.
  await put('state.json.rna/initiative/p/old1/old.rna.jsonl', journal([{ call: 'project_read' }, { call: 'project_exec' }]));
  await put('state.json.d/log-1.jsonl', '{"generation":1,"version":2}\n');
  const report = await replaySurface(dir);
  assert.equal(report.journals, 5, 'the ledger-like file is not an SDK journal');
  assert.deepEqual(report.stubs, ['agent_consult', 'ask_user']);
  assert.deepEqual(report.background, { runs: 3, calls: 5, stubCalls: 0, stubRefusals: 0 }, 'two authorized runs and the older one');
  assert.deepEqual(report.scheduled, { runs: 1, calls: 2, stubCalls: 0, tools: { project_read: 2 } });
  assert.deepEqual(report.notBackground, { runs: 1, calls: 1 }); assert.equal(report.ok, true);
  assert.deepEqual({ runs: report.purposes.foreground.runs, calls: report.purposes.foreground.calls }, { runs: 1, calls: 1 });
  // The same journals plus an older background run that called a stub: the check fails and names the call.
  await put('state.json.rna/initiative/p/old2/old.rna.jsonl', journal([{ call: 'project_read' }, { call: 'agent_consult', result: REFUSED }]));
  const failing = await replaySurface(dir);
  assert.equal(failing.ok, false); assert.equal(failing.background.stubCalls, 1); assert.equal(failing.background.stubRefusals, 1);
  assert.deepEqual(failing.failures.map(row => [row.file.split('/').slice(-2).join('/'), row.violations.map(violation => [violation.tool, violation.reason])]), [['old2/old.rna.jsonl', [['agent_consult', 'stub_without_authorization']]], ['old2/old.rna.jsonl', []]]);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' }), error => error.status === 1 && /NOT OK/.test(error.stdout) && /agent_consult/.test(error.stdout));
  await rm(join(dir, 'state.json.rna/initiative/p/old2'), { recursive: true });
  const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.match(out, /background-work runs in all: 3 runs, 5 calls, 0 stub calls/); assert.match(out, /OK: every call named a tool the run could execute/);
});

test('a lean run in the scan counts as lean; its "not assigned" results are reported and add no equivalence failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-surface-replay-lean-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'initiative/p/schedule-work-1'), { recursive: true });
  // 249 calls and 1 refused call: 0.4% of what the run asked for, under the design's 0.5% line.
  await writeFile(join(dir, 'initiative/p/schedule-work-1/run.rna.jsonl'), journal([{ auth: { executable: ['project_read'], notDeclared: ['agent_consult'] } }, { requested: 'agent_consult', error: NOT_ASSIGNED }, ...Array.from({ length: 249 }, () => ({ call: 'project_read' }))]));
  const report = await replaySurface(dir);
  assert.equal(report.failures.length, 0); assert.equal(report.leanRuns, 1); assert.equal(report.notAssigned, 1); assert.equal(report.purposes['background-work'].leanRuns, 1);
  assert.deepEqual({ ...report.leanNotAssigned, share: Number(report.leanNotAssigned.share.toFixed(4)) }, { runs: 1, asked: 250, notAssigned: 1, share: 0.004, max: 0.005, over: false });
  assert.equal(report.ok, true);
  assert.match(execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' }), /lean runs: 1, asked for 250 tool calls, 1 not assigned \(0\.40%, limit 0\.50%\)[^]*OK: every call named a tool the run could execute, and the not-assigned share is within 0\.50%/);
});

// Review of T2 (finding 1): the check used to print OK for a lean scan in which the model kept calling tools the lean array
// does not declare, though the design rolls the surface back above 0.5%.
test('a lean scan in which more than 0.5% of the asked-for calls were not assigned fails, names the roll-back, and can be given another limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-surface-replay-over-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'initiative/p/schedule-work-1'), { recursive: true });
  // 570 calls that ran and 30 that were refused as not assigned: 5%, ten times the line.
  await writeFile(join(dir, 'initiative/p/schedule-work-1/run.rna.jsonl'), journal([{ auth: { executable: ['project_read'], notDeclared: ['agent_consult'] } }, ...Array.from({ length: 30 }, () => ({ requested: 'agent_consult', error: NOT_ASSIGNED })), ...Array.from({ length: 570 }, () => ({ call: 'project_read' }))]));
  const report = await replaySurface(dir);
  assert.equal(report.failures.length, 0, 'every call that ran was executable'); assert.equal(report.leanNotAssigned.asked, 600); assert.equal(report.leanNotAssigned.notAssigned, 30);
  assert.equal(report.leanNotAssigned.over, true); assert.equal(report.ok, false);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' }), error => error.status === 1 && /not assigned share 5\.00% is over 0\.50%: roll the surface back with RNA_SCHEDULED_SURFACE=full/.test(error.stdout) && /NOT OK/.test(error.stdout) && !/OK: every call/.test(error.stdout));
  // The limit is an argument: 5% is within a 6% limit, and a malformed limit is a usage error.
  assert.equal((await replaySurface(dir, { maxNotAssigned: 0.06 })).ok, true);
  assert.match(execFileSync(process.execPath, [SCRIPT, dir, '--max-not-assigned=0.06'], { encoding: 'utf8' }), /limit 6\.00%[^]*OK: every call/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, dir, '--max-not-assigned=lots'], { encoding: 'utf8', stdio: 'pipe' }), error => error.status === 2);
  assert.throws(() => summarize([], { maxNotAssigned: 2 }), RangeError);
  // The line itself is inclusive: exactly 0.5% passes (5 of 1000), one more refused call does not.
  const at = replayJournal(journal([{ auth: { executable: ['project_read'], notDeclared: ['agent_consult'] } }, ...Array.from({ length: 5 }, () => ({ requested: 'agent_consult', error: NOT_ASSIGNED })), ...Array.from({ length: 995 }, () => ({ call: 'project_read' }))]));
  assert.equal(summarize([at]).leanNotAssigned.over, false); at.notAssigned.push({ seq: 0, tool: 'agent_consult' }); assert.equal(summarize([at]).leanNotAssigned.over, true);
});

test('a full-surface scan reports no lean share, so the not-assigned line cannot fail it', () => {
  const run = replayJournal(journal([{ auth: { executable: ['project_read'], unavailable: ['agent_consult'] } }, { call: 'project_read' }]), { file: 'initiative/p/a1/full.rna.jsonl' });
  const report = summarize([run]);
  assert.deepEqual(report.leanNotAssigned, { runs: 0, asked: 0, notAssigned: 0, share: 0, max: 0.005, over: false }); assert.equal(report.ok, true);
});
