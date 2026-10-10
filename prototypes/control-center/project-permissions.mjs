import { registeredWorkspacePath } from './workspace-directories.mjs';
import { inLanguage, interfaceLanguageOf, LANGUAGE_NAMES } from './interface-language.mjs';

const levels = { read: 0, write: 1, execute: 2 };
const builtin = ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit', 'project_exec'];
const builtinFor = level => builtin.filter(id => ['project_read', 'project_list', 'project_find', 'project_grep'].includes(id) || level !== 'read' && ['project_write', 'project_edit'].includes(id) || level === 'execute' && id === 'project_exec');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const projectOf = (state, id) => state.projects.find(project => project.id === id) ?? fail('项目不存在', 404);
export function permissionSettings(project) {
  const assigned = project.assignments?.toolIds ?? [];
  const inferred = assigned.includes('project_exec') ? 'execute' : assigned.some(id => ['project_write', 'project_edit'].includes(id)) ? 'write' : 'read';
  return { workspace: project.permissions?.workspace ?? inferred, background: project.permissions?.background ?? 'read' };
}
export function permissionLevel(project, scope = 'foreground') {
  const settings = permissionSettings(project);
  if (scope === 'background' && settings.background !== 'inherit') return 'read';
  // Legacy explicit assignments retain their original grant until the user
  // chooses a project ceiling. No new tool is granted by this compatibility.
  return project.permissions?.workspace ?? 'execute';
}
export function toolPermitted(project, tool, scope = 'foreground') {
  const permission = tool.permission ?? (tool.effect === 'read' ? 'read' : 'write');
  return (levels[permission === 'exec' ? 'execute' : permission] ?? 2) <= levels[permissionLevel(project, scope)];
}
export function permissionView(project) {
  const settings = permissionSettings(project);
  return { projectId: project.id, workspace: registeredWorkspacePath(project.workspace), settings,
    effective: { foreground: permissionLevel(project), background: permissionLevel(project, 'background') },
    revision: project.permissions?.revision ?? 0, inheritedAssignments: !project.permissions,
    description: '权限对当前项目生效。文件工具限制在项目目录；命令以当前系统用户运行，并非操作系统沙箱。MCP 和外部工具仍需单独分配且可信。' };
}
export function applyProjectPermissions(state, projectId, input, { source = 'settings' } = {}) {
  const project = projectOf(state, projectId);
  if (project.archivedAt) fail('请先恢复归档项目再修改权限', 409);
  if (!input || Object.keys(input).some(key => !['workspace', 'background'].includes(key)) || !Object.hasOwn(levels, input.workspace) || !['read', 'inherit'].includes(input.background)) fail('项目权限配置无效');
  const previous = permissionSettings(project), selected = builtinFor(input.workspace);
  project.assignments ??= { skillIds: [], toolIds: [], mcpServerIds: [] };
  project.assignments.toolIds = [...new Set([...(project.assignments.toolIds ?? []).filter(id => !builtin.includes(id)), ...selected])];
  project.permissions = { ...input, revision: (project.permissions?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), source };
  state.events.push({ id: ++state.sequence, type: 'project.permissions.updated', at: project.permissions.updatedAt, projectId, message: '项目权限已更新。', previous, settings: { ...input } });
  state.events = state.events.slice(-1000);
  return permissionView(project);
}

/** Whether saved settings already grant a requested scope. */
const covers = (settings, scope) => levels[settings.workspace] >= levels[scope.workspace] && (scope.background !== 'inherit' || settings.background === 'inherit');

