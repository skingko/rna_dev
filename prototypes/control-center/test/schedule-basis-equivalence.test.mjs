import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basisEquivalence, equivalenceText } from '../benchmark/schedule-basis-equivalence.mjs';
import { SCHEDULE_HISTORY, EXPECTED, historyOf } from '../benchmark/schedule-text-cases.mjs';

// W2 equivalence check (a), offline and free (design2 §7 W2): the twelve recorded changes of one schedule's task, each through the shadow
// basis check as if the model had quoted the user message that triggered it. Run on the real conversation (a copy of its shard) it
// gives: three changes carry a stored verdict (rev 14 durable, rev 16 one_off, rev 17 durable) and the check agrees with the analyst's
// label on all three; the shadow check allows every one. The changes are made through the host's own paths (the project_schedule tool
// and the planner's action) on a scratch store, so "allowed" and the recorded check are what the services did. Here the same
// conversation is rebuilt from synthetic text.
const ids = { 14856463: 'a1', d89af5ea: 'a2', '66d933a5': 'a3', '2ef16d4b': 'a4', cac0045e: 'a5', '4c332576': 'a6', ebfc9aa4: 'a7', '39c605ee': 'a8', '3f9e6e63': 'a9', b37290ef: 'b1', fcca1f9e: 'b2' };
const CAPTURES = { '39c605ee': { durable: 'durable', source: 'jev' }, b37290ef: { durable: 'one_off', source: 'jev' }, fcca1f9e: { preference: true, durable: 'durable', source: 'mixed' } };
const session = (over = {}) => ({ id: 'session-1', items: [
  ...Object.keys(ids).map((prefix, index) => ({ id: `${prefix}-0000-4000-8000-00000000000${index % 10}`, kind: 'user', text: `Synthetic message ${prefix}: please change how the report is written.`, createdAt: `2026-10-0${1 + index % 3}T00:00:0${index % 10}.000Z`, ...(CAPTURES[prefix] ? { capture: CAPTURES[prefix] } : {}) })),
  { id: 'assistant-1', kind: 'assistant', text: 'Synthetic message 66d933a5: please change how the report is written.' }], ...over });

test('the twelve historical changes through the shadow check: the three with a stored verdict agree with the label, every change is allowed', () => {
  const report = basisEquivalence({ sessions: [session()] });
  assert.equal(report.viaServices, true); assert.equal(report.edits, 12); assert.deepEqual(report.unresolved, []); assert.equal(report.allAllowed, true); assert.deepEqual(report.refused, []);
  assert.deepEqual(report.inconsistent, [], 'the check the services recorded is the pure check, for every change');
  assert.equal(report.judged, 3); assert.equal(report.agree, 3); assert.deepEqual(report.disagree, []);
  const by = Object.fromEntries(report.rows.map(row => [row.rev, row]));
  assert.deepEqual([by[14].check, by[16].check, by[17].check], ['quoted', 'one_off', 'quoted']);
  assert.deepEqual([by[14].agrees, by[16].agrees, by[17].agrees], [true, true, true]); assert.deepEqual([by[14].wouldRefuse, by[16].wouldRefuse, by[17].wouldRefuse], [false, true, false]);
  for (const rev of [2, 3, 8, 9, 10, 11, 12, 15]) { assert.equal(by[rev].check, 'quoted', `rev ${rev}`); assert.equal(by[rev].judged, false); assert.equal(by[rev].agrees, null); }
  assert.equal(by[13].check, 'absent', 'rev 13 cites no user message: no basis'); assert.equal(by[13].resolved, 0);
  assert.equal(by[12].resolved, 3); assert.equal(by[12].cited, 3);
  assert.ok(report.rows.every(row => row.allowed === true && row.check === row.expected && row.consistent), 'the host saved every change, one-off verdicts included, and recorded the pure check: the shadow check refuses nothing');
  assert.equal(by[16].wouldRefuse, true); assert.equal(by[16].allowed, true, 'a gate would have refused rev 16; the shadow check saved it');
  assert.deepEqual(report.rows.filter(row => row.path === 'tool').map(row => row.rev), [9, 10, 16, 17]); assert.ok(report.rows.every(row => row.refusal === undefined));
  assert.deepEqual(report.flagged, [13, 16]); assert.deepEqual(report.notCaught, [2, 3, 11], 'a one-off or mechanical change that quotes a real message is invisible to the check');
});

test('"allowed" is what the services did: a change the host refuses is reported as refused, on either path, and the rest are still made', () => {
  const tooLong = 'x'.repeat(6001); // the schedule's task is at most 6000 characters: the host refuses the change, whoever sends it
  const report = basisEquivalence({ sessions: [session()], taskFor: edit => edit.rev === 12 || edit.rev === 16 ? tooLong : `Task as of revision ${edit.rev}.` });
  assert.equal(report.allAllowed, false); assert.deepEqual(report.refused, [12, 16], 'one planner change and one foreground change');
  const by = Object.fromEntries(report.rows.map(row => [row.rev, row]));
  assert.equal(by[12].allowed, false); assert.equal(by[16].allowed, false); assert.equal(by[12].check, null); assert.ok(by[12].refusal.length > 0 && by[16].refusal.length > 0);
  assert.equal(by[17].allowed, true, 'a change after a refusal is still made, against the current revision'); assert.equal(by[17].check, 'quoted'); assert.equal(by[15].allowed, true);
  assert.deepEqual(report.inconsistent, [12, 16], 'nothing was recorded for a change that was refused');
  assert.match(equivalenceText(report), /saved NOT all \(refused: rev 12, 16\)/);
});

