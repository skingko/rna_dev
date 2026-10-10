import { createWorkspaceTools } from './workspace-tools.mjs';
import { projectScheduleView } from './project-schedules.mjs';

const content = result => (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const documents = ['AGENTS.md', 'README.md', 'package.json'];

/** A bounded, read-only orientation, using the same private-path and symlink
 * policy as explicit project tools. It is context, never fabricated tool work. */
export async function readProjectOrientation({ cwd, deniedPaths = [], signal, tools, maxChars = 10000 } = {}) {
  signal?.throwIfAborted();
  const available = tools ?? await createWorkspaceTools(cwd, { deniedPaths });
  const get = name => available.find(tool => tool.name === name);
  const result = { source: 'host-read-workspace', entries: [], documents: [], limitations: [] };
  const list = get('project_list'), read = get('project_read');
  if (!list || !read) return { ...result, limitations: ['Workspace orientation is unavailable; inspect with assigned tools.'] };
  try {
    const listing = await list.execute('host-orientation-list', { path: '.' }, signal);
    if (listing.isError) throw new Error('listing_failed');
    const raw = content(listing);
    result.entries = raw === '(empty directory)' ? [] : raw.split('\n').filter(Boolean).slice(0, 100);
    if (result.entries.length === 100) result.limitations.push('Root listing may be truncated at 100 entries.');
  } catch (error) { signal?.throwIfAborted(); result.limitations.push('Root directory could not be read; do not infer it is empty.'); }
  let remaining = Math.max(0, Math.min(maxChars, 20000));
  for (const path of documents) {
    if (!result.entries.includes(path) || remaining <= 0) continue;
    try {
      const response = await read.execute(`host-orientation-${path}`, { path, offset: 1, limit: 120 }, signal);
      if (response.isError) throw new Error('read_failed');
      const raw = content(response), text = raw.slice(0, Math.min(remaining, path === 'AGENTS.md' ? 6000 : 3000));
      remaining -= text.length;
      result.documents.push({ path, sha256: response.details?.hash, content: text, truncated: text.length < raw.length || response.details?.truncated === true || response.details?.totalLines > response.details?.returnedLines });
    } catch (error) { signal?.throwIfAborted(); result.limitations.push(`${path} was listed but could not be read.`); }
  }
  result.limitations.push('Only a bounded root orientation was read. Inspect relevant source and nested instructions with project tools before editing; no dependencies or application were executed.');
  return result;
}

/**
 * What a schedule's `task` reads in the planning state when the same request already carries that text word for word:
 * a scheduled run's own occurrence message holds the task once, so the state need not repeat it (see `omitScheduleTask`).
 */
export const SCHEDULE_TASK_PLACEHOLDER = '(this run\'s task; identical to the task in this request)';

/**
 * The project's planning state for a request. `omitScheduleTask` ({ scheduleId, task }): the host's scheduled run says
 * which schedule it is performing and the task text of its own occurrence message. That schedule's `task` is replaced by
 * SCHEDULE_TASK_PLACEHOLDER only while it is byte-identical to `task`; a schedule edited since keeps its whole text, so
 * the model reads the change. Other schedules are never touched. Without the option the state is what it always was.
 */
export function projectWorkingContext(project, { omitScheduleTask } = {}) {
  if (!project) return null;
  const concise = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';
  return {
    title: concise(project.name ?? project.title, 300), description: concise(project.description, 8000),
    overview: concise(project.overview ?? project.initialState?.overview ?? project.state?.overview),
    focus: concise(project.focus ?? project.initialState?.focus),
    milestones: (project.milestones ?? []).slice(-12).map(row => ({ title: concise(row.title, 300), description: concise(row.description, 800), status: row.status, acceptanceCriteria: (row.acceptanceCriteria ?? []).slice(0, 8).map(value => concise(value, 500)) })),
    openQuestions: (project.openQuestions ?? []).slice(-12).map(value => concise(typeof value === 'string' ? value : value.text, 500)),
    commitments: (project.commitments ?? []).filter(row => row.simulated !== true).slice(-12).map(row => ({ text: concise(row.text, 700), source: row.source, status: row.status })),
    schedules: (project.schedules ?? []).slice(0, 32).map(row => { const view = projectScheduleView(row), carried = typeof omitScheduleTask?.task === 'string' && omitScheduleTask.task !== '' && view.id === omitScheduleTask.scheduleId && view.task === omitScheduleTask.task; return { id: view.id, title: view.title, task: carried ? SCHEDULE_TASK_PLACEHOLDER : view.task, rule: view.rule, destinationSessionId: view.destinationSessionId, enabled: view.enabled, nextRunAt: view.nextRunAt, state: view.state }; }),
    evidenceBoundary: 'Project planning metadata preserves intent and recorded decisions. It is not proof that implementation or validation has happened. Initial open questions may be superseded by later user answers in this conversation; honor the latest confirmed decision. Only persisted schedules establish timed delivery; a promise or a review timer does not.'
  };
}