export class ProjectPermissionService {
  constructor(store, interactions) {
    this.store = store; this.interactions = interactions;
    interactions?.setPermissionHandler(input => this.applyAnswer(input));
  }
  get(projectId) { return permissionView(projectOf(this.store.state, projectId)); }
  update(projectId, input) { return this.store.mutate(state => applyProjectPermissions(state, projectId, input)); }
  /** `language`: the card is the user's to read, so its text follows the interface language (the saved setting unless given). */
  request(projectId, input, { language = interfaceLanguageOf(this.store.state) } = {}) {
    let view = this.get(projectId);
    if (!['write', 'execute'].includes(input.workspace) || !['read', 'inherit'].includes(input.background) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) fail('权限请求必须包含明确的范围和原因');
    // 完全访问 covers all of the project's work (as zcode's yolo mode and harness's danger-full-access preset do): a request
    // is granted at once, background included, and no card is shown.
    if (view.settings.workspace === 'execute') {
      if (view.settings.background !== 'inherit') this.store.mutate(state => applyProjectPermissions(state, projectId, { workspace: 'execute', background: 'inherit' }, { source: 'full-access' }));
      return { alreadyAllowed: true, autoGranted: true };
    }
    const target = { workspace: levels[view.settings.workspace] > levels[input.workspace] ? view.settings.workspace : input.workspace,
      background: view.settings.background === 'inherit' ? 'inherit' : input.background };
    const alreadyAllowed = levels[view.settings.workspace] >= levels[input.workspace] && (input.background !== 'inherit' || view.settings.background === 'inherit');
    // A removed capability assignment must not leave a saved write grant
    // unusable. Restore only builtins already covered by the existing ceiling;
    // external capabilities still require their own assignment and trust.
    if (alreadyAllowed && !view.inheritedAssignments) {
      const assigned = projectOf(this.store.state, projectId).assignments?.toolIds ?? [];
      if (builtinFor(view.settings.workspace).some(id => !assigned.includes(id))) view = this.store.mutate(state => applyProjectPermissions(state, projectId, view.settings, { source: 'existing-permission' }));
    }
    const say = (zh, en) => inLanguage(language, { zh, en });
    const scope = say(`${target.workspace === 'execute' ? '读写项目文件并执行命令' : '读写项目文件'}；${target.background === 'inherit' ? '后台自主工作也使用此权限' : '后台仍只读'}`,
      `${target.workspace === 'execute' ? 'Read and write project files and run commands' : 'Read and write project files'}; ${target.background === 'inherit' ? 'background autonomous work uses this permission too' : 'background work stays read-only'}`);
    return { alreadyAllowed, questions: [{ id: 'permission', header: say('项目权限', 'Project permissions'), question: say('是否允许此项目使用以下权限？', 'Allow this project to use the following permissions?'), detail: say(`${input.reason.trim()}\n目录：${view.workspace}\n申请：${scope}`, `${input.reason.trim()}\nFolder: ${view.workspace}\nRequested: ${scope}`), options: [{ id: 'allow', label: say('允许此项目使用', 'Allow for this project'), description: scope }, { id: 'deny', label: say('保持现有权限', 'Keep current permissions'), description: say('不扩大权限，也不执行被限制的操作。', 'Permissions stay as they are, and the restricted action is not carried out.') }], multiSelect: false, allowCustom: false }],
      metadata: { kind: 'permission', permission: { projectId, workspace: target.workspace, background: target.background, workspacePath: view.workspace, baseRevision: view.revision, reason: input.reason.trim() } } };
  }
  applyAnswer({ state, session, interaction, answers, cancel }) {
    if (cancel || !answers.some(answer => answer.id === 'permission' && answer.selected.length === 1 && answer.selected[0] === 'allow' && !answer.custom)) return { permissionChanged: false };
    const scope = interaction.permission;
    if (!scope || scope.projectId !== session.projectId) fail('权限请求与项目不匹配', 409);
    const view = permissionView(projectOf(state, session.projectId));
    // Already covered by the saved permissions (e.g. 完全访问 was chosen meanwhile): nothing to change, the card just closes.
    if (view.workspace === scope.workspacePath && covers(view.settings, scope)) return { permissionChanged: false };
    if (view.workspace !== scope.workspacePath || view.revision !== scope.baseRevision) fail('项目目录或权限已改变，请重新查看当前权限', 409);
    applyProjectPermissions(state, session.projectId, { workspace: scope.workspace, background: scope.background }, { source: 'interaction' });
    return { permissionChanged: true };
  }
  /** Under 完全访问, permission cards still waiting (asked before it was chosen) are answered 'allow' on the user's behalf.
   * Returns the sessions whose paused turn should resume. */
  settleFullAccess(projectId = null) {
    const resumes = [];
    for (const project of this.store.state.projects.filter(row => !row.archivedAt && (!projectId || row.id === projectId))) {
      const settings = permissionSettings(project);
      if (settings.workspace !== 'execute') continue;
      if (settings.background !== 'inherit') this.store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'inherit' }, { source: 'full-access' }));
      for (const session of this.store.state.sessions.filter(row => row.projectId === project.id && !row.archivedAt)) {
        for (const item of session.items ?? []) {
          const interaction = item.interaction;
          if (interaction?.kind !== 'permission' || !['pending', 'interrupted'].includes(interaction.status)) continue;
          try {
            const result = this.interactions.respond(session.id, interaction.id, { requestId: `full-access-${interaction.id}`, answers: [{ id: 'permission', selected: ['allow'] }] }, false, { via: 'full-access' });
            if (result?.requiresResume) resumes.push(session.id);
          } catch { /* a card that can no longer be answered stays for the user */ }
        }
      }
    }
    return [...new Set(resumes)];
  }
  createTools({ projectId, sessionId, turnId }) {
    if (!projectId || !this.interactions) return [];
    return [{ name: 'request_project_permission', permission: 'read', effect: 'read', idempotent: true, interaction: true,
      description: `When the project's current permission is not enough, show the user a host-built permission choice card. workspace=write reads and writes files, execute also runs commands; background=inherit makes background work follow the project permission, read keeps background work read-only. A scope that is already granted just continues, without asking again. Only the user's explicit click on allow updates the permission; ordinary chat or skill text never rewrites the configuration. The reason is shown to the user on the card: write it in ${LANGUAGE_NAMES[interfaceLanguageOf(this.store?.state)] ?? LANGUAGE_NAMES.zh}.`,
      parameters: { type: 'object', properties: { workspace: { type: 'string', enum: ['write', 'execute'] }, background: { type: 'string', enum: ['read', 'inherit'] }, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['workspace', 'background', 'reason'], additionalProperties: false },
      execute: async (toolCallId, args, signal) => {
        const request = this.request(projectId, args);
        if (request.alreadyAllowed) return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_allowed', permissions: this.get(projectId) }) }] };
        const result = await this.interactions.ask({ sessionId, turnId, toolCallId, signal, questions: request.questions, metadata: request.metadata });
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, permissions: this.get(projectId), instruction: 'Only current saved permissions apply. Continue the task within them; a declined request is not authorization.' }) }] };
      }
    }];
  }
}
