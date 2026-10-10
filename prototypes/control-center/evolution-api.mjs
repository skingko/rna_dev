import { ProjectGenomeStore } from './project-genome-store.mjs';
import { classifyEvolutionFailures } from './project-evolution-failures.mjs';
import { systemEvolutionAggregate, proposeSystemEvolution, listSystemEvolutionProposals, resolveSystemProposal } from './project-evolution-rrsi.mjs';
import { FOUNDATION_TASK_TYPES, deriveProjectTaskTypes } from '../../packages/sdk/src/skill-foundation-screen.mjs';

// P4 read/propose API for the versions view (F2) and CLI. Trial/adopt/rollback
// keep using POST /api/projects/:id/versions/:versionId/control.
const bad = (message, code, status = 400) => Object.assign(new Error(message), { status, code });
const projectOf = (store, id) => { const project = store.state.projects.find(row => row.id === id && !row.archivedAt); if (!project) throw bad('项目不存在或已归档。', 'project_unavailable', 404); return project; };
async function activeGenome(store, project) {
  const version = project.versions?.find(row => row.id === project.activeVersionId); if (!version?.bundle) return null;
  try { return (await new ProjectGenomeStore(store).read(project.id, version.id)).genome; } catch { return version.bundle.genome ?? null; }
}

export async function evolutionApiRoute({ method, pathname, searchParams = new URLSearchParams(), store, evolution, readBody = async () => ({}) }) {
  if (!pathname.startsWith('/api/v2/') || !evolution?.rrsi) return null;
  const rrsi = evolution.rrsi;
  if (method === 'GET' && pathname === '/api/v2/evolution/failures') return { status: 200, body: classifyEvolutionFailures(store.state.projects) };
  if (method === 'GET' && pathname === '/api/v2/evolution/system') return { status: 200, body: await systemEvolutionAggregate(store) };
  if (method === 'GET' && pathname === '/api/v2/evolution/system/proposals') return { status: 200, body: await listSystemEvolutionProposals(store, { limit: searchParams.get('limit') }) };
  const proposal = pathname.match(/^\/api\/v2\/evolution\/system\/proposals\/(sys-[a-z0-9-]+)$/);
  if (method === 'PATCH' && proposal) { const input = await readBody(); return { status: 200, body: await resolveSystemProposal(store, proposal[1], { status: input?.status, note: input?.note }) }; }
  if (method === 'POST' && pathname === '/api/v2/evolution/system/proposals') { const input = await readBody(); return { status: 201, body: await proposeSystemEvolution(store, { component: input?.component, key: input?.key, note: input?.note }) }; }
  const match = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/(evolution\/(changelog|components|history|signals|failures|replay-standard)|task-types)$/);
  if (!match) return null;
  const project = projectOf(store, match[1]), route = match[3] ?? match[2];
  if (route === 'task-types') {
    if (method === 'GET') return { status: 200, body: { projectId: project.id, taskTypes: deriveProjectTaskTypes({ title: project.name, description: project.description, focus: project.focus, taskTypes: project.taskTypes }), explicit: Array.isArray(project.taskTypes) && project.taskTypes.length > 0, vocabulary: FOUNDATION_TASK_TYPES } };
    if (method !== 'PATCH') return null;
    const input = await readBody(), types = input?.taskTypes;
    if (!(types === null || Array.isArray(types) && types.length >= 1 && types.length <= 4 && types.every(type => FOUNDATION_TASK_TYPES.includes(type)) && new Set(types).size === types.length)) throw bad(`taskTypes 必须为 1–4 个不同的类型：${FOUNDATION_TASK_TYPES.join(', ')}；或 null 表示自动推断。`, 'task_types_invalid');
    store.mutate(state => { const target = state.projects.find(row => row.id === project.id); if (types === null) delete target.taskTypes; else target.taskTypes = [...types]; target.updatedAt = new Date().toISOString(); });
    return { status: 200, body: { projectId: project.id, taskTypes: types ?? deriveProjectTaskTypes({ title: project.name, description: project.description, focus: project.focus }), explicit: types !== null } };
  }
  if (route === 'replay-standard' && method === 'POST') return { status: 200, body: await rrsi.replayStandardProposal(project.id, { genome: await activeGenome(store, project) }) };
  if (method !== 'GET') return null;
  const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit')) || 50));
  if (route === 'changelog') return { status: 200, body: { projectId: project.id, entries: await rrsi.changelog(project.id, { limit }) } };
  if (route === 'components') return { status: 200, body: await rrsi.components(project.id, { genome: await activeGenome(store, project), key: searchParams.get('key') || undefined }) };
  if (route === 'failures') return { status: 200, body: classifyEvolutionFailures([project]) };
  if (route === 'signals') {
    const collected = await rrsi.realSignals(project.id);
    return { status: 200, body: { projectId: project.id, counts: collected.counts, score: collected.score, heldOut: collected.heldOut, signals: collected.signals.slice(-limit).map(({ input, ...row }) => ({ ...row, ...(input ? { inputExcerpt: String(input).slice(0, 200) } : {}) })), replay: collected.replay.slice(-limit).map(row => ({ id: row.id, kind: row.kind, split: row.split, at: row.at, versionId: row.versionId, checks: row.checks, files: row.workspaceSnapshot.files.length, inputExcerpt: String(row.input).slice(0, 200) })) } };
  }
  const [records, frontier] = await Promise.all([rrsi.records(project.id), rrsi.frontier(project.id)]), active = project.versions?.find(row => row.id === project.activeVersionId);
  const directives = await rrsi.directives(project.id, { baselineHash: active?.bundle?.hash });
  return { status: 200, body: { projectId: project.id, config: rrsi.config, frontier: { round: frontier.round ?? 0, sStar: frontier.sStar ?? null, trajectory: frontier.trajectory ?? [] }, calibration: directives.calibration, budget: directives.budget, exploration: directives.exploration, falsified: directives.falsified, pruneSet: directives.pruneSet, records: records.slice(-limit) } };
}
