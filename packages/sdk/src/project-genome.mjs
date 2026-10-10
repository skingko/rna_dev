import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateToolArguments } from './capabilities.mjs';
import { evolutionHash } from './evolution.mjs';
import { canonicalizeMissingPath } from './workspace-paths.mjs';
import { evaluationWorkspaceSchema, validateEvaluationWorkspace, workspaceFixtureSchema, validateWorkspaceFixture, prepareWorkspaceFixture, EVALUATION_WORKSPACE_TOOL_NAMES } from './project-evaluation-workspace.mjs';
import { compileGenomeScript, GENOME_READ_LIMIT_BYTES, GENOME_READ_BUDGET_BYTES } from './project-genome-script.mjs';
import { projectEvaluationClockSchema, validateProjectEvaluationClock } from './project-evaluation-contract.mjs';
import { evaluationDomainSchema, validateEvaluationDomain, evaluationDomainToolNames, EVALUATION_DOMAIN_TOOL_NAMES } from './project-evaluation-domains.mjs';
import { browserEvaluationEnvironmentSchema, validateBrowserEvaluationEnvironment } from './project-evaluation-browser.mjs';
import { projectSkillSourceSchema, validateMarketplaceSkillBytes } from './marketplace-genome-skills.mjs';

export { GENOME_READ_LIMIT_BYTES, GENOME_READ_BUDGET_BYTES };
const grouped = number => number.toLocaleString('en-US');
/** Shared generation contract. Keep this aligned with project-genome-worker (the read numbers are its own constants). */
export const PROJECT_GENOME_SCRIPT_API_CONTRACT = `Generated tool script API contract:
- script is an async JavaScript FUNCTION BODY with parameters input (the validated JSON arguments) and api. Return a JSON-serializable value. Pure calculations on input need no file API.
- Valid complete script value: "const doubled = input.value * 2; return { doubled };". Invalid script value: "async function(input, api) { return { doubled: input.value * 2 }; }". The host supplies the function wrapper; do not return a function declaration, arrow-function wrapper, export statement or Markdown fence as the script. This is a body, not a module or function value.
- await api.readFile(relativePath) returns the file's UTF-8 text as a STRING, not an object or a {content} wrapper. The file must exist and contain at most ${grouped(GENOME_READ_LIMIT_BYTES)} bytes (1 MiB), and one execution reads at most ${grouped(GENOME_READ_BUDGET_BYTES)} bytes in all; errors reject the call. For JSON files use JSON.parse(await api.readFile(path)).
- A rejected readFile says why in the start of its message: not_found: (no such file), denied: (a private path, outside the workspace, a symlink) or read_limit_exceeded: (the file, or the execution's total, is larger than a read may return). A rejected read tells you nothing about what the file says, so never turn one into a finding about it. In a check tool (a tool whose id starts with guard_: the host runs it on written files and reads the hits of its result), return { unchecked: [{ path, reason }] } (reason: the rejection message) next to your normal result for each file it could not read, and the host reports "could not check", not a violation. Any other tool keeps its own result shape: the host reads no unchecked field from it. Only not_found: can be a finding, and only when the rule itself requires that file to exist. Smoke fixture files stay under 64,000 bytes, so this case cannot be smoke-tested here: write the handling anyway.
- await api.writeFile(relativePath, text) accepts a UTF-8 string of at most 64,000 bytes and returns exactly {written:true}. It creates missing parent directories and overwrites the named file. Only tools declaring write or exec permission may call it; read permission always rejects writes.
- await api.listFiles(relativePath = '.') returns a sorted string[] of at most 100 allowed immediate child NAMES, including directory names. Entries are plain names, not objects, metadata or absolute paths. It does not recurse. Join child names to the relative directory yourself; no stat/exists API is available.
- All paths are workspace-relative. Absolute paths, escaping the workspace, symlinks, private paths (.env, .git, credentials and daemon data) and host-denied paths are unavailable. Directory listings omit inaccessible/private entries. File API calls reject with an Error on failure.
- At most 50 file API calls per execution, including failed calls; use bounded sequential work rather than unbounded recursion or concurrency. Return bounded JSON; the runner limits output and execution time.
- No imports, require, process, shell, network, environment variables, dependencies or timers are available. Declaring exec does not provide a shell API. Use only standard JavaScript and the three documented api methods; do not invent additional helpers.
- Smoke tests run in fresh temporary workspaces, empty unless that smoke case explicitly supplies workspace:{files:[{path:"data.txt",content:"example text"}]}. An input such as {"source":"data.txt"} does NOT create data.txt. For useful read-only file automation, provide explicit bounded fixture files in the smoke case; this does not grant the tool write permission. Alternatively supply text/data directly in input for a self-contained calculation. Frozen baseline smoke fixtures, inputs and expected outputs remain immutable. Baseline/candidate evaluation uses separate temporary workspaces seeded only by the frozen case's workspace.files, never the user's real project. Do not assume other files or external services exist.
- The host already provides project_read with line numbers and project_list for directory entries. Do not add a custom tool merely to rename or duplicate those operations. Prefer improving the skill's use of existing tools; a new automation needs a distinct, evidence-supported benefit.`;