test('the labels and the stored verdicts are read, not assumed: a durable change judged one-off disagrees, an undecided message is not judged', () => {
  const flipped = session(); flipped.items.find(item => item.id.startsWith('39c605ee')).capture = { durable: 'one_off' };
  const report = basisEquivalence({ sessions: [flipped] });
  assert.equal(report.judged, 3); assert.equal(report.agree, 2); assert.deepEqual(report.disagree, [14]); assert.equal(report.allAllowed, true, 'still allowed: the check never refuses');
  const undecided = session(); undecided.items.find(item => item.id.startsWith('b37290ef')).capture = { correction: false };
  const none = basisEquivalence({ sessions: [undecided] });
  assert.equal(none.judged, 2); assert.equal(none.rows.find(row => row.rev === 16).check, 'quoted'); assert.deepEqual(none.notCaught, [2, 3, 11, 16]);
  // A conversation that lacks the cited messages: reported, and the change is flagged rather than guessed.
  const partial = basisEquivalence({ sessions: [session({ items: session().items.filter(item => !item.id.startsWith('3f9e6e63')) })] });
  assert.deepEqual(partial.unresolved, [15]); assert.equal(partial.rows.find(row => row.rev === 15).check, 'absent'); assert.ok(partial.flagged.includes(15));
  // The planner counts only the messages its action cited; the tool path any message of the conversation.
  const custom = basisEquivalence({ history: [{ rev: 1, path: 'planner', ref: 'x', cited: ['66d933a5'], label: 'durable' }, { rev: 2, path: 'tool', ref: 'y', cited: ['66d933a5'], label: 'durable' }], sessions: [session()] });
  assert.deepEqual(custom.rows.map(row => row.check), ['quoted', 'quoted']);
  assert.equal(basisEquivalence({ history: [{ rev: 1, path: 'planner', ref: 'x', cited: ['nothing'], label: 'durable' }], sessions: [session()] }).rows[0].check, 'absent');
});

test('the history table: twelve revisions, the labels the pass conditions use, no text', () => {
  assert.deepEqual(SCHEDULE_HISTORY.map(row => row.rev), [2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(SCHEDULE_HISTORY.filter(row => row.path === 'tool').map(row => row.rev), [9, 10, 16, 17], 'the four foreground turns');
  assert.deepEqual(SCHEDULE_HISTORY.filter(row => row.path === 'tool').map(row => row.ref), ['8f1fb6f4', '5fdb5b38', '8604d1b9', '463458ab']);
  assert.deepEqual(SCHEDULE_HISTORY.filter(row => row.label === 'one_off').map(row => row.rev), [3, 16]);
  assert.deepEqual(SCHEDULE_HISTORY.filter(row => row.label === 'mechanical').map(row => row.rev), [2, 11, 13]);
  assert.deepEqual(SCHEDULE_HISTORY.filter(row => row.label === 'durable' && !row.informational).map(row => row.rev), [8, 10, 12, 14, 15, 17]);
  assert.equal(historyOf(9).informational, true); assert.equal(historyOf(99), null); assert.deepEqual(EXPECTED, { durable: 'write', one_off: 'no_write', mechanical: 'no_write' });
  assert.ok(SCHEDULE_HISTORY.every(row => /^[0-9a-f]{8}$/.test(row.ref) && row.cited.every(id => /^[0-9a-f]{8}$/.test(id))), 'identifier prefixes only');
  assert.ok(Object.isFrozen(SCHEDULE_HISTORY));
});

test('the report text and the command line', () => {
  const report = basisEquivalence({ sessions: [session()] }), text = equivalenceText(report);
  assert.match(text, /12 historical changes made through the host's tool and planner paths; 3 carry a stored verdict \(capture\.durable\): 3\/3 consistent with the analyst's label \(a consistency check/); assert.match(text, /The host saved all of them, and recorded the same check as the pure check for every one/); assert.match(text, /Flagged .*: rev 13, 16\./); assert.match(text, /cannot catch: rev 2, 3, 11/);
  assert.match(text, /^rev {2}path {5}label/m);
  const dir = mkdtempSync(join(tmpdir(), 'rna-basis-equivalence-')), file = join(dir, 'session.json'), script = fileURLToPath(new URL('../benchmark/schedule-basis-equivalence.mjs', import.meta.url));
  try {
    writeFileSync(file, JSON.stringify(session()));
    const out = execFileSync(process.execPath, [script, '--session', file], { encoding: 'utf8' });
    assert.match(out, /3\/3 consistent with the analyst's label/);
    assert.equal(JSON.parse(execFileSync(process.execPath, [script, '--session', file, '--json'], { encoding: 'utf8' })).agree, 3);
    assert.throws(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' }), /usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
