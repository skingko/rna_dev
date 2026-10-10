import { McpSessionPool, mcpFingerprint } from './mcp-session-pool.mjs';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { CapabilityRegistry, createWorkspaceTools } from '../../packages/sdk/src/index.mjs';
import { stateConfinement } from './state-privacy.mjs';
import { runCapabilityProcess } from '../../packages/sdk/src/capability-installation.mjs';
import { coreMethodSkills } from '../../packages/sdk/src/core-method-skills.mjs';
import { McpClient } from '../../packages/sdk/src/mcp.mjs';
import { currentBrowserGrants, normalizeBrowserMetadata } from './browser-capability-presets.mjs';
import { BrowserMcpSessions } from './browser-mcp-sessions.mjs';
import { WebToolsService } from './web-tools-service.mjs';
import { WORKTREE_DIR } from './git-isolation/contract.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';

const sdk = resolve(import.meta.dirname, '../../packages/sdk');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) fail('能力 ID 格式无效'); return value; };
const text = (value, max = 2000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('能力字段必须为有效文本'); return value.trim(); };
export const builtinSkills = () => [
  ['project-analysis', '项目分析', '根据证据理解项目目标、约束与结构，明确待确认的决策。'],
  ['code-review', '代码审查', '检查可复现的代码问题，说明证据、影响与修正建议。'],
  ['research', '资料研究', '比较原始资料、保留来源，并标明结论中的不确定性。'],
  ['browser-verification', '网页交互与视觉验证', '实际启动项目预览，使用浏览器快照交互、截图读屏，并分别核对功能、错误和视觉品质。']
].map(([id, name, description]) => ({ id, name, description, path: resolve(sdk, 'skills', id, 'SKILL.md'), enabled: true, trusted: true, builtin: true })).concat(coreMethodSkills());
export function projectWorkspace(value) {
  if (isAbsolute(value)) return value;
  const root = resolve(import.meta.dirname, '../..');
  if (value === 'Pi_agent') return root;
  return existsSync(resolve(root, value)) ? resolve(root, value) : resolve(value);
}
/**
 * The project folder P around an isolated root, resolved: the sandbox denies it (the root itself stays writable). An
 * isolated root always lies inside P (`<P>/.rna/worktrees.nosync/…`); anything else is refused rather than run with
 * a sandbox that would not cover P.
 */
