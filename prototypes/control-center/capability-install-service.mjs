import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CapabilityInstaller } from '../../packages/sdk/src/capability-installation.mjs';
import { CapabilityRegistry, loadSkill, mcpToolName } from '../../packages/sdk/src/capabilities.mjs';
import { McpClient } from '../../packages/sdk/src/mcp.mjs';
import { CapabilityService, builtinSkills } from './capability-service.mjs';
import { atomicWrite } from './durable-files.mjs';
import { browserPresets, resolveBrowserPreset, browserSessionManifest } from './browser-capability-presets.mjs';
import { normalizeImage } from '../../packages/sdk/src/images.mjs';

const queues = new WeakMap();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400, code = 'capability_install') => { throw Object.assign(new Error(message), { status, code, outcome: 'not-published' }); };
const copy = value => structuredClone(value);
const arrays = { skills: 'skillIds', tools: 'toolIds', mcpServers: 'mcpServerIds' };
const reservedToolNames = new Set(['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec', 'project_preview', 'project_dev_preview', 'project_exec_output', 'openviking_search', 'openviking_read', 'skill_load', 'skill_resource', 'capability_list', 'capability_inspect', 'capability_install', 'capability_assign', 'capability_remove', 'ask_user', 'request_project_permission', 'agent_consult', 'agent_delegate', 'agent_status', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_merge', 'attachment_read', 'project_find', 'project_grep', 'project_history', 'marketplace_search', 'marketplace_read', 'project_schedule', 'project_schedule_list']);
const builtinTools = () => [
  ['project_read', '读取项目文件', 'read', '读取项目工作目录中的文件。'],
  ['project_list', '浏览项目目录', 'read', '查看项目工作目录结构。'],
  ['project_find', '查找项目文件', 'read', '按通配符查找项目内文件，跳过私密路径与符号链接。'],
  ['project_grep', '搜索项目内容', 'read', '有界搜索项目 UTF-8 文本，返回文件路径和行号。'],
  ['project_write', '写入项目文件', 'write', '在项目工作目录中创建或覆盖文件。'],
  ['project_edit', '编辑项目文件', 'write', '修改项目工作目录中的已有文件。'],
  ['project_exec', '运行项目命令', 'exec', '以当前用户身份在本机执行项目命令，可能访问主机文件与网络。'],
  ['openviking_search', '检索项目记忆', 'read', '查找当前项目的相关记忆摘要。'],
  ['openviking_read', '读取项目记忆', 'read', '使用记忆搜索结果或候选提供的 viking:// URI（uri/expandUri），按需读取当前项目记忆概览或原文；工作区文件路径使用 project_read。']
].map(([id, name, permission, description]) => ({ id, name, permission, description, builtin: true, enabled: true, trusted: true }));
const requireProject = (state, id) => { const project = state.projects.find(row => row.id === id); if (!project) fail('项目不存在', 404); if (project.archivedAt) fail('项目已归档，请先恢复', 409); return project; };
function prepareConfiguration(state) { state.capabilities ??= { skills: builtinSkills() }; for (const key of ['skills', 'tools', 'mcpServers', 'installations']) state.capabilities[key] ??= []; state.capabilities.revision ??= 0; return state.capabilities; }
function assignmentOf(project) { return { skillIds: [], toolIds: project.assignments ? [] : ['project_read', 'project_list', 'openviking_search', 'openviking_read'], mcpServerIds: [], reasons: [], ...copy(project.assignments ?? {}) }; }
function addAssignment(project, additions, reason) {
  const current = assignmentOf(project);
  for (const [kind, field] of Object.entries(arrays)) for (const id of additions[field] ?? []) {
    if (!current[field].includes(id)) current[field].push(id);
    const reasonKind = { skills: 'skill', tools: 'tool', mcpServers: 'mcpServer' }[kind];
    if (!current.reasons.some(row => row.kind === reasonKind && row.id === id)) current.reasons.push({ kind: reasonKind, id, reason: String(reason || '在当前项目对话中安装并启用').slice(0, 1000) });
  }
  project.assignments = current; project.capabilityRevision = (project.capabilityRevision ?? 0) + 1; return current;
}
function dropAssignment(project, removed) {
  const current = assignmentOf(project), removedTools = new Set(removed.toolIds ?? []), removedServers = new Set(removed.mcpServerIds ?? []);
  current.skillIds = current.skillIds.filter(id => !removed.skillIds?.includes(id));
  current.toolIds = current.toolIds.filter(id => !removedTools.has(id)); current.mcpServerIds = current.mcpServerIds.filter(id => !removedServers.has(id));
  current.reasons = current.reasons.filter(row => (row.kind === 'skill' ? current.skillIds : row.kind === 'tool' ? current.toolIds : current.mcpServerIds).includes(row.id));
  project.assignments = current; project.capabilityRevision = (project.capabilityRevision ?? 0) + 1; return current;
}
const wireToolId = (serverId, name) => { const raw = `mcp:${serverId}:${name}`; return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(raw) ? raw : `mcp:${createHash('sha256').update(JSON.stringify([serverId, name])).digest('hex').slice(0, 32)}`; };
const processUncertain = error => error.details?.cleanupUncertain === true || error.details?.startUncertain === true || error.code === 'process_cleanup_uncertain';
const uncertaintyDetails = error => processUncertain(error) ? { cleanupUncertain: true, startUncertain: error.details?.startUncertain === true, ...(typeof error.details?.stagingDir === 'string' ? { stagingDir: error.details.stagingDir, stagingRetained: true } : {}) } : undefined;
const publicFailure = error => ({ code: error.code ?? 'installation_failed', message: error.name === 'AbortError' ? processUncertain(error) ? '安装已取消，但外部进程清理尚未确认；保留现场，请勿自动重试' : '安装已取消，未发布未完成的能力' : String(error.message).slice(0, 2000), ...(error.details?.exitCode !== undefined ? { exitCode: error.details.exitCode } : {}), ...(processUncertain(error) ? { details: uncertaintyDetails(error) } : {}) });
function unpublishedFailure(error) {
  const missing = ['ENOENT', 'ENOTDIR'].includes(error.code), denied = ['EACCES', 'EPERM'].includes(error.code);
  return Object.assign(new Error(missing ? '找不到指定的能力目录或文件，请检查路径后重试。' : denied ? '无法读取指定的能力目录或文件，请检查访问权限。' : publicFailure(error).message), { status: error.status ?? (missing ? 404 : denied ? 403 : error.name === 'AbortError' ? 499 : 400), code: error.code ?? 'invalid_install', outcome: processUncertain(error) ? 'unknown' : 'not-published', ...(processUncertain(error) ? { details: uncertaintyDetails(error) } : {}) });
}

function exactPublishedInstallation(state, { installationId, projectId, fingerprint, prepared, manifests }) {
  const configuration = state.capabilities, matches = configuration?.installations?.filter(row => row.installationId === installationId) ?? [];
  if (matches.length !== 1 || !prepared || prepared.installationId !== installationId || !manifests.length) return false;
  const record = matches[0];
  return record.status === 'installed' && record.projectId === projectId && record.fingerprint === fingerprint && record.installationDir === prepared.installationDir && Array.isArray(record.sources) && Array.isArray(record.entries) &&
    digest(record.sources) === digest(prepared.sources) && digest(record.entries) === digest(manifests.map(({ kind, manifest }) => ({ kind, id: manifest.id }))) &&
    manifests.every(({ kind, manifest }) => {
      const entries = configuration[kind]?.filter(row => row.id === manifest.id) ?? [];
      return entries.length === 1 && entries[0].installationId === installationId && digest(entries[0]) === digest(manifest);
    });
}

/** Shared by model tools, HTTP and CLI. Publication is one store transaction. */
export class CapabilityInstallService {
  constructor(store, { capabilityService = new CapabilityService(store), rootDir = resolve(`${store.file}.capabilities`), installerOptions = {} } = {}) {
    this.store = store; this.capabilities = capabilityService; this.rootDir = rootDir; this.installer = new CapabilityInstaller({ ...installerOptions, rootDir });
  }
  async exclusive(task, signal) {
    const previous = queues.get(this.store) ?? Promise.resolve(); let release; const gate = new Promise(resolve => { release = resolve; }); queues.set(this.store, gate);
    await previous.catch(() => {});
    try { signal?.throwIfAborted(); return await task(); } finally { release(); if (queues.get(this.store) === gate) queues.delete(this.store); }
  }
  async journal(id, record) {
    atomicWrite(join(this.rootDir, '.transactions', `${id}.json`), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2));
  }
  list(projectId) {
    const project = requireProject(this.store.state, projectId), configuration = this.capabilities.public();
    const version = project.versions?.find(v => v.id === (project.trialVersionId ?? project.activeVersionId));
    const selectedSkills = version?.generatedSkills ?? version?.skillManifests ?? [], selectedTools = version?.generatedTools ?? version?.toolDescriptors ?? [];
    const assignments = assignmentOf(project);
    if (version?.bundle) { assignments.skillIds = [...assignments.skillIds.filter(id => !/^gen-[a-f0-9]{16}-/.test(id)), ...selectedSkills.map(s => s.id)]; assignments.toolIds = [...assignments.toolIds.filter(id => !/^gen_[a-f0-9]{8}_/.test(id)), ...selectedTools.map(t => t.id)]; }
    return { ...configuration, presets: browserPresets(), skills: [...configuration.skills.filter(s => !s.generated), ...selectedSkills], tools: [...builtinTools(), ...configuration.tools, ...selectedTools], projectId, assignments, revision: this.capabilities.revision(), projectRevision: project.capabilityRevision ?? 0 };
  }
  async inspect(input, { projectId, signal } = {}) { try { if (projectId) requireProject(this.store.state, projectId); const resolved = await resolveBrowserPreset(input); return { ...await this.installer.inspect(resolved.input, { signal }), ...(resolved.browser ? { browser: { ...resolved.browser, readiness: 'executable_found_not_launched' } } : {}) }; } catch (error) { throw unpublishedFailure(error); } }
  validateToolNames(additions) {
    const config = this.capabilities.configuration(), names = new Set(reservedToolNames);
    for (const tool of config.tools) names.add(tool.toolName);
    for (const server of config.mcpServers) for (const name of Object.keys(server.allowTools ?? {})) names.add(mcpToolName(server.id, name));
    for (const { kind, manifest } of additions) {
      const proposed = kind === 'tools' ? [manifest.toolName] : kind === 'mcpServers' ? Object.keys(manifest.allowTools ?? {}).map(name => mcpToolName(manifest.id, name)) : [];
      for (const name of proposed) { if (names.has(name)) fail(`工具名称与现有能力冲突：${name}`, 409, 'capability_conflict'); names.add(name); }
    }
  }
  async probe(manifest, { signal, toolPermission } = {}) {
    let probeDir;
    if (manifest.browser) {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      probeDir = join(this.rootDir, `.browser-probe-${randomUUID()}`);
      manifest = await browserSessionManifest(manifest, probeDir, { storageRoot: this.rootDir });
    }
    const client = new McpClient({ ...manifest, enabled: true, trusted: true, ...(manifest.transport === 'stdio' ? { env: manifest.browser ? {} : this.capabilities.environment(manifest) } : {}) });
    try {
      await client.connect({ signal }); const discovered = await client.listTools({ signal }), allowTools = { ...manifest.allowTools };
      // A declared map (even {}) is an explicit boundary. A blanket permission
      // applies only to this discovery when no map/grants were supplied.
      if (toolPermission && manifest.allowToolsSpecified !== true && !Object.keys(allowTools).length) for (const tool of discovered) Object.defineProperty(allowTools, tool.name, { enumerable: true, configurable: true, writable: true, value: { permission: toolPermission, idempotent: false } });
      // Match runtime discovery: unavailable, ungranted extensions are not part
      // of the agent schema. Validate every granted tool without widening that
      // boundary merely because another upstream tool uses an unsupported schema.
      const validated = new CapabilityRegistry({ tools: discovered.filter(tool => Object.hasOwn(allowTools, tool.name)).map(tool => ({ id: wireToolId(manifest.id, tool.name), name: mcpToolName(manifest.id, tool.name), description: tool.description, parameters: tool.inputSchema, permission: allowTools[tool.name].permission, enabled: true, trusted: true, execute() {} })) });
      const grants = [...validated.tools.values()];
      const names = new Set(discovered.map(tool => tool.name)); for (const name of Object.keys(allowTools)) if (!names.has(name)) fail(`授权工具未在 MCP 目录中发现：${name}`, 400, 'unknown_mcp_tool');
      let browserReadiness;
      if (manifest.browser) {
        // Discovery alone does not prove that Chrome can start or screenshots
        // can cross the actual upstream MCP transport.
        const navigation = await client.callTool('browser_navigate', { url: 'about:blank' }, { signal });
        const snapshot = await client.callTool('browser_snapshot', {}, { signal });
        const screenshot = await client.callTool('browser_take_screenshot', { type: 'png', scale: 'css' }, { signal });
        if (navigation.isError || snapshot.isError || screenshot.isError || !snapshot.content.some(part => part.type === 'text') || !screenshot.content.some(part => part.type === 'image')) fail('浏览器实际启动或截图检查失败；未发布能力。', 400, 'browser_readiness_failed');
        for (const part of screenshot.content.filter(part => part.type === 'image')) normalizeImage(part);
        browserReadiness = { status: 'ready', checkedAt: new Date().toISOString(), navigation: true, snapshot: true, screenshot: true, target: 'about:blank', packageVersion: manifest.browser.packageVersion };
      }
      return { allowTools, ...(browserReadiness ? { browserReadiness } : {}), toolIds: grants.map(tool => tool.id), discovered: discovered.map(tool => ({ name: tool.name, toolId: wireToolId(manifest.id, tool.name), description: tool.description ?? '', permission: allowTools[tool.name]?.permission ?? null, granted: Object.hasOwn(allowTools, tool.name) })) };
    } finally { await client.close(); if (probeDir) await rm(probeDir, { recursive: true, force: true }); }
  }
  async install(projectId, input, { signal, requestId = input?.requestId ?? randomUUID() } = {}) {
    return this.exclusive(async () => {
      requireProject(this.store.state, projectId);
      const fingerprint = digest(input), installationId = `install-${digest([projectId, requestId]).slice(0, 32)}`;
      const previous = this.capabilities.configuration().installations.find(row => row.installationId === installationId);
      if (previous) { if (previous.fingerprint !== fingerprint) fail('此安装请求 ID 已用于其他内容', 409, 'request_conflict'); if (previous.status !== 'installed') fail('此安装已移除；请使用新的安装请求 ID', 409, 'request_conflict'); return { ...copy(previous), replayed: true, assignments: assignmentOf(requireProject(this.store.state, projectId)), revision: this.capabilities.revision() }; }
      let transaction;
      try { transaction = JSON.parse(await readFile(join(this.rootDir, '.transactions', `${installationId}.json`), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error('安装事务记录无法验证；请检查后再继续，不会重复执行'), { status: 409, code: 'process_cleanup_uncertain', outcome: 'unknown', details: { cleanupUncertain: true } }); }
      if (transaction && ['preparing', 'needs_review'].includes(transaction.status)) throw Object.assign(new Error('此安装请求存在未决外部执行；请核对保留的现场，不能自动重试'), { status: 409, code: 'process_cleanup_uncertain', outcome: 'unknown', details: { ...transaction.failure?.details, cleanupUncertain: true } });
      await this.journal(installationId, { installationId, projectId, fingerprint, status: 'preparing' });
      let prepared, publicationProof, published = false, publicationAttempted = false;
      const manifests = [];
      try {
        const preset = await resolveBrowserPreset(input);
        prepared = await this.installer.prepare(preset.input, { signal, installationId });
        if (preset.browser) for (const row of [...prepared.manifests, ...prepared.stagedManifests]) if (row.kind === 'mcpServers') row.manifest.browser = preset.browser;
        const additions = { skillIds: [], toolIds: [], mcpServerIds: [] }, discovered = [];
        for (let index = 0; index < prepared.manifests.length; index++) {
          const { kind, manifest: candidate } = prepared.manifests[index], staged = prepared.stagedManifests[index].manifest;
          const current = this.capabilities.configuration()[kind].find(row => row.id === candidate.id);
          if (current) fail(`能力 ID 已存在：${candidate.id}；请使用新 ID 或先移除`, 409, 'capability_conflict');
          const activate = input.activate === true && candidate.enabled !== false;
          let manifest = this.capabilities.normalize(kind, { ...candidate, installationId, enabled: activate, trusted: true });
          if (activate) {
            if (kind === 'skills') await loadSkill({ ...staged, enabled: true, trusted: true });
            if (kind === 'mcpServers') {
              const probed = await this.probe(staged, { signal, toolPermission: input.toolPermission }); manifest.allowTools = probed.allowTools; manifest.discoveredTools = probed.discovered; discovered.push({ serverId: manifest.id, tools: probed.discovered, ...(probed.browserReadiness ? { browserReadiness: probed.browserReadiness } : {}) }); additions.toolIds.push(...probed.toolIds);
              if (manifest.browser) additions.skillIds.push('browser-verification');
            }
            additions[arrays[kind]].push(manifest.id);
          }
          manifests.push({ kind, manifest });
        }
        this.validateToolNames(manifests);
        const revision = this.capabilities.revision(); signal?.throwIfAborted();
        await prepared.commit(); signal?.throwIfAborted();
        // Do not compare borrowed manifest references after the Store callback:
        // those same objects are inserted into the proposed state snapshot.
        publicationProof = { prepared: { installationId: prepared.installationId, installationDir: prepared.installationDir, sources: copy(prepared.sources) }, manifests: copy(manifests) };
        publicationAttempted = true;
        const record = this.store.mutate(state => {
          const project = requireProject(state, projectId), config = prepareConfiguration(state);
          if (config.revision !== revision) fail('能力目录在安装时发生变更，请重试', 409, 'capability_conflict');
          for (const { kind, manifest } of manifests) { if (config[kind].some(row => row.id === manifest.id)) fail('能力 ID 在安装过程中已被使用', 409); config[kind].push(manifest); }
          if (Object.values(additions).some(ids => ids.length)) addAssignment(project, additions, input.reason);
          config.revision++;
          const value = { installationId, projectId, fingerprint, status: 'installed', activated: manifests.some(row => row.manifest.enabled), entries: manifests.map(({ kind, manifest }) => ({ kind, id: manifest.id })), sources: prepared.sources, diagnostics: prepared.diagnostics, discovered, installationDir: prepared.installationDir, createdAt: new Date().toISOString() };
          config.installations.push(value); return { ...value, assignments: copy(project.assignments ?? assignmentOf(project)), revision: config.revision };
        });
        published = true;
        await this.journal(installationId, record).catch(() => {});
        return { ...record, manifests };
      } catch (error) {
        // Store makes the new snapshot authoritative after a successful rename,
        // even when the following directory fsync fails. Retain only this exact
        // generation; a generic `committed` flag is not publication evidence.
        if (publicationAttempted && error.committed === true && exactPublishedInstallation(this.store.state, { installationId, projectId, fingerprint, ...publicationProof })) {
          const failure = {
            code: 'installation_durability_unknown',
            message: '安装已写入当前状态，但磁盘持久化确认失败；已保留安装文件。请恢复存储后核对原请求，不会重复安装。',
            details: { installationId, publication: 'visible', durability: 'unconfirmed', filesRetained: true, persistenceCode: /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'WRITE_FAILED' },
          };
          await this.journal(installationId, { installationId, projectId, fingerprint, status: 'needs_review', failure }).catch(() => {});
          throw Object.assign(new Error(failure.message), { status: 503, code: failure.code, outcome: 'unknown', details: failure.details });
        }
        if (prepared && !published && !processUncertain(error)) await prepared.rollback();
        if (prepared && !published && processUncertain(error)) error.details = { ...error.details, stagingDir: prepared.stagingDir, stagingRetained: true };
        if (error.name !== 'AbortError' && prepared?.diagnostics.some(row => row.code === 'scripts_disabled' && row.scripts?.length)) error.message += '。npm 安装脚本未运行；需要 native/postinstall 构建的包暂不能激活，不会自动执行这些脚本。';
        await this.journal(installationId, { installationId, projectId, fingerprint, status: processUncertain(error) ? 'needs_review' : error.name === 'AbortError' ? 'cancelled' : 'failed', failure: publicFailure(error) }).catch(() => {});
        throw Object.assign(new Error(publicFailure(error).message), { status: error.status ?? (error.name === 'AbortError' ? 499 : 400), code: error.code ?? (error.name === 'AbortError' ? 'cancelled' : 'installation_failed'), outcome: published || processUncertain(error) ? 'unknown' : 'not-published', ...(processUncertain(error) ? { details: uncertaintyDetails(error) } : {}) });
      }
    }, signal);
  }
  async assign(projectId, input, { signal } = {}) {
    return this.exclusive(async () => {
      const project = requireProject(this.store.state, projectId), config = this.capabilities.configuration(), additions = {};
      for (const field of Object.values(arrays)) { if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 300 || input[field].some(id => typeof id !== 'string'))) fail('能力分配需要 ID 数组'); additions[field] = [...new Set(input[field] ?? [])]; }
      const staged = [], discovered = [], revision = config.revision;
      try {
      for (const [kind, field] of Object.entries(arrays)) {
        if (kind === 'tools') continue;
        for (const id of additions[field]) {
          const old = config[kind].find(row => row.id === id); if (!old) fail(`能力不存在：${id}`, 404);
          if (old.generated || old.managed === 'project-genome') fail('项目生成能力由版本管理，请在项目版本中编辑能力包', 409);
          if ((!old.enabled || !old.trusted) && input.activate !== true) fail(`能力尚未启用：${id}`, 409);
          const manifest = { ...old, enabled: true, trusted: true, ...(kind === 'mcpServers' && input.allowTools !== undefined ? { allowTools: this.capabilities.normalize('mcpServers', { ...old, enabled: true, trusted: true, allowTools: input.allowTools }).allowTools, allowToolsSpecified: true } : {}) };
          if (kind === 'skills') await loadSkill(manifest);
          else { const result = await this.probe(manifest, { signal, toolPermission: input.toolPermission }); manifest.allowTools = result.allowTools; manifest.discoveredTools = result.discovered; additions.toolIds.push(...result.toolIds); discovered.push({ serverId: id, tools: result.discovered, ...(result.browserReadiness ? { browserReadiness: result.browserReadiness } : {}) }); if (manifest.browser) additions.skillIds.push('browser-verification'); }
          staged.push({ kind, manifest });
        }
      }
      for (const id of additions.toolIds) {
        const manifest = config.tools.find(row => row.id === id);
        if (manifest) { if ((!manifest.enabled || !manifest.trusted) && input.activate !== true) fail(`工具尚未启用：${id}`, 409); staged.push({ kind: 'tools', manifest: { ...manifest, enabled: true, trusted: true } }); continue; }
        if (['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec', 'openviking_search', 'openviking_read'].includes(id)) continue;
        const permitted = [...config.mcpServers, ...staged.filter(row => row.kind === 'mcpServers').map(row => row.manifest)].some(server => (additions.mcpServerIds.includes(server.id) || project.assignments?.mcpServerIds?.includes(server.id)) && server.enabled && server.trusted && (server.discoveredTools ?? []).some(tool => tool.toolId === id && tool.granted));
        if (!permitted) fail(`工具不存在或不在已授权目录中：${id}`, 403);
      }
      signal?.throwIfAborted();
      } catch (error) { throw unpublishedFailure(error); }
      return this.store.mutate(state => { const target = requireProject(state, projectId), config = prepareConfiguration(state); if (config.revision !== revision) fail('能力目录发生变更，请重试', 409); for (const { kind, manifest } of staged) { const index = config[kind].findIndex(row => row.id === manifest.id); if (index < 0) fail('能力已被移除', 409); config[kind][index] = manifest; } config.revision++; return { assignments: addAssignment(target, additions, input.reason), discovered, revision: config.revision, projectRevision: target.capabilityRevision }; });
    }, signal);
  }
  async remove(projectId, input, { signal } = {}) {
    return this.exclusive(async () => {
      const project = requireProject(this.store.state, projectId), config = this.capabilities.configuration();
      let entries;
      if (input.installationId) { const installation = config.installations.find(row => row.installationId === input.installationId && row.status === 'installed'); if (!installation) fail('安装记录不存在', 404); entries = installation.entries; }
      else { if (!Object.hasOwn(arrays, input.kind) || typeof input.id !== 'string') fail('移除需要 installationId 或 kind 与 id'); entries = [{ kind: input.kind, id: input.id }]; }
      const removed = { skillIds: [], toolIds: [], mcpServerIds: [] };
      for (const { kind, id } of entries) { const version = project.versions?.find(v => v.id === (project.trialVersionId ?? project.activeVersionId)), selected = kind === 'skills' ? version?.generatedSkills ?? version?.skillManifests ?? [] : kind === 'tools' ? version?.generatedTools ?? version?.toolDescriptors ?? [] : []; const manifest = config[kind].find(row => row.id === id) ?? [...selected, ...(kind === 'tools' ? builtinTools() : [])].find(row => row.id === id); if (!manifest) fail('能力不存在', 404); if (manifest.generated || manifest.managed === 'project-genome') fail('项目生成能力由版本管理，请在项目版本中编辑能力包', 409); if (manifest.builtin && input.uninstall === true) fail('内置能力不能注销', 409); removed[arrays[kind]].push(id); if (kind === 'mcpServers') removed.toolIds.push(...(manifest.discoveredTools ?? []).map(tool => tool.toolId), ...Object.keys(manifest.allowTools ?? {}).map(name => wireToolId(id, name))); }
      signal?.throwIfAborted();
      const result = this.store.mutate(state => {
        const project = requireProject(state, projectId), current = prepareConfiguration(state);
        if (input.uninstall === true) {
          for (const other of state.projects) if (other.id !== projectId && Object.values(arrays).some(field => removed[field].some(id => other.assignments?.[field]?.includes(id)))) fail('其他项目仍在使用此能力；请先在这些项目中移除分配', 409, 'capability_in_use');
          for (const { kind, id } of entries) current[kind] = current[kind].filter(row => row.id !== id);
          for (const install of current.installations) if (install.entries.every(entry => !current[entry.kind].some(row => row.id === entry.id))) install.status = 'removed';
          current.revision++;
        }
        const assignments = dropAssignment(project, removed);
        // Existing sessions own their clients and immutable generation files.
        // Detachment never kills an in-flight call or deletes its resources.
        return { status: input.uninstall === true ? 'unregistered' : 'detached', removed, assignments, revision: current.revision, filesRetained: true, message: '当前项目后续步骤不再使用已移除能力；受管浏览器连接会关闭，其他能力已在途的调用与安装文件保留。' };
      });
      // C4: what left the project (skills, tools, MCP services) is told to the revocation dispatcher, which asks which notes, plan items and lessons still tell the assistant to use it.
      const withdrawn = [...removed.skillIds.map(id => ({ kind: 'skill', id, name: id })), ...removed.toolIds.map(id => ({ kind: 'tool', id, name: id })), ...removed.mcpServerIds.map(id => ({ kind: 'mcp', id, name: id }))];
      if (withdrawn.length && typeof this.onWithdrawn === 'function') try { this.onWithdrawn({ type: 'tool_withdrawn', projectId, tools: withdrawn.slice(0, 12) }); } catch { /* an observer never blocks a removal */ }
      return result;
    }, signal);
  }
  createTools(projectId, { onChanged = () => {} } = {}) {
    const object = properties => ({ type: 'object', properties, additionalProperties: false });
    const selection = { skillIds: { type: 'array', items: { type: 'string' } }, toolIds: { type: 'array', items: { type: 'string' } }, mcpServerIds: { type: 'array', items: { type: 'string' } }, activate: { type: 'boolean' }, allowTools: { type: 'object' }, toolPermission: { enum: ['read', 'write', 'exec'] }, reason: { type: 'string' } };
    const installSchema = { ...object({ kind: { enum: ['skill', 'mcp', 'tool'] }, id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, source: { type: 'object', properties: { type: { enum: ['local', 'git', 'npm', 'mcp-config', 'command', 'preset'] }, preset: { type: 'string', enum: ['playwright-browser'] }, executablePath: { type: 'string' }, path: { type: 'string' }, repository: { type: 'string' }, ref: { type: 'string' }, subdirectory: { type: 'string' }, package: { type: 'string' }, registry: { type: 'string' }, bin: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, env: { type: 'object' }, config: { type: 'object' } }, required: ['type'], additionalProperties: false }, activate: { type: 'boolean' }, allowTools: { type: 'object' }, toolPermission: { enum: ['read', 'write', 'exec'] }, permission: { enum: ['read', 'write', 'exec'] }, parameters: { type: 'object' }, idempotent: { type: 'boolean' }, reason: { type: 'string' } }), required: ['kind', 'source'] };
    const make = (name, description, parameters, permission, action, changes = false) => ({ id: name, name, description, parameters, permission, effect: permission === 'read' ? 'read' : 'write', idempotent: permission === 'read', enabled: true, trusted: true,
      execute: async (callId, args, signal) => {
        try { const value = await action(args, signal, callId); if (changes) { try { await onChanged(value); } catch {} } return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
        catch (error) {
          if (processUncertain(error)) throw error;
          // Expected validation errors and confirmed rollback are ordinary tool
          // results. An unproven publication outcome remains an uncertain write.
          if (error.outcome === 'not-published' || permission === 'read' || error.outcome !== 'unknown' && [400, 403, 404, 409].includes(error.status)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ...publicFailure(error), outcome: 'not-published' }) }] };
          throw error;
        }
      }
    });
    return [
      make('capability_list', '列出可安装/已安装能力与当前项目的分配。安装目录不等于项目授权。', object({}), 'read', () => this.list(projectId)),
      make('capability_inspect', '检查 skill、npm 包、MCP JSON 或 source.type=preset 的 playwright-browser 预设；预设检查本机 Chrome 路径，不启动浏览器。', installSchema, 'read', (args, signal) => this.inspect(args, { projectId, signal })),
      make('capability_install', '按用户请求安装完整 SKILL.md bundle、固定版本 npm MCP/命令工具，或导入 mcpServers JSON。source.type 为 local/git/npm/mcp-config/command/preset。浏览器可用 source:{type:"preset",preset:"playwright-browser"}，默认查找已安装 Chrome，固定官方版本与最小 exec 工具集，实际启动/快照/截图通过才发布；已安装同 ID 时用 capability_assign。activate:true 才会启动新 MCP 发现工具并分配给当前项目；allowTools 或 toolPermission 明确授权本次发现工具，禁止从服务器注释推导权限。npm 安装脚本禁用，不会修改其他项目。source.env 与 MCP headers/env 使用 ${ENV_NAME}，不要传明文凭据。', installSchema, 'exec', (args, signal, callId) => this.install(projectId, args, { signal, requestId: `${callId}:${digest(args)}` }), true),
      make('capability_assign', '将已安装能力分配给当前项目；activate:true 可显式启用已安装未启用的能力。新增 MCP 工具仍需 allowTools 或 toolPermission。', object(selection), 'exec', (args, signal) => this.assign(projectId, args, { signal }), true),
      make('capability_remove', '从当前项目移除能力分配。uninstall:true 还注销无人使用的能力；受管浏览器连接会关闭，其他能力已在途的调用不会因此停止，安装文件保留。', object({ installationId: { type: 'string' }, kind: { enum: ['skills', 'tools', 'mcpServers'] }, id: { type: 'string' }, uninstall: { type: 'boolean' } }), 'write', (args, signal) => this.remove(projectId, args, { signal }), true)
    ];
  }
}
