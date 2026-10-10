// The twelve recorded changes of one schedule's task text (design2 §7 W2, from S3: the AI-news project's daily task, revisions
// 2..17), as the shadow `basis` check and the paired text replay read them. Identifiers and the analyst's labels only, no text:
// the message ids are prefixes of ids in the project's own conversation, the action and turn ids prefixes of its own records.
// The labels are S3's reading of what each change was (not a heuristic and not the host's): a lasting request of the user
// (`durable`), a one-time or limited request that was written into the standing text (`one_off`), or a mechanism the model
// wrote on its own, with no request behind it (`mechanical`). Revision 9 is the foreground model writing the same lasting
// request the planner had written 90 seconds earlier (informational: it may rightly find nothing left to write). `rewrite` marks a
// request that is itself a rewrite of the whole text (rev 8, 9: "make the task prompt more concise"): the gate's bound on how
// many of the earlier sentences a lasting write may touch does not apply to it (the scope is shown, not bounded).
//
//   path 'planner': ref is the planning action's id (project.initiativeRuntime.sdkState.actions[].id) — its receipt gives
//                   the revision and the time, its schedule.task the text; `cited` the user messages it cited as evidence.
//   path 'tool':    ref is the turn in which the foreground model called project_schedule (the call's output gives the
//                   revision and the text).
export const SCHEDULE_HISTORY = Object.freeze([
  { rev: 2, path: 'planner', ref: 'da136e72', cited: ['14856463'], label: 'mechanical', note: 'its own dedupe-index milestone; cites an unrelated older answer' },
  { rev: 3, path: 'planner', ref: 'cfe77d8a', cited: ['d89af5ea'], label: 'one_off', note: 'a dated step ("decide after tomorrow\'s run") written into the standing text' },
  { rev: 8, path: 'planner', ref: 'c6cccf38', cited: ['66d933a5'], label: 'durable', rewrite: true, note: 'the user asked for a more concise task prompt' },
  { rev: 9, path: 'tool', ref: '8f1fb6f4', cited: ['66d933a5'], label: 'durable', rewrite: true, informational: true, note: 'the foreground model, 90 s after rev 8, same message' },
  { rev: 10, path: 'tool', ref: '5fdb5b38', cited: ['2ef16d4b'], label: 'durable', note: '"from now on deliver daily.md directly"' },
  { rev: 11, path: 'planner', ref: '2032a2b2', cited: ['2ef16d4b'], label: 'mechanical', note: 'its own reading of a delivery; cites the 09-28 message' },
  { rev: 12, path: 'planner', ref: '3deb7259', cited: ['cac0045e', '4c332576', 'ebfc9aa4'], label: 'durable', note: 'three answers: time zone, sources, deduplication' },
  { rev: 13, path: 'planner', ref: 'ed5cfefe', cited: [], label: 'mechanical', note: 'its own diagnosis of a delivery defect; cites no user message' },
  { rev: 14, path: 'planner', ref: '59932b91', cited: ['39c605ee'], label: 'durable', note: 'add security disclosures to the daily report' },
  { rev: 15, path: 'planner', ref: 'fd81496c', cited: ['3f9e6e63'], label: 'durable', note: 'the user\'s answer: keep the current state, no browser install' },
  { rev: 16, path: 'tool', ref: '8604d1b9', cited: ['b37290ef'], label: 'one_off', note: '"fix the 2 problems found in the existing files" written in as a daily acceptance rule' },
  { rev: 17, path: 'tool', ref: '463458ab', cited: ['fcca1f9e'], label: 'durable', note: '"from now on only the most severe GitHub level"' }
]);
/** What the pass conditions require of the new text: a durable change is still written (and only where the user's words
 * touch it); a one-off or mechanical change is not written into the standing text any more. */
export const EXPECTED = Object.freeze({ durable: 'write', one_off: 'no_write', mechanical: 'no_write' });
export const historyOf = rev => SCHEDULE_HISTORY.find(row => row.rev === rev) ?? null;
/** The edits that must hold for the gate: six durable writes remain, two one-off writes and three mechanical writes are gone. */
export const REQUIRED = Object.freeze({ durable: SCHEDULE_HISTORY.filter(row => row.label === 'durable' && !row.informational).map(row => row.rev), oneOff: SCHEDULE_HISTORY.filter(row => row.label === 'one_off').map(row => row.rev), mechanical: SCHEDULE_HISTORY.filter(row => row.label === 'mechanical').map(row => row.rev) });
