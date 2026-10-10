// Shared fixture for the session and turn tests (design 0.63 §13 T4): a real temporary git repository under
// os.tmpdir() with no global or system git configuration, a real Store, the real merge engine (release gate forced
// open, sandbox assumed), roots, worktrees, session worktrees, turn checkpoints, the interaction service and a
// RuntimeController whose model is a scripted provider (no network, no paid model). Never the user's projects.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../store.mjs';
import { WorkspaceGitService } from '../../workspace-git-service.mjs';
import { RootResolver } from '../../workspace-roots.mjs';
import { WorktreeService } from '../../worktree-service.mjs';
import { IsolationEngine } from '../../git-isolation/index.mjs';
import { SessionWorktreeService } from '../../session-worktree-service.mjs';
import { TurnCheckpoint } from '../../turn-checkpoint.mjs';
import { UserInteractionService } from '../../user-interaction-service.mjs';
import { RuntimeController } from '../../runtime-controller.mjs';
import { createRnaRuntime } from '../../rna-runtime.mjs';
import { applyProjectPermissions } from '../../project-permissions.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const gitOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
export const skip = gitOk ? false : 'git 2.38 or later is needed';
export const put = (root, path, content) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
export const read = (root, path) => readFileSync(join(root, path), 'utf8');
export const there = (root, path) => existsSync(join(root, path));
export async function until(check, what = 'condition', timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`${what} did not settle`); await delay(15); }
}

/**
 * A scripted model: each request takes the next step. A step is a function of the request (to look at the host
 * feedback it carries) answering one of { write: [path, content] }, { writes: [[path, content], …] },
 * { edit: [path, oldText, newText] }, { ask: questions }, { text }, { fail: message }, { hold: Promise } (waits,
 * then plays its `then` step), or a plain step object.
 */
