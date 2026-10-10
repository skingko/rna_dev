#!/usr/bin/env node
// W2 equivalence check (a), offline and free (design2 §7 W2): the twelve recorded changes of one schedule's task text, run
// through the shadow `basis` check as if the model had quoted the user message that triggered each (the best case for the
// check; a model that quotes less cannot be found more often). Each change is made through the host's own paths, on a scratch
// store holding a copy of the conversation: a foreground change through the `project_schedule` tool (`expectedRevision` and
// `basis` as a v2 model sends them), a planner change through `ProjectScheduleService.applyInitiativeAction` citing the messages
// the recorded action cited. So what is reported is what the services did: whether the change was saved (the shadow check
// refuses nothing), and the check they recorded (`taskBasis` on the record, `basisCheck` in the receipt), which must be the one
// the pure check gives. Against the analyst's labels (schedule-text-cases.mjs) it shows what the check would have flagged.
// The agreement with the labels is a consistency check, not independent evidence: S3 read the same stored verdicts
// (`capture.durable`) when it labelled the changes.
//
// Usage: node benchmark/schedule-basis-equivalence.mjs --session FILE [--session FILE …] [--json]
//   FILE: a conversation as the state stores it (`{ id, items: [{ id, kind, text, createdAt, capture? … }] }`), e.g. a copy of the
//   project's session shard; it holds private text, so keep it outside the repository. Never point it at the live state.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEDULE_HISTORY } from './schedule-text-cases.mjs';
import { projectUserItems, scheduleBasisCheck } from '../schedule-basis.mjs';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';

/** The longest `basis` the tool and the planner schedule accept; a longer message is quoted by its first part. */
const BASIS_LIMIT = 1000;
const DAILY = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
/**
 * Each edit through the host. The planner path counts only the messages the action cited; the tool path any message of the project.
 * `allowed`: the service saved the change (the task is the proposed one, the revision moved by one). `check`: what the service
 * recorded; `expected`: what the pure check says for the same quote and messages, and `consistent` that they are the same.
 * `agrees` is only defined where the check had a verdict to read (a `capture.durable` on the cited message): a durable change
 * should be allowed, a one-off change refused. A mechanical change has no request behind it, so no message can settle it: its row
 * says whether the check at least flagged it (no basis, or none found). `taskFor(edit)` is the text each change writes (default: a
 * distinct synthetic text, so that every change changes the task).
 */
