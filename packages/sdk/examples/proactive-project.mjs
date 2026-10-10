#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import {
  bootstrapProject, CapabilityRegistry, createWorkspaceTools, createSession,
  InitiativeCoordinator, EvolutionCoordinator, streamCompletion, buildRequest,
} from '../src/index.mjs';
import { createGenomeTools } from '../src/project-genome.mjs';

const HELP = `Rna Agent SDK: 无需 Goal 的项目主动协作示例（会产生真实模型请求）

用法:
  node packages/sdk/examples/proactive-project.mjs --model ./model.json \\
    --title "离线备份工具" --description "给独立开发者设计可验证、可恢复的备份流程"

必填:
  --model FILE           用户提供的模型 JSON，包含 model 对象和 apiKeyEnv
  --title TEXT           项目标题
  --description TEXT     项目介绍；这是初始化资料，不需要设定 Goal

可选:
  --api-key-env NAME     覆盖 JSON 中的 apiKeyEnv；密钥只从该环境变量读取
  --workspace PATH       只读研究目录，默认当前目录
  --state-dir PATH       保存本次状态/会话的父目录，默认 .rna-sdk-example
  --ticks N              主动判断调度次数，默认 4（1–100）
  --interval-ms N        调度间隔，默认 1000（100–60000）
  --max-requests N       全流程模型请求硬上限，默认 12（1–100）
  --token-budget N       全流程 token 预算，默认 75000；未报告用量保守预扣
  --interactive          将终端输入作为新观察，并插入正在进行的只读研究
  --jsonl                逐行输出结构化事件，包含 chat_message 主动发言
  --evolve               启用函数评测示例；真实测试标签归一化函数，不代表模型质量收益
  --evaluator FILE       启用用户指定的真实宿主评测模块，隐含 --evolve
  --help                 显示帮助，不读取配置或凭据、不请求模型

model.json（不要把 API key 写入文件）:
  { "apiKeyEnv": "RNA_MODEL_API_KEY", "model": {
      "providerId": "configured", "protocol": "openai",
      "baseUrl": "https://your-provider.example/v1", "modelId": "your-model-id",
      "contextWindow": 32000, "maxOutputTokens": 4096, "reasoning": "off"
  } }

初始化、判断和研究均调用实际模型；无配置/环境变量密钥时退出码 2。
模型也可以决定等待，示例不会强行编造主动消息或生成假评测结果。
Ctrl+C 会取消请求并关闭会话、主动循环、评测器和能力 Registry。
详细说明及自定义 evaluator 契约见同目录 README.md。
`;
function argsOf(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const flags = new Set(['evolve', 'interactive', 'jsonl']), values = new Set(['model', 'title', 'description', 'api-key-env', 'workspace', 'state-dir', 'ticks', 'interval-ms', 'max-requests', 'token-budget', 'evaluator']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !flags.has(key) && !values.has(key)) throw new Error(`未知参数：${argv[i]}`);
    if (flags.has(key)) args[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} 需要一个值`); args[key] = argv[++i]; }
  }
  for (const key of ['model', 'title', 'description']) if (!args[key]?.trim()) throw new Error(`缺少 --${key}；运行 --help 查看用法。未调用模型。`);
  for (const [key, fallback, min, max] of [['ticks', 4, 1, 100], ['interval-ms', 1000, 100, 60000], ['max-requests', 12, 1, 100], ['token-budget', 75000, 1000, 10000000]]) {
    args[key] = args[key] === undefined ? fallback : Number(args[key]); if (!Number.isInteger(args[key]) || args[key] < min || args[key] > max) throw new Error(`--${key} 必须是 ${min}–${max} 的整数`);
  }
  return args;
}
async function jsonFile(path) {
  let raw; try { const info = await stat(path); if (!info.isFile() || info.size > 256000) throw new Error(); raw = await readFile(path, 'utf8'); } catch { throw Object.assign(new Error('无法读取指定配置文件，或文件超过 256 KiB；未调用模型。'), { code: 'configuration' }); }
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('指定配置不是有效 JSON；未调用模型。'), { code: 'configuration' }); }
}
async function atomicJson(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
function sampleEvaluator() {
  // Actual deterministic function tests. This intentionally makes NO claim about LLM quality.
  return {
    evaluatorId: 'example-tag-normalizer@1', label: '标签归一化函数评测；候选由宿主提供，不是模型质量评测',
    baseline: { versionId: 'normalizer-v1', strategy: JSON.stringify({ normalize: [] }), skills: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [] } },
    cases: [{ id: 'lowercase', input: 'alpha', expected: 'alpha' }, { id: 'spaces', input: ' beta ', expected: 'beta' }, { id: 'case', input: 'GAMMA', expected: 'gamma' }],
    propose: async () => ({ proposal: { summary: '规范化标签输入', hypothesis: '去掉边缘空格并统一大小写可以修复已观察到的匹配问题', strategy: JSON.stringify({ normalize: ['trim', 'lowercase'] }), skillUpdates: [], expectedImprovement: '修复空格和大小写匹配案例', riskNotes: ['该案例不能证明 Agent 推理能力提升；真实业务可能区分大小写'] }, usage: { totalTokens: 0 } }),
    evaluate: async ({ version, testCase, signal }) => {
      signal.throwIfAborted(); let config; try { config = JSON.parse(version.strategy); } catch { config = {}; }
      const allowed = Array.isArray(config.normalize) && config.normalize.every(step => ['trim', 'lowercase'].includes(step));
      let actual = testCase.input;
      if (allowed) for (const step of config.normalize) actual = step === 'trim' ? actual.trim() : actual.toLowerCase();
      const passed = allowed && actual === testCase.expected;
      return { score: passed ? 1 : 0, passed, safetyPassed: allowed, evidence: { input: testCase.input, actual, expected: testCase.expected, assertion: 'strict equality' }, usage: { totalTokens: 0 } };
    },
  };
}

let options;
try { options = argsOf(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
if (options?.help) process.stdout.write(HELP);
else if (options) {
  try { await main(options); } catch (error) { process.stderr.write(`${error.message || '示例运行失败'}\n`); process.exitCode = error.name === 'AbortError' || error.code === 'aborted' ? 130 : error.code === 'configuration' ? 2 : 1; }
}

async function main(args) {
  const modelPath = resolve(args.model), input = await jsonFile(modelPath), model = input.model;
  if (!model || typeof model !== 'object' || input.apiKey || model.apiKey || !model.providerId) throw Object.assign(new Error('配置须包含 model.providerId 等模型字段和 apiKeyEnv；禁止内联 API key。未调用模型。'), { code: 'configuration' });
  buildRequest({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Validate configuration only' }] }] }); // Pure validation; no network.
  const keyName = args['api-key-env'] || input.apiKeyEnv;
  if (typeof keyName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName) || !process.env[keyName]?.trim()) throw Object.assign(new Error('未找到 apiKeyEnv 指定的真实模型凭据。退出，未生成项目或模拟结果。'), { code: 'configuration' });
  const apiKey = process.env[keyName], workspace = await realpath(resolve(args.workspace || process.cwd()));
  const safe = value => JSON.stringify(value).split(apiKey).join('[REDACTED]');
  const emit = event => {
    if (args.jsonl) { process.stdout.write(`${safe(event)}\n`); return; }
    const labels = { project_initialized: '模型初始化', initiative_decision: '主动判断', chat_message: '主动消息', research_started: '后台研究', research_completed: '研究完成', initiative_action_failed: '后台任务失败', initiative_decision_discarded: '观察已更新', evolution_candidate_ready: '候选可试用', run_complete: '结束', observation: '观察', evolution_scope: '评测范围', error: '错误' };
    if (event.type === 'research_delta') { process.stdout.write(String(event.delta).split(apiKey).join('[REDACTED]')); return; }
    if (event.type === 'research_completed') process.stdout.write('\n');
    if (labels[event.type]) process.stdout.write(`[${labels[event.type]}] ${String(event.text || event.summary || (event.decision ? `${event.decision.action} — ${event.decision.reason}` : undefined) || event.type).split(apiKey).join('[REDACTED]')}\n`);
  };
  const runId = randomUUID(), projectId = `example-${runId}`, stateBase = resolve(args['state-dir'] || '.rna-sdk-example'), stateDir = join(stateBase, runId);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const controller = new AbortController(), sessions = new Set(); let registry, initiative, evolution, terminal;
  let requests = 0, accountedTokens = 0, measuredTokens = 0, unknownUsageRequests = 0, reservedTokens = 0;
  const stop = () => controller.abort(new DOMException('Stopped by user', 'AbortError'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const provider = async function* (request) {
    if (requests >= args['max-requests']) throw new Error('已达到本例 --max-requests 上限');
    const reserve = Buffer.byteLength(JSON.stringify({ system: request.systemPrompt, messages: request.messages, tools: request.tools })) + request.model.maxOutputTokens + 512;
    if (reserve > args['token-budget'] - accountedTokens - reservedTokens) throw new Error('剩余 token 预算不足以预留下一次请求；已停止追加模型调用');
    requests++; reservedTokens += reserve; let reported = null;
    try { for await (const event of streamCompletion(request)) { if (event.type === 'usage') reported = Math.max(reported || 0, Number(event.usage?.totalTokens) || 0); yield event; } }
    finally { reservedTokens -= reserve; if (reported === null) unknownUsageRequests++; else measuredTokens += reported; accountedTokens += reported ?? reserve; }
  };
  try {
    const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url));
    registry = new CapabilityRegistry({
      skills: ['project-analysis', 'research'].map(id => ({ id, path: join(skillRoot, id, 'SKILL.md'), enabled: true, trusted: true })),
      tools: await createWorkspaceTools(workspace, { deniedPaths: [stateBase, modelPath, ...(args.evaluator ? [resolve(args.evaluator)] : [])] }),
    });
    const initial = await bootstrapProject({ title: args.title, description: args.description, catalog: await registry.catalog(), model, apiKey, provider, signal: controller.signal });
    if (initial.status !== 'ready') throw new Error(`项目初始化受阻：${initial.reason}`);
    const genomeDir = join(stateDir, 'genome'); await mkdir(genomeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(genomeDir, 'SYSTEM.md'), initial.genome.systemPrompt, { mode: 0o600 }); await atomicJson(join(genomeDir, 'evaluation.json'), initial.genome.evaluationSuite); await atomicJson(join(genomeDir, 'genome.json'), initial.genome);
    const generatedSkillIds = [];
    for (const skill of initial.genome.skills) {
      const directory = join(genomeDir, 'skills', skill.id); await mkdir(directory, { recursive: true, mode: 0o700 }); const id = `generated-${skill.id}`, path = join(directory, 'SKILL.md');
      await writeFile(path, `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`, { mode: 0o600 });
      for (const resource of skill.resources) { const target = join(directory, resource.path); await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 }); await writeFile(target, resource.content, { mode: 0o600 }); }
      registry.registerSkill({ id, name: skill.name, description: skill.description, path, enabled: true, trusted: true }); generatedSkillIds.push(id);
    }
    await mkdir(join(genomeDir, 'tools'), { recursive: true, mode: 0o700 }); for (const tool of initial.genome.tools) await writeFile(join(genomeDir, 'tools', `${tool.id}.mjs`), `export default async function(input, api) {\n${tool.script}\n}\n`, { mode: 0o600 });
    const generatedTools = createGenomeTools(initial.genome, { namespace: projectId, workspace, signal: controller.signal, deniedPaths: [stateBase, modelPath] }).filter(tool => tool.permission === 'read');
    for (const tool of generatedTools) registry.registerTool(tool);
    await atomicJson(join(stateDir, 'project.json'), { id: projectId, title: args.title, description: args.description, initial });
    const assignments = { ...initial.assignments, skillIds: [...initial.assignments.skillIds, ...generatedSkillIds], toolIds: [...initial.assignments.toolIds, ...generatedTools.map(tool => tool.id)] };
    const assigned = await registry.resolve(assignments), project = { id: projectId, title: args.title, description: args.description, overview: initial.overview, focus: initial.focus, facts: initial.facts, openQuestions: initial.openQuestions };
    emit({ type: 'project_initialized', projectId, text: `${initial.overview}\n当前关注：${initial.focus}\n模型生成了 ${initial.genome.skills.length} 项项目技能、${initial.genome.tools.length} 个工具和可编辑评估标准；工具冒烟校验已实际通过。\n技能：${assignments.skillIds.join(', ')}；只读工具：${assigned.tools.map(tool => tool.name).join(', ') || '无'}`, assignments });
    const readyEvents = [];
    if (args.evolve || args.evaluator) {
      const config = args.evaluator ? await import(pathToFileURL(resolve(args.evaluator)).href) : sampleEvaluator();
      if (!config.baseline || !Array.isArray(config.cases) || typeof config.evaluate !== 'function' || typeof config.evaluatorId !== 'string') throw new Error('evaluator 模块须导出 baseline、cases、evaluate 和 evaluatorId');
      for (const field of ['skillIds', 'toolIds', 'mcpServerIds']) if ((config.baseline.assignments?.[field] || []).some(id => !initial.assignments[field].includes(id))) throw new Error('evaluator baseline 不得添加项目未分配的能力');
      emit({ type: 'evolution_scope', text: config.label || '用户指定的领域评测器；质量结论仅覆盖其提供的案例' });
      evolution = new EvolutionCoordinator({ project, baseline: config.baseline, cases: config.cases, evaluatorId: config.evaluatorId, evaluate: config.evaluate, propose: config.propose, model, apiKey, provider, policy: { tokenBudget: Math.min(args['token-budget'], 24000), minCases: 3 }, saveState: state => atomicJson(join(stateDir, 'evolution.json'), state), onEvent: event => { readyEvents.push(event); emit(event); } });
    }
    const handlers = {
      work: async (action, context) => {
        context.signal.throwIfAborted(); emit({ type: 'research_started', text: action.content });
        let workCharged = 0;
        const researchProvider = async function* (request) {
          const reserve = Buffer.byteLength(JSON.stringify({ system: request.systemPrompt, messages: request.messages, tools: request.tools })) + request.model.maxOutputTokens + 512;
          if (reserve > context.tokenBudget - workCharged) throw new Error('本次后台研究预算不足，已停止追加请求');
          let reported = null;
          try { for await (const event of provider(request)) { if (event.type === 'usage') reported = Math.max(reported || 0, Number(event.usage?.totalTokens) || 0); yield event; } }
          finally { workCharged += reported ?? reserve; }
        };
        const session = await createSession({ sessionId: `work-${action.id}`, projectId, cwd: workspace, stateDir: join(stateDir, 'sessions'), model: { ...model, maxOutputTokens: Math.min(model.maxOutputTokens, 2048) }, apiKey, provider: researchProvider, tools: assigned.tools.filter(tool => tool.permission === 'read'), maxSteps: 3,
          systemPrompt: `你是 Rna Agent 的项目协作者，只进行有证据的只读研究。当前项目：${JSON.stringify(project)}。只使用当前分配的只读工具，缺失能力如实说明；不修改文件或执行命令。研究完成后给出简短、可核查的发现，供主对话判断是否值得主动告诉用户。\n项目系统说明：\n${initial.genome.systemPrompt}\n${assigned.skills.map(skill => `## ${skill.name}\n${skill.instructions}`).join('\n\n')}`,
          onEvent: event => { if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') emit({ type: 'research_delta', delta: event.assistantMessageEvent.delta }); },
        });
        sessions.add(session); const abort = () => { void session.abort().catch(() => {}); }; context.signal.addEventListener('abort', abort, { once: true });
        try {
          context.signal.throwIfAborted(); await session.observe(`项目事件触发的研究意图：${action.content}\n引用证据：${JSON.stringify(context.evidence)}`, { wake: false }); await session.resume();
          const snapshot = session.snapshot(), last = snapshot.messages.filter(message => message.role === 'assistant').at(-1);
          if (!last || ['error', 'aborted'].includes(last.stopReason)) throw new Error('只读研究未完整结束');
          const summary = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          emit({ type: 'research_completed', text: summary, usage: snapshot.usage }); return { summary, usage: snapshot.usage };
        } finally { context.signal.removeEventListener('abort', abort); await session.dispose(); sessions.delete(session); }
      },
      share: async action => { emit({ type: 'chat_message', role: 'assistant', proactive: true, text: action.content, evidenceIds: action.evidenceIds, actionId: action.id }); return { summary: '主动消息已输出到本机聊天事件流', usage: { totalTokens: 0 } }; },
    };
    if (evolution) handlers.learn = async (action, context) => {
      const before = evolution.snapshot().usedTokens;
      const candidate = await evolution.runCycle({ evidence: context.evidence, signal: context.signal });
      return { summary: candidate.status === 'ready' ? `候选 ${candidate.id} 在指定函数/领域案例中通过评测，可以提醒用户试用；没有自动更新当前版本。` : `进化结果：${candidate.status}${candidate.reason ? ` (${candidate.reason})` : ''}`, usage: { totalTokens: Math.max(0, evolution.snapshot().usedTokens - before) } };
    };
    initiative = new InitiativeCoordinator({ project, model, apiKey, provider, handlers, policy: { tokenBudget: args['token-budget'], decisionMaxTokens: 2048, workBudgetTokens: 24000, maxConcurrent: 1, cooldownMs: 10000 }, saveState: state => atomicJson(join(stateDir, 'initiative.json'), state), onEvent: emit });
    await initiative.observe({ id: `project-opened:${runId}`, type: 'project_opened', summary: `用户刚创建项目，尚未下达具体任务。标题：${args.title}。介绍：${args.description}。AI 初始化的关注点：${initial.focus}。请根据实际状态判断是否值得只读研究、主动交流或等待。` });
    if (evolution) await initiative.observe({ id: `evaluation-available:${runId}`, type: 'evaluation_available', summary: args.evaluator ? '用户已显式配置领域评测器，允许根据项目证据提出并验证候选版本；激活仍由宿主明确决定。' : '用户显式启用了标签归一化函数评测示例：当前函数原样返回输入，三个固定案例中，边缘空格与大写输入不能匹配期望值。可以学习并评测候选，但收益只代表该函数案例，不代表模型质量。' });
    if (args.interactive) {
      terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && !args.jsonl) });
      terminal.on('SIGINT', stop);
      terminal.on('line', text => { if (!text.trim()) return; void (async () => { await initiative.observe({ id: `user:${randomUUID()}`, type: 'user_message', summary: text }); for (const session of sessions) await session.steer(text); emit({ type: 'observation', text: '已接收新输入；正在研究时会在安全边界插入。' }); })().catch(error => emit({ type: 'error', text: error.message })); });
    }
    let completedTicks = 0;
    for (let tick = 0; tick < args.ticks; tick++) {
      controller.signal.throwIfAborted();
      for (const event of readyEvents.splice(0)) await initiative.observe(event);
      const result = await initiative.tick({ presence: { typing: false, activeTurn: false }, signal: controller.signal });
      await initiative.idle(); completedTicks++;
      if (result.status === 'blocked') { emit({ type: 'error', text: `主动调度受阻：${result.reason}` }); break; }
      if (tick + 1 < args.ticks) await delay(args['interval-ms'], undefined, { signal: controller.signal });
    }
    emit({ type: 'run_complete', text: `已完成 ${completedTicks} 次调度；实际模型请求 ${requests} 次，已报告 ${measuredTokens} tokens。状态保存在 ${stateDir}。`, requests, measuredTokens, unknownUsageRequests, accountedTokens, stateDir });
  } finally {
    controller.abort(); terminal?.close();
    await Promise.allSettled([...sessions].map(session => session.abort()).concat([initiative?.close(), evolution?.close()]));
    await Promise.allSettled([...sessions].map(session => session.dispose()).concat([registry?.close()]));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