export function isolatedProjectFolder(project, root, say = variants => variants.zh) {
  let folder, real;
  try { folder = realpathSync(projectWorkspace(project.workspace)); real = realpathSync(root); }
  catch { throw Object.assign(new Error(say({ zh: '项目文件夹或工作树找不到了。', en: 'The project folder or its worktree can’t be found.' })), { status: 409, code: 'worktree_missing' }); }
  const part = relative(folder, real);
  if (isAbsolute(part) || !`${part}${sep}`.startsWith(`${WORKTREE_DIR.split('/').join(sep)}${sep}`) || part.split(sep).length < 3) throw Object.assign(new Error(say({ zh: '这个工作目录不是项目的 Rna 工作树。', en: 'This folder isn’t one of the project’s Rna worktrees.' })), { status: 403, code: 'root_denied' });
  return folder;
}
export class CapabilityService {
  /** `daemonPort`: the port of Rna's own local API (a function, read when a registry is built), which sandboxed commands cannot connect to. */
  constructor(store, { workspaceInspection, browserOptions = {}, webOptions = {}, daemonPort = () => undefined } = {}) { this.store = store; this.workspaceInspection = workspaceInspection; this.browserOptions = browserOptions; this.webTools = new WebToolsService(store, webOptions); this.daemonPort = daemonPort; }
  globalTools() { return this.webTools.tools(); }
  globalToolsRevision() { return this.webTools.revision(); }
  browserPool() { this.browsers ??= new BrowserMcpSessions(this.store, this.browserOptions); return this.browsers; }
  /** MCP connections that live with a conversation (mcp-session-pool.mjs). */
  mcpPool() { this.mcpSessions ??= new McpSessionPool(); return this.mcpSessions; }
  browserState(projectId, sessionId) { return this.browsers?.status(projectId, sessionId) ?? []; }
  async drainSession(sessionId) { await Promise.allSettled([this.browsers?.drainSession(sessionId), this.mcpSessions?.drainSession(sessionId)]); }
  async close() { this.webTools.close(); await Promise.allSettled([this.browsers?.close(), this.mcpSessions?.close()]); }
  /** MCP server settings as a turn uses them (browser grants, stdio environment). */
  mcpManifests(config = this.configuration()) { return config.mcpServers.map(server => ({ ...server, ...(server.browser ? { allowTools: currentBrowserGrants(server.allowTools) } : {}), ...(server.transport === 'stdio' ? { env: this.environment(server) } : {}) })); }
  /** While the user types in a conversation, start its assigned MCP servers so the turn does not wait for them. */
  async prewarm(project, sessionId) {
    if (!project || !sessionId) return 0;
    const ids = new Set(project.assignments?.mcpServerIds ?? []);
    const servers = this.mcpManifests().filter(server => ids.has(server.id) && server.enabled && server.trusted && !server.browser);
    const warmed = await Promise.all(servers.map(server => this.mcpPool().warm(server, { projectId: project.id, sessionId })));
    return warmed.filter(Boolean).length;
  }
  configuration() {
    const saved = this.store.state.capabilities ?? {};
    // A skill installed into a project's genome lives under <state>.genomes/<projectId>/; once that project is deleted
    // its files go with it, so its entries are no longer offered anywhere.
    const genomes = `${resolve(`${this.store.file}.genomes`)}${sep}`, projects = new Set(this.store.state.projects.map(row => row.id));
    const orphan = skill => typeof skill?.path === 'string' && resolve(skill.path).startsWith(genomes) && !projects.has(resolve(skill.path).slice(genomes.length).split(sep)[0]);
    const skills = (saved.skills ?? []).filter(skill => !orphan(skill));
    // New host method packages are available to existing installations too.
    // An explicit saved disable/trust setting always wins over defaults.
    for (const skill of builtinSkills()) if (!skills.some(row => row.id === skill.id)) skills.push(skill);
    return { tools: [], mcpServers: [], revision: 0, installations: [], ...saved, skills };
  }
  revision() { return this.configuration().revision ?? 0; }
  public() { return structuredClone(this.configuration()); }
  normalize(kind, input) {
    const manifest = { id: id(input.id), name: text(input.name ?? input.id, 160), description: text(input.description ?? input.name ?? input.id, 2000), enabled: input.enabled === true, trusted: input.trusted === true };
    if (typeof input.enabled !== 'boolean' || typeof input.trusted !== 'boolean') fail('注册时必须明确 enabled 与 trusted');
    if (input.installationId) manifest.installationId = id(input.installationId);
    if (kind === 'skills') {
      manifest.path = text(input.path, 2000); if (!isAbsolute(manifest.path)) fail('技能路径必须为绝对路径');
    } else if (kind === 'mcpServers' || kind === 'tools') {
      if (kind === 'tools') {
        if (input.protocol !== 'json-stdin') fail('命令工具必须采用 json-stdin 协议');
        if (!['read', 'write', 'exec'].includes(input.permission)) fail('工具必须声明 read/write/exec 权限');
        manifest.protocol = 'json-stdin'; manifest.permission = input.permission; manifest.idempotent = input.idempotent === true;
        manifest.toolName = text(input.toolName ?? input.id, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(manifest.toolName)) fail('工具名称格式无效');
        manifest.parameters = structuredClone(input.parameters ?? { type: 'object', additionalProperties: true });
        new CapabilityRegistry({ tools: [{ ...manifest, name: manifest.toolName, execute() {} }] });
        manifest.timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 300000 ? input.timeoutMs : 30000;
      } else {
      if (!['http', 'stdio'].includes(input.transport)) fail('MCP 传输必须为 http 或 stdio');
      manifest.transport = input.transport; manifest.allowTools = input.allowTools ?? {};
      manifest.allowToolsSpecified = input.allowToolsSpecified ?? Object.hasOwn(input, 'allowTools');
      if (!manifest.allowTools || typeof manifest.allowTools !== 'object' || Array.isArray(manifest.allowTools)) fail('allowTools 必须声明工具名称及权限');
      for (const rule of Object.values(manifest.allowTools)) if (!rule || !['read', 'write', 'exec'].includes(rule.permission)) fail('每个 MCP 工具必须声明 read/write/exec 权限');
      if (input.browser) manifest.browser = normalizeBrowserMetadata(input);
      }
      if (input.headers || input.env || input.apiKey) fail('MCP 凭据请使用 headerEnv/envNames 引用，不能写入普通配置');
      if (kind === 'mcpServers' && input.transport === 'http') {
        let url; try { url = new URL(input.url); } catch { fail('MCP 服务地址无效'); }
        if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('MCP 地址需 HTTPS 或本机 HTTP，不得包含凭据和查询参数');
        manifest.url = url.href; manifest.headerEnv = input.headerEnv ?? {};
        if (typeof manifest.headerEnv !== 'object' || Array.isArray(manifest.headerEnv) || Object.entries(manifest.headerEnv).some(([key, value]) => !/^[A-Za-z0-9-]{1,100}$/.test(key) || typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value))) fail('MCP headerEnv 格式无效');
      } else {
        manifest.command = text(input.command); if (!isAbsolute(manifest.command)) fail('MCP 命令必须为绝对路径');
        manifest.args = input.args ?? []; if (!Array.isArray(manifest.args) || manifest.args.length > 100 || manifest.args.some(arg => typeof arg !== 'string' || arg.length > 4000)) fail('MCP args 格式无效');
        manifest.cwd = input.cwd ? text(input.cwd) : process.cwd(); if (!isAbsolute(manifest.cwd)) fail('MCP cwd 必须为绝对路径');
        manifest.envNames = input.envNames ?? []; if (!Array.isArray(manifest.envNames) || manifest.envNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(name))) fail('MCP envNames 格式无效');
        manifest.envMapping = input.envMapping ?? {}; if (!manifest.envMapping || typeof manifest.envMapping !== 'object' || Array.isArray(manifest.envMapping) || Object.entries(manifest.envMapping).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(key) || typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value))) fail('envMapping 必须为环境变量名称映射');
      }
    } else fail('未知能力类型');
    return manifest;
  }
  register(kind, input) {
    const manifest = this.normalize(kind, input);
    if (kind === 'skills' && builtinSkills().some(skill => skill.id === manifest.id)) fail('内置技能不能被覆盖', 409);
    return this.store.mutate(state => {
      state.capabilities ??= { skills: builtinSkills(), tools: [], mcpServers: [] };
      state.capabilities[kind] ??= [];
      const current = state.capabilities[kind].findIndex(item => item.id === manifest.id);
      if (current >= 0 && state.capabilities[kind][current].builtin) fail('内置技能不能被覆盖', 409);
      if (current < 0) state.capabilities[kind].push(manifest); else state.capabilities[kind][current] = manifest;
      state.capabilities.revision = (state.capabilities.revision ?? 0) + 1;
      return manifest;
    });
  }
  environment(manifest) { return Object.fromEntries([...Object.entries(manifest.envMapping ?? {}), ...(manifest.envNames ?? []).map(name => [name, name])].flatMap(([key, name]) => process.env[name] === undefined ? [] : [[key, process.env[name]]])); }
  commandTool(manifest) {
    const service = this;
    return { ...manifest, name: manifest.toolName, effect: manifest.permission === 'read' ? 'read' : 'write',
      async execute(_callId, args, signal) {
        const env = service.environment(manifest), redact = value => { let result = String(value); for (const secret of Object.values(env)) if (secret) result = result.split(secret).join('[REDACTED]'); return result; };
        try {
          const response = await runCapabilityProcess(manifest.command, manifest.args, { cwd: manifest.cwd, env, signal, timeoutMs: manifest.timeoutMs, input: `${JSON.stringify(args)}\n`, maxBytes: 1024 * 1024 });
          let result; try { result = JSON.parse(response.stdout); } catch { throw new Error('命令工具未返回单个有效 JSON 结果'); }
          return { content: [{ type: 'text', text: redact(JSON.stringify(result)) }] };
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          const safe = new Error(redact(error.message));
          if (typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)) safe.code = error.code;
          // Preserve control-flow facts without copying command output or
          // credentials into errors. Even read/idempotent commands may still
          // be alive after their guardian disappears and require resolution.
          if (error.details?.cleanupUncertain === true || error.details?.startUncertain === true) safe.details = { cleanupUncertain: error.details.cleanupUncertain === true, startUncertain: error.details.startUncertain === true };
          throw safe;
        }
      }
    };
  }
  /**
   * The tools of one turn or run. `root` is the folder its tools work in (worktree design 0.63 §9: RootResolver's
   * answer; empty → the project folder). An `isolated` root (a session, worker or background worktree) always runs
   * commands in the macOS sandbox, with the project folder around it denied, so nothing there writes to it.
   */
  async registry(project, memoryTools = [], { connectIds, includeMutations = false, signal, sessionId, stateDir, permissionScope = 'foreground', ownerSessionId, execLogDir, root, isolated = false } = {}) {
    signal?.throwIfAborted();
    const config = this.configuration();
    const mcpServers = this.mcpManifests(config);
    // Connections of servers no longer configured this way are closed once nothing uses them.
    this.mcpSessions?.sweep(new Set(mcpServers.map(mcpFingerprint)));
    // Background commands run in the macOS sandbox (writes confined to the project; plan §4.4); so do all commands of
    // an isolated root, whose project folder stays denied (design §9). A sandboxed command cannot reach Rna's own API
    // either: its routes only check Host and Origin, which a local command satisfies.
    const sandbox = isolated ? { sandbox: true, sandboxDeny: [isolatedProjectFolder(project, root, variants => inLanguage(interfaceLanguageOf(this.store.state), variants))] } : { sandbox: permissionScope === 'background' };
    const port = this.daemonPort();
    const tools = await createWorkspaceTools(root || projectWorkspace(project.workspace), { includeMutations, execLogDir, ...sandbox, ...(Number.isInteger(port) && port > 0 ? { sandboxDenyPorts: [port] } : {}), ...stateConfinement(this.store, { unattended: permissionScope === 'background' || Boolean(ownerSessionId) }) });
    const registry = new CapabilityRegistry({ skills: config.skills, tools: [...tools, ...config.tools.map(tool => this.commandTool(tool)), ...memoryTools.map(tool => ({ ...tool, id: tool.id ?? tool.name, enabled: true, trusted: true, permission: tool.permission ?? 'read', effect: tool.effect ?? (tool.permission && tool.permission !== 'read' ? 'write' : 'read'), idempotent: tool.idempotent ?? true }))], mcpServers });
    registry.clientFactory = (server, { signal } = {}) => server.browser && sessionId && stateDir ? this.browserPool().acquire(server, { projectId: project.id, sessionId, stateDir, permissionScope, ownerSessionId, signal }) : sessionId && project.id && permissionScope === 'foreground' && !ownerSessionId ? this.mcpPool().acquire(server, { projectId: project.id, sessionId }) : new McpClient(server);
    const failures = [];
    for (const server of mcpServers) if (server.enabled && server.trusted && (!connectIds || connectIds.includes(server.id))) {
      try { await registry.connectMcp(server.id, { signal }); } catch { if (signal?.aborted) { await registry.close(); signal.throwIfAborted(); } failures.push({ id: server.id, error: 'MCP 连接或工具目录校验失败；未向项目授予该服务的工具。' }); }
    }
    return { registry, failures };
  }
}