const text = (maxLength = 8000) => ({ type: 'string', minLength: 1, maxLength });
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const texts = { type: 'array', maxItems: 30, uniqueItems: true, items: text(500) };
const caseProperties = { id, input: text(4000), requiredTerms: texts, forbiddenTerms: texts, requiredToolIds: { type: 'array', maxItems: 8, uniqueItems: true, items: id }, weight: { type: 'number', minimum: 0.1, maximum: 10 } };
const followUps = { type: 'array', minItems: 1, maxItems: 5, items: object({ input: text(4000), requiredTerms: texts, forbiddenTerms: texts, requiredToolIds: caseProperties.requiredToolIds, artifactChecks: evaluationWorkspaceSchema.properties.checks }, ['input']) };
// This is a declared frozen allowance, not model capacity. The evaluator clamps
// it to the selected model's configured ceiling before either side runs.
const execution = object({ maxSteps: { type: 'integer', minimum: 2, maximum: 32 }, maxOutputTokens: { type: 'integer', minimum: 256, maximum: Number.MAX_SAFE_INTEGER } });
export const projectGenomeSchema = object({
  schemaVersion: { const: 1 }, systemPrompt: text(16000),
  skills: { type: 'array', minItems: 1, maxItems: 12, items: object({ id, name: text(100), description: text(1000), instructions: text(64000), resources: { type: 'array', maxItems: 127, items: object({ path: text(400), content: { type: 'string', maxLength: 64000 } }) }, source: projectSkillSourceSchema }, ['id', 'name', 'description', 'instructions', 'resources']) },
  tools: { type: 'array', minItems: 0, maxItems: 8, items: object({ id, name: text(100), description: text(1000), permission: { enum: ['read', 'write', 'exec'] }, parameters: { type: 'object' }, script: text(16000), smokeCases: { type: 'array', minItems: 1, maxItems: 6, items: object({ input: { type: 'object' }, expected: true, workspace: workspaceFixtureSchema }, ['input', 'expected']) } }) },
  evaluationSuite: object({ version: text(100), criteria: { type: 'array', minItems: 1, maxItems: 8, items: object({ id, description: text(2000), weight: { type: 'number', minimum: 0.1, maximum: 10 } }) }, cases: { type: 'array', minItems: 3, maxItems: 12, items: object({ ...caseProperties, workspace: evaluationWorkspaceSchema, clock: projectEvaluationClockSchema, domain: evaluationDomainSchema, environment: browserEvaluationEnvironmentSchema, followUps, reviewConversation: { type: 'boolean' } }, Object.keys(caseProperties)) }, execution, thresholds: object({ minImprovement: { type: 'number', minimum: 0.01, maximum: 1 }, maxRegression: { type: 'number', minimum: 0, maximum: 0.2 }, minScore: { type: 'number', minimum: 0.5, maximum: 1 }, maxTokenRatio: { type: 'number', minimum: 1, maximum: 5 } }) }, ['version', 'criteria', 'cases', 'thresholds'])
});
export class ProjectGenomeError extends Error { constructor(message, code = 'invalid_genome') { super(message); this.name = 'ProjectGenomeError'; this.code = code; } }
export const projectGenomeHash = genome => evolutionHash(genome);
export const genomeToolName = (namespace, localId) => namespace ? `gen_${createHash('sha256').update(namespace).digest('hex').slice(0, 8)}_${localId}` : localId;
/**
 * Model-facing identity of a project's generated capabilities (EVO-3): stable across generations, so a generation that
 * keeps a tool keeps its name and the tools array (the cached request prefix) does not change. Which version runs is
 * pinned by the handle's bundle, never by the name. The storage identity (record.namespace, `<project>:<version>`) is
 * separate and unchanged.
 */
