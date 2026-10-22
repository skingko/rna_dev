import { oneLine } from '../../../packages/sdk/src/proactive-message.mjs';

// What a light floor wake (wake-light-request.mjs; a research prototype, see docs/research/wake-light-context-replay-20261022.md) reads of a project: the decision snapshot
// (ProjectInitiativeController.snapshot) cut to what says whether anything is waiting to be acted on: the goal, the
// agenda and the user's open requests, what is due next, what was delivered and what finished work was not, and the
// rhythm assessment. Not carried: capability and action contracts, schedule task bodies, delivery texts, the
// conversation and turn excerpts, lessons (they steer how work is done, not whether it is due), evidence and receipt
// text (the SDK adds those as lines). A pure function of the snapshot, so a captured request can be cut the same way.
const iso = value => { const time = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; };
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
/** A mind entry (agenda item, open request) as a short row: its small scalar fields, its text cut. */
const entry = row => Object.fromEntries(Object.entries(row ?? {}).filter(([key, value]) => key !== 'id' && scalar(value) && value !== '').map(([key, value]) => [key, key === 'text' || typeof value === 'string' ? oneLine(value, key === 'text' ? 160 : 60) : value]));
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '' && !(Array.isArray(item) && !item.length) && !(typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length)));
export function lightProjectView(project = {}) {
  const mind = project.mind ?? {}, communication = project.communication ?? {}, assessment = project.rhythmStatus?.assessment, conversation = Array.isArray(project.recentConversation) ? project.recentConversation : [];
  const schedules = (Array.isArray(project.schedules) ? project.schedules : []).map(row => compact({ title: oneLine(row.title, 80), rule: row.rule, enabled: row.enabled, state: row.state, nextRunAt: iso(row.nextRunAt), userPaused: row.userPaused === true ? true : undefined }));
  return compact({
    title: project.title, goal: oneLine(project.focus || project.overview || project.description, 400),
    agenda: (mind.agenda ?? []).map(entry), openRequests: (mind.commitments ?? []).map(entry),
    schedules,
    delivery: compact({ lastDeliveredAt: iso(communication.lastDeliveredAt), pendingDeliveries: (communication.pending ?? []).length || undefined,
      finishedWorkNotInAnyDelivery: (communication.recentWorkNotReferencedByDelivery ?? []).map(row => compact({ finishedAt: iso(row.finishedAt), summary: oneLine(row.summary, 160) })) }),
    rhythm: assessment ? compact({ lifecycle: assessment.lifecycle, reason: oneLine(assessment.reason, 420), initiative: assessment.initiative }) : undefined,
    runningJobs: (project.pendingJobs ?? []).map(job => compact({ kind: job.kind, instruction: oneLine(job.instruction, 100) })),
    conversation: conversation.length ? { newestAt: iso(conversation.at(-1).at), newestRole: conversation.at(-1).role } : undefined });
}