export function basisEquivalence({ history = SCHEDULE_HISTORY, sessions, taskFor = edit => `Task as of revision ${edit.rev}.` }) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-basis-equivalence-'));
  try {
    const store = new Store(join(dir, 'state.json')), { project, session } = store.createProject({ name: 'Equivalence check', workspace: dir });
    store.mutate(state => {
      const row = state.projects.find(item => item.id === project.id), template = state.sessions.find(item => item.id === session.id);
      row.initiative.enabled = true; row.permissions = { workspace: 'write', background: 'read' };
      template.items = [];
      for (const source of sessions) state.sessions.push({ ...structuredClone(template), id: source.id, title: source.title ?? source.id, items: structuredClone(source.items ?? []), archivedAt: null });
    });
    const service = new ProjectScheduleService(store, { now: () => Date.now() }), schedule = service.create(project.id, { title: 'Equivalence check', task: 'The task before the first recorded change.', rule: DAILY }, { requestId: 'equivalence' });
    const tool = service.createTools({ projectId: project.id, sessionId: session.id }).find(item => item.name === 'project_schedule');
    const stored = () => store.state.projects.find(item => item.id === project.id).schedules.find(item => item.id === schedule.id);
    const items = projectUserItems(store.state, project.id);
    const rows = history.map(edit => {
      const cited = edit.cited.map(prefix => items.find(item => item.id.startsWith(prefix)) ?? null), found = cited.filter(Boolean), quoted = found.at(-1) ?? null, basis = quoted?.text.slice(0, BASIS_LIMIT);
      const expected = scheduleBasisCheck({ basis, items, referenced: edit.path === 'planner' ? found.map(item => item.id) : null });
      const before = stored(), proposed = taskFor(edit);
      let recorded = null, refusal = null;
      if (edit.path === 'tool') {
        const out = tool.execute(`call-${edit.rev}`, { action: 'update', id: schedule.id, task: proposed, expectedRevision: before.revision, ...(basis ? { basis } : {}) });
        if (out.isError) refusal = String(out.content?.[0]?.text ?? 'refused').slice(0, 160); else recorded = stored().taskBasis?.check ?? null;
      } else {
        const actionId = `action-${edit.rev}`, evidence = [...found.map(item => ({ id: `message:${item.id}`, type: 'user_message', summary: item.text.slice(0, 200), at: item.at })), { id: 'project-state', type: 'project_state', summary: 'The project state.' }];
        try {
          service.applyInitiativeAction(project.id, { actionId, schedule: { operation: 'update', id: schedule.id, expectedRevision: before.revision, task: proposed, ...(basis ? { basis } : {}) }, reason: 'Equivalence check: the change the recorded action made.', evidenceIds: found.length ? found.map(item => `message:${item.id}`) : ['project-state'], evidence });
          recorded = store.state.projects.find(item => item.id === project.id).scheduleManagementReceipts.find(row => row.actionId === actionId)?.basisCheck ?? null;
        } catch (error) { refusal = String(error?.message ?? error).slice(0, 160); }
      }
      const after = stored(), allowed = refusal === null && after.task === proposed && after.revision === before.revision + 1;
      const judged = typeof expected.durable === 'string', wouldRefuse = expected.check === 'one_off';
      const agrees = !judged ? null : edit.label === 'durable' ? !wouldRefuse : edit.label === 'one_off' ? wouldRefuse : null;
      return { rev: edit.rev, path: edit.path, label: edit.label, ...(edit.informational ? { informational: true } : {}), cited: edit.cited.length, resolved: found.length, check: recorded, expected: expected.check, consistent: recorded === expected.check, ...(judged ? { durable: expected.durable } : {}), judged, allowed, ...(refusal ? { refusal } : {}), wouldRefuse, agrees, flagged: ['absent', 'not_found', 'one_off'].includes(recorded) };
    });
    const judged = rows.filter(row => row.judged);
    return { viaServices: true, edits: rows.length, unresolved: rows.filter(row => row.resolved < row.cited).map(row => row.rev), judged: judged.length, agree: judged.filter(row => row.agrees === true).length, disagree: judged.filter(row => row.agrees === false).map(row => row.rev), allAllowed: rows.every(row => row.allowed), refused: rows.filter(row => !row.allowed).map(row => row.rev), inconsistent: rows.filter(row => !row.consistent).map(row => row.rev), flagged: rows.filter(row => row.flagged).map(row => row.rev), notCaught: rows.filter(row => row.label !== 'durable' && !row.flagged).map(row => row.rev), rows };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function equivalenceText(report) {
  const lines = ['rev  path     label      cited  recorded   pure       verdict   saved  refuse?  agrees'];
  for (const row of report.rows) lines.push(`${String(row.rev).padEnd(4)} ${row.path.padEnd(8)} ${row.label.padEnd(10)} ${`${row.resolved}/${row.cited}`.padEnd(6)} ${String(row.check ?? '-').padEnd(10)} ${row.expected.padEnd(10)} ${(row.durable ?? '-').padEnd(9)} ${(row.allowed ? 'yes' : 'NO').padEnd(6)} ${String(row.wouldRefuse).padEnd(8)} ${row.agrees === null ? '-' : row.agrees ? 'yes' : 'NO'}`);
  lines.push('', `${report.edits} historical changes made through the host's tool and planner paths; ${report.judged} carry a stored verdict (capture.durable): ${report.judged ? `${report.agree}/${report.judged}` : 'none'} consistent with the analyst's label${report.disagree.length ? ` (disagree: rev ${report.disagree.join(', ')})` : ''} (a consistency check: the labels were read partly from the same stored verdicts).`,
    `The host saved ${report.allAllowed ? 'all' : `NOT all (refused: rev ${report.refused.join(', ')})`} of them, and recorded ${report.inconsistent.length ? `a check that differs from the pure check for rev ${report.inconsistent.join(', ')}` : 'the same check as the pure check for every one'}. Flagged (no basis, none found, or a one-off verdict): rev ${report.flagged.join(', ') || 'none'}. Mechanical or one-off changes it cannot catch: rev ${report.notCaught.join(', ') || 'none'}.`,
    ...(report.unresolved.length ? [`Cited messages missing from the supplied conversations: rev ${report.unresolved.join(', ')}.`] : []));
  return lines.join('\n');
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('schedule-basis-equivalence.mjs')) {
  const args = process.argv.slice(2), files = [], json = args.includes('--json');
  for (let index = 0; index < args.length; index++) if (args[index] === '--session') files.push(args[++index]);
  if (!files.length) { console.error('usage: node benchmark/schedule-basis-equivalence.mjs --session FILE [--session FILE …] [--json]'); process.exit(2); }
  const report = basisEquivalence({ sessions: files.map(file => JSON.parse(readFileSync(file, 'utf8'))) });
  console.log(json ? JSON.stringify(report, null, 2) : equivalenceText(report));
}