export const genomeNamespace = projectId => String(projectId);
export function validateProjectGenome(value) {
  try { validateToolArguments(projectGenomeSchema, value); } catch (failure) { throw new ProjectGenomeError(`Invalid project genome: ${failure.message}`); }
  if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new ProjectGenomeError('Project genome exceeds 3 MB');
  if (Buffer.byteLength(JSON.stringify({ ...value, skills: value.skills.filter(skill => !skill.source) })) > 384000) throw new ProjectGenomeError('Generated project content exceeds 384 KB');
  if (value.skills.filter(skill => !skill.source).length > 8) throw new ProjectGenomeError('Generated skills retain their eight-skill bound');
  for (const collection of [value.skills, value.tools, value.evaluationSuite.criteria, value.evaluationSuite.cases]) if (new Set(collection.map(item => item.id)).size !== collection.length) throw new ProjectGenomeError('Project genome IDs must be unique within each collection');
  for (const skill of value.skills) {
    if (!skill.source && (skill.instructions.length > 16000 || skill.resources.length > 12 || skill.resources.some(row => row.content.length > 32000))) throw new ProjectGenomeError('Generated skills retain their 16 KB instructions / 12 resource authoring bounds');
    try { validateMarketplaceSkillBytes(skill); } catch (error) { throw new ProjectGenomeError(error.message); }
    if (new Set(skill.resources.map(item => item.path)).size !== skill.resources.length) throw new ProjectGenomeError('Skill resource paths must be unique');
    for (const resource of skill.resources) if (!/^[A-Za-z0-9_.@+ -]+(?:\/[A-Za-z0-9_.@+ -]+)*$/.test(resource.path) || resource.path.split('/').some(part => ['.', '..', '.git', 'node_modules'].includes(part)) || resource.path === 'SKILL.md') throw new ProjectGenomeError('Skill resources require safe package-relative paths');
  }
  for (const tool of value.tools) {
    if (['skill_load', 'capability_install', 'capability_assign', 'capability_remove', 'agent_consult', 'agent_delegate', 'agent_status', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_merge', 'attachment_read', 'project_find', 'project_grep', 'project_history', 'marketplace_search', 'marketplace_read', 'marketplace_acquire', 'marketplace_skip', 'marketplace_plan', 'marketplace_reuse', ...EVALUATION_DOMAIN_TOOL_NAMES].includes(tool.id)) throw new ProjectGenomeError('Generated tool ID conflicts with a reserved tool');
    if (tool.parameters.type !== 'object') throw new ProjectGenomeError('Generated tool parameters must declare an object schema');
    for (const smoke of tool.smokeCases) try { validateToolArguments(tool.parameters, smoke.input); if (smoke.workspace) validateWorkspaceFixture(smoke.workspace); } catch (failure) { throw new ProjectGenomeError(`Invalid smoke input for ${tool.id}: ${failure.message}`); }
  }
  const normalized = structuredClone(value);
  for (const testCase of normalized.evaluationSuite.cases) {
    if (testCase.reviewConversation && !testCase.followUps?.length) throw new ProjectGenomeError('Conversation review requires explicit follow-up turns');
    try {
      if (testCase.domain) testCase.domain = validateEvaluationDomain(testCase.domain);
      if (testCase.environment) validateBrowserEvaluationEnvironment(testCase.environment);
      if (testCase.environment && testCase.domain) throw new Error('A case has one task environment');
      if ((testCase.environment || testCase.domain?.kind === 'research') && !testCase.workspace) throw new Error('Browser/research artifact evaluation requires an explicit workspace fixture');
    } catch (failure) { throw new ProjectGenomeError(failure.message); }
    try { validateProjectEvaluationClock(testCase.clock); } catch (failure) { throw new ProjectGenomeError(failure.message); }
    if (testCase.workspace) {
      try { validateEvaluationWorkspace(testCase.workspace); } catch (failure) { throw new ProjectGenomeError(failure.message); }
      if (value.tools.some(tool => EVALUATION_WORKSPACE_TOOL_NAMES.includes(tool.id))) throw new ProjectGenomeError('Workspace evaluation tools conflict with a generated tool ID; legacy suites without workspace fixtures remain supported');
    }
    for (const turn of [testCase, ...(testCase.followUps ?? [])]) {
      if ((turn.requiredToolIds ?? []).some(localId => localId !== 'skill_load' && !value.tools.some(tool => tool.id === localId) && !(testCase.workspace && EVALUATION_WORKSPACE_TOOL_NAMES.includes(localId)) && !evaluationDomainToolNames(testCase.domain).includes(localId))) throw new ProjectGenomeError('Evaluation cases may only require the host skill loader or available generated/workspace tools');
      if (turn.artifactChecks) {
        if (!testCase.workspace) throw new ProjectGenomeError('Follow-up artifact checks require an explicit workspace fixture');
        try { validateEvaluationWorkspace({ files: [], checks: turn.artifactChecks }); } catch (failure) { throw new ProjectGenomeError(failure.message); }
      }
    }
  }
  return normalized;
}

/** Restricted API runner, not an OS security sandbox. VM is not containment.
 * A fresh credential-free process and Node filesystem permissions add limits;
 * evaluation always passes an isolated temporary workspace, never the project.
 */
export async function runGenomeScript(tool, input, { workspace, signal, deniedPaths = [], timeoutMs = 3000, maxOutputBytes = 64000 } = {}) {
  signal?.throwIfAborted(); validateToolArguments(tool.parameters, input);
  try { compileGenomeScript(tool.script, input); } catch (failure) { throw Object.assign(new ProjectGenomeError(failure.message, failure.code), { phase: failure.phase, ...(failure.line ? { line: failure.line } : {}) }); }
  const root = await realpath(workspace), worker = fileURLToPath(new URL('./project-genome-worker.mjs', import.meta.url)), pathHelper = fileURLToPath(new URL('./workspace-paths.mjs', import.meta.url)), compiler = fileURLToPath(new URL('./project-genome-script.mjs', import.meta.url));
  const within = (base, path) => { const part = relative(base, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
  // Resolve deny identities in the host, which already owns these paths. The
  // restricted child does not need permission to inspect unrelated host state.
  // Ancestors deny the whole workspace; disjoint paths are outside its API.
  const canonicalDenied = await Promise.all(deniedPaths.map(canonicalizeMissingPath));
  const scopedDenied = [...new Set(canonicalDenied.flatMap(path => within(root, path) ? [path] : within(path, root) ? [root] : []))];
  if (signal?.aborted) throw new ProjectGenomeError('Generated script cancelled', 'aborted');
  return new Promise((done, reject) => {
    const args = ['--permission', `--allow-fs-read=${worker}`, `--allow-fs-read=${pathHelper}`, `--allow-fs-read=${compiler}`, `--allow-fs-read=${root}`, ...(tool.permission === 'read' ? [] : [`--allow-fs-write=${root}`]), '--max-old-space-size=64', worker];
    const child = spawn(process.execPath, args, { cwd: root, env: { PATH: dirname(process.execPath), LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', size = 0, failure;
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new ProjectGenomeError('Generated script cancelled', 'aborted'));
    const timer = setTimeout(() => stop(new ProjectGenomeError('Generated script exceeded its time limit', 'script_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.on('error', () => { failure ??= new ProjectGenomeError('Generated script process could not start', 'script_failed'); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxOutputBytes) stop(new ProjectGenomeError('Generated script output exceeded its bound', 'output_limit')); else output += chunk; });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1000); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ProjectGenomeError(`Generated script process failed (${code})`, 'script_failed'));
      let result; try { result = JSON.parse(output); } catch { return reject(new ProjectGenomeError('Generated script did not return bounded JSON', 'invalid_output')); }
      if (!result.ok) return reject(Object.assign(new ProjectGenomeError(result.error || 'Generated script failed', result.code || 'script_failed'), { phase: result.phase, ...(result.line ? { line: result.line } : {}) }));
      done({ value: result.value, effects: result.effects, execution: 'node-restricted-api', diagnostics });
    });
    child.stdin.end(JSON.stringify({ script: tool.script, input, workspace: root, permission: tool.permission, deniedPaths: scopedDenied }));
  });
}

export function createGenomeTools(genome, { namespace, workspace, signal: lifecycleSignal, deniedPaths = [] } = {}) {
  const validated = validateProjectGenome(genome);
  return validated.tools.map(tool => ({ id: genomeToolName(namespace, tool.id), name: genomeToolName(namespace, tool.id), label: tool.name, description: tool.description, localId: tool.id, parameters: tool.parameters, enabled: true, trusted: true, permission: tool.permission, effect: tool.permission === 'read' ? 'read' : 'write', idempotent: tool.permission === 'read',
    async execute(_callId, input, signal) {
      const combined = signal && lifecycleSignal ? AbortSignal.any([signal, lifecycleSignal]) : signal || lifecycleSignal;
      try { const result = await runGenomeScript(tool, input, { workspace, signal: combined, deniedPaths }); return { content: [{ type: 'text', text: JSON.stringify(result.value) }], details: { effects: result.effects, localId: tool.id } }; }
      catch (failure) { if (combined?.aborted) throw failure; return { isError: true, content: [{ type: 'text', text: failure.message }], details: { code: failure.code, ...(failure.phase ? { phase: failure.phase } : {}), ...(failure.line ? { line: failure.line } : {}) } }; }
    }
  }));
}

export async function smokeProjectGenome(genome, { signal } = {}) {
  const valid = validateProjectGenome(genome), results = [];
  for (const tool of valid.tools) for (let index = 0; index < tool.smokeCases.length; index++) {
    signal?.throwIfAborted(); const workspace = await mkdtemp(join(tmpdir(), 'rna-genome-smoke-'));
    try { const input = tool.smokeCases[index]; if (input.workspace) await prepareWorkspaceFixture(workspace, input.workspace, signal); const output = await runGenomeScript(tool, input.input, { workspace, signal }); results.push({ toolId: tool.id, case: index, passed: evolutionHash(output.value) === evolutionHash(input.expected), expected: input.expected, actual: output.value, effects: output.effects, ...(input.workspace ? { fixtureHash: evolutionHash(input.workspace) } : {}) }); }
    catch (failure) { if (signal?.aborted) throw failure; results.push({ toolId: tool.id, case: index, passed: false, error: failure.message, code: failure.code, ...(failure.phase ? { phase: failure.phase } : {}), ...(failure.line ? { line: failure.line } : {}) }); }
    finally { await rm(workspace, { recursive: true, force: true }); }
  }
  return { passed: results.every(result => result.passed), results, executed: results.length > 0, applicable: valid.tools.length > 0, runner: 'node-restricted-api' };
}