export function scripted() {
  const steps = [], requests = [];
  async function* provider(request) {
    requests.push(request);
    let step = steps.shift() ?? { text: '完成。' };
    if (typeof step === 'function') step = await step(request);
    while (step.hold) { await step.hold; step = step.then ?? { text: '完成。' }; if (typeof step === 'function') step = await step(request); }
    const id = `call-${requests.length}`;
    if (step.fail) throw Object.assign(new Error(step.fail), { status: 400 });
    if (step.write || step.writes) {
      // A write without expectedHash replaces only a version the conversation has seen (A6), so read each file first.
      for (const [index, [path, content]] of (step.writes ?? [step.write]).entries()) { yield { type: 'tool_call', id: `${id}-read-${index}`, name: 'project_read', arguments: { path } }; yield { type: 'tool_call', id: `${id}-${index}`, name: 'project_write', arguments: { path, content } }; }
      yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    if (step.edit) { const [path, oldText, newText] = step.edit; yield { type: 'tool_call', id, name: 'project_edit', arguments: { path, oldText, newText } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    if (step.exec) { yield { type: 'tool_call', id, name: 'project_exec', arguments: { command: step.exec } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    if (step.ask) { yield { type: 'tool_call', id, name: 'ask_user', arguments: { questions: step.ask } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield { type: 'text_delta', delta: step.text ?? '完成。' }; yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' };
  }
  return { steps, requests, provider };
}

/** The host feedback texts (by source) a request carries in its last finish-feedback message. */
export function feedbackOf(request) {
  const message = [...(request?.messages ?? [])].reverse().find(row => row.role === 'user' && row.source === 'finish-feedback');
  if (Array.isArray(message?.context)) return message.context.map(row => ({ source: row.source, text: row.text }));
  // The provider request carries the observations as one reference-data text part: `[…]\n[{ source, text }, …]`.
  for (const part of message?.content ?? []) {
    const text = part?.text ?? '', cut = text.indexOf('\n[');
    if (!text.startsWith('[Retrieved reference data') || cut < 0) continue;
    try { return JSON.parse(text.slice(cut + 1)).map(row => ({ source: row.source, text: row.text })); } catch { /* not ours */ }
  }
  return [];
}
/** Whether a request carries host context from `source` anywhere in its messages. */
export const carries = (request, source) => JSON.stringify(request?.messages ?? []).includes(`\\"source\\":\\"${source}\\"`) || JSON.stringify(request?.messages ?? []).includes(`"source":"${source}"`);

export function turnFixture(t, { files = { 'a.txt': 'one\ntwo\nthree\n', 'src/app.js': 'export const a = 1;\n' }, gitignore = 'dist/\n', prefix = '', runtime: runtimeOptions = {}, engine: engineOptions = {}, waitMs } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-turns-'))), repo = join(dir, 'repo'), P = prefix ? join(repo, prefix) : repo;
  mkdirSync(P, { recursive: true });
  git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) put(P, path, content);
  if (gitignore !== null) put(P, '.gitignore', gitignore);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'first');
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'turn-fixture-synthetic-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Turns', workspace: P, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  const gitService = new WorkspaceGitService(store);
  const holder = {};
  const engine = new IsolationEngine(store, { git: gitService, ready: true, sandbox: () => true, pollMs: 20, execWaitMs: 3000, execRunning: id => holder.runtime?.execRunning(id) ?? 0, attributable: (projectId, turnId) => holder.checkpoints.attributable(projectId, turnId), ...engineOptions });
  gitService.engine = engine;
  const roots = new RootResolver(store, { git: gitService, execRunning: id => holder.runtime?.execRunning(id) ?? 0 });
  const worktrees = new WorktreeService(store, { git: gitService, engine, roots });
  gitService.owners = path => worktrees.ownerOf(path);
  const interactions = new UserInteractionService(store);
  const sessionWorktrees = new SessionWorktreeService(store, { engine, worktrees, roots, interactions });
  const checkpoints = holder.checkpoints = new TurnCheckpoint(store, { engine, roots, ...(waitMs ? { waitMs } : {}) });
  const model = scripted();
  const runtime = holder.runtime = new RuntimeController(store, { factory: options => createRnaRuntime({ ...options, provider: model.provider }), interactions, roots, sessionWorktrees, checkpoints, ...runtimeOptions });
  t.after(async () => { await runtime.close(); sessionWorktrees.close(); engine.close(); interactions.close(); rmSync(dir, { recursive: true, force: true }); });
  const sessionOf = id => store.state.sessions.find(row => row.id === id);
  const projectRow = () => store.state.projects.find(row => row.id === project.id);
  const quiet = async id => { await until(() => !runtime.running.has(id) && !runtime.handBacks.has(id) && !sessionWorktrees.queues.has(id), 'the conversation to settle'); };
  /** Send a message and wait until its turn and its hand-back settled; answers the turn. */
  const send = async (id, text) => {
    store.message(id, { text });
    const turnId = sessionOf(id).activeTurnId;
    await until(() => { const turn = sessionOf(id)?.turns.find(row => row.id === turnId); return turn && turn.status !== 'running'; }, `turn ${text}`);
    await quiet(id);
    return sessionOf(id).turns.find(row => row.id === turnId);
  };
  const worktreeSession = (title = '工作树对话') => store.createSession({ projectId: project.id, title, worktree: true });
  const rootOf = id => roots.rootOf({ projectId: project.id, sessionId: id });
  const applies = () => projectRow().git?.applies ?? [];
  const recordOf = id => (projectRow().git?.worktrees ?? []).find(row => row.id === sessionOf(id)?.worktree?.id) ?? null;
  return { dir, repo, P, prefix, store, project, session, git: gitService, engine, roots, worktrees, interactions, sessionWorktrees, checkpoints, runtime, model, sessionOf, projectRow, send, quiet, worktreeSession, rootOf, applies, recordOf };
}

/** The tree of a revision in the repository (`git rev-parse <rev>^{tree}`). */
export const treeOf = (repo, rev) => git(repo, 'rev-parse', `${rev}^{tree}`).trim();
/** The interaction record of a host card (by its actionId prefix) in a conversation, newest first. */
export function cardOf(store, sessionId, actionId) {
  return store.state.sessions.find(row => row.id === sessionId)?.items.findLast(item => item.interaction?.actionId?.startsWith(actionId))?.interaction ?? null;
}
