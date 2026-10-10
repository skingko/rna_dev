// D4 scenario harness: one real host in a temporary world (plan A7, align §1.3 H; pi test-harness.ts:1-60, harness
// docs/testing.md:29,33). createServer runs for real on a temporary state file and a real git repository; only the
// model (faux-model.mjs), the network services (fake OpenViking, fake JEV) and the clock (clock.mjs) are fake.
// Assertions read the world: state as persisted, sidecars beside it, workspace files, git refs, SSE frames and the
// request bodies the fakes received.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../../server.mjs';
import { createRnaRuntime } from '../../rna-runtime.mjs';
import { applyProjectPermissions } from '../../project-permissions.mjs';
import { prepareJudgmentPolicy } from '../../judgment-policy-service.mjs';
import { CHECKPOINT_SIDECARS, excludedSibling } from '../../state-checkpoint.mjs';
import { installClock } from './clock.mjs';
import { createFauxModel, JUDGMENT_PLAN, decide, decisionInput } from './faux-model.mjs';
import { createFakeOpenViking } from './fake-openviking.mjs';
import { createFakeJev, SYNTHETIC_JEV_KEY } from './fake-jev.mjs';
import { openSse, openBrowser, getJson } from './clients.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Scenario', '-c', 'user.email=scenario@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const gitReady = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();

/** Polls `check` until it returns a truthy value (wall time, not the scenario clock). */
export async function until(check, label = 'condition', timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`scenario: ${label} did not happen within ${timeoutMs} ms`);
    await delay(10);
  }
}

/**
 * Builds a world and registers its teardown on `t`. Options:
 *  files       workspace files ({ path: content }); `git: false` leaves the folder without a repository
 *  start       the clock's first reading (ms or ISO); the default is a fixed instant
 *  jev         false: no JEV key configured (judgments unavailable); default: the fake JEV answers
 *  memory      { autoStore, autoRecall } (both off by default); OpenViking is always the fake
 *  initiative  true: the background controller runs (scripted decisions and work), ticking every 50 ms
 *  mind        true: the project mind's model calls reach the faux model (tag 'mind'); off by default
 *  project     extra createProject input; `permissions` ({ workspace, background }) applied after creation
 *  model       { contextWindow, maxOutputTokens } of the faux model
 *  stream      the v2 stream hub's timings (pollMs 25 by default, so an injected-clock idle runs its real poll)
 *  idleCompaction  true: the host's idle compaction runs (its summary request reaches the faux model's 'http' lane);
 *              tick() runs its plan pass. It still needs a cold-gap estimate for the model (CacheSurvival samples).
 */
export async function createWorld(t, { files = { 'README.md': '# Scenario project\n' }, git: repo = true, start = '2026-10-05T01:00:00.000Z', jev: withJev = true, memory = {}, initiative = false, mind = false, project: projectInput = {}, model = {}, stream = {}, idleCompaction = false } = {}) {
  const clock = installClock({ start });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-scenario-'))), P = join(dir, 'workspace'), stateFile = join(dir, 'state', 'state.json');
  // Teardown is registered first, so a world that fails half-built still closes what it opened and restores the clock.
  const owned = { clients: [], app: null, fakes: [], previousEndpoint: process.env.TYPESAFE_ENDPOINT };
  t.after(async () => {
    for (const client of owned.clients) client.close();
    if (owned.app) await owned.app.close();
    await Promise.all(owned.fakes.map(fake => fake?.close()));
    if (owned.previousEndpoint === undefined) delete process.env.TYPESAFE_ENDPOINT; else process.env.TYPESAFE_ENDPOINT = owned.previousEndpoint;
    clock.uninstall();
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(P, { recursive: true });
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(P, path)), { recursive: true }); writeFileSync(join(P, path), content); }
  if (repo) { git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'scenario start'); }
  const faux = createFauxModel();
  // Unless a step says otherwise, the background decision waits (a valid decision, not a malformed reply).
  faux.on('initiative', request => decide(decisionInput(request), 'wait'));
  owned.fakes.push(faux);
  const [baseUrl, ov, jev] = await Promise.all([faux.listen(), createFakeOpenViking(), withJev ? createFakeJev() : null]);
  owned.fakes.push(ov, jev);
  if (jev) process.env.TYPESAFE_ENDPOINT = jev.endpoint; else delete process.env.TYPESAFE_ENDPOINT;
  const runtimeFactory = tag => options => createRnaRuntime({ ...options, provider: faux.provider(options.purpose ?? tag) });
  const app = createServer({ stateFile, ticks: false, runtimeFactory: runtimeFactory('foreground'), initiative,
    initiativeOptions: initiative ? { initialDelayMs: 0, tickIntervalMs: 50, independentLearning: true, runtimeFactory: runtimeFactory('background-work'), decisionProvider: faux.provider('initiative'), evolutionProvider: faux.provider('evolution'), narratorProvider: faux.provider('narrator'), mindProvider: mind ? faux.provider('mind') : null } : {},
    streamHub: { pollMs: 25, ...stream }, shutdownTimeoutMs: 10000, idleCompaction });
  owned.app = app;
  // New projects are not initialized by a model here (the initializer has its own suite).
  await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port, store = app.store;
  const provider = store.configurationService.provider(null, { name: 'Faux', protocol: 'openai', baseUrl, apiKey: 'scenario-synthetic-model-key', models: [{ id: 'faux-model', contextWindow: model.contextWindow ?? 64000, maxOutputTokens: model.maxOutputTokens ?? 2000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'faux-model', reasoning: 'off' }, memory: { endpoint: ov.endpoint, autoRecall: memory.autoRecall ?? false, autoStore: memory.autoStore ?? false } });
  const { permissions = { workspace: 'execute', background: 'inherit' }, ...createInput } = projectInput;
  const created = store.createProject({ name: 'Scenario project', description: 'A scenario project', workspace: P, rhythm: { control: 'manual' }, initiative: { enabled: initiative, cooldownMs: 0 }, ...createInput });
  store.mutate(state => {
    applyProjectPermissions(state, created.project.id, permissions);
    const row = state.projects.find(item => item.id === created.project.id);
    // A ready, real project (what initialization leaves behind), with the tools a scenario's model may call.
    Object.assign(row, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec'], mcpServerIds: [] } });
    row.initiative.tokenBudget = null; state.settings.realTokenBudget = null;
    // The judgment policy initialization leaves (authored by the main model; JEV only scores it).
    row.judgmentPolicy = prepareJudgmentPolicy(structuredClone(JUDGMENT_PLAN), { project: row, source: { kind: 'main_model', method: 'initialization', providerId: provider.id, modelId: 'faux-model', receiptId: 'scenario-initialization', createdAt: new Date().toISOString() } });
  });
  const clients = owned.clients;
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let value = null; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, body: value, bytes: Buffer.byteLength(text) };
  };
  const world = {
    t, dir, P, stateFile, port, app, store, clock, faux, ov, jev, provider,
    projectId: created.project.id, sessionId: created.session.id,
    project: (id = world.projectId) => store.state.projects.find(row => row.id === id) ?? null,
    session: (id = world.sessionId) => store.state.sessions.find(row => row.id === id) ?? null,
    get: path => request('GET', path), post: (path, body = {}) => request('POST', path, body), patch: (path, body = {}) => request('PATCH', path, body), del: (path, body = {}) => request('DELETE', path, body),
    getJson: path => getJson(port, path),
    /** An SSE client the world keeps and closes; its frames are part of every step's record. */
    async sse(path) { const client = await openSse(port, path); clients.push(client); return client; },
    async browser(options) { const tab = await openBrowser(port, options); clients.push(tab); return tab; },
    /** Lets the host idle `ms` of scenario time: the clock moves in `stepMs` jumps, each followed by real polls of the stream hub. */
    async idle(ms, { stepMs = 5000, settleMs = 80 } = {}) { for (let left = ms; left > 0; left -= stepMs) { clock.advance(Math.min(stepMs, left)); await delay(settleMs); } },
    /**
     * What the host's own timers would do on their next run, now (after the clock moved): memory sync's pump (the
     * runtime's 5 s timer), the initiative's schedule (its 50 ms tick here) and idle compaction's plan pass (its timer
     * for the earliest due conversation). Real timers keep running too.
     */
    tick() { try { app.executor?.memorySync?.pump(); } catch { /* a pump failure is the host's to report */ } app.projectInitiative?.schedule(); app.executor?.idleCompaction?.replan(); },
    /** Waits until the stream hub has sent what the last state change produced (its debounce timers ran), plus delivery. */
    async settle() { const hub = app.apiV2.hub; await until(() => !hub.indexTimer && !hub.sessionTimer, 'the stream hub to flush', 5000); await delay(40); },
    /** Waits until no foreground turn, hand-back or worktree apply of `sessionId` is in flight. */
    quiet: (sessionId = world.sessionId) => until(() => { const session = world.session(sessionId); return session && !session.activeTurnId && session.status !== 'running' && !app.executor?.running.has(sessionId) && !app.executor?.handBacks?.has(sessionId) && !app.sessionWorktrees?.queues?.has(sessionId); }, `conversation ${sessionId} to settle`),
    /** The `<state>.<suffix>` siblings beside the state file (suffix '' is the state file itself). */
    sidecars() { const name = basename(stateFile); return readdirSync(dirname(stateFile)).filter(entry => entry === name || entry.startsWith(`${name}.`)).map(entry => entry.slice(name.length)).sort(); },
    /** Entries of a sidecar directory (e.g. '.rna'), empty when it does not exist. */
    sidecarEntries: suffix => { const path = `${stateFile}${suffix}`; return existsSync(path) ? readdirSync(path).sort() : []; },
    file: path => existsSync(join(P, path)) ? readFileSync(join(P, path), 'utf8') : null,
    gitRefs() { if (!existsSync(join(P, '.git'))) return {}; const out = git(P, 'for-each-ref', '--format=%(refname) %(objectname)'); return Object.fromEntries(out.trim().split('\n').filter(Boolean).map(line => line.split(' '))); },
    /** Purpose-tagged usage receipts the host wrote (the usage ledger beside state). */
    usage() { const file = `${stateFile}.usage-cache.jsonl`; return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : []; },
    /** Unknown `<state>.<name>` siblings: each would block the next upgrade's checkpoint (checkpoint-sidecar-inventory). */
    unknownSidecars: () => world.sidecars().filter(suffix => suffix && !CHECKPOINT_SIDECARS.includes(suffix) && !excludedSibling(suffix)),
    /** Marks of every record the world keeps, for `since` (one step's share). */
    mark: () => ({ requests: faux.requests.length, ov: ov.calls.length, jev: jev?.calls.length ?? 0, frames: clients.map(client => (client.frames ?? client.streams?.flatMap(stream => stream.frames) ?? []).length), at: performance.now() }),
    since(mark) {
      const frames = clients.flatMap((client, index) => { const all = client.frames ?? client.streams.flatMap(stream => stream.frames); return all.slice(mark.frames[index] ?? 0); });
      return { requests: faux.requests.slice(mark.requests), ov: ov.calls.slice(mark.ov), jev: jev?.calls.slice(mark.jev) ?? [], frames };
    },
    clients,
    /** Every SSE frame any client of the world received so far. */
    frames: () => clients.flatMap(client => client.frames ?? client.streams.flatMap(stream => stream.frames)),
  };
  // JEV is configured the way a user configures it: the settings route stores the key (a synthetic one).
  if (jev) { const saved = await world.patch('/api/decision-kernel', { apiKey: SYNTHETIC_JEV_KEY }); if (saved.status !== 200) throw new Error(`scenario: JEV key was not accepted (${saved.status})`); }
  return world;
}
