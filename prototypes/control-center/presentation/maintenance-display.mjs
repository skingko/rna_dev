const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
// Every text function takes an optional interface language as its last argument ('en' reads English; anything else, and
// leaving it out, is the Chinese the workbench port in web/src/components/settings/maintenance-display.ts is held equal to).
const pick = (language, zh, en) => (language === 'en' ? en : zh);
const pickOf = (language, pair) => pick(language, pair[0], pair[1]);
export const maintenanceTerminal = operation => !operation || ['completed', 'failed', 'cancelled', 'recovery_required'].includes(operation.phase);
export const maintenanceCancellable = operation => operation?.phase === 'waiting_idle';
const stageNames = { prepare: ['检查更新包', 'Check the update package'], validate_runtime: ['核对原运行版本', 'Verify the current runtime'], native_preflight: ['停机前核对新运行时访问', 'Check new runtime access before stopping'], waiting_idle: ['等待工作收尾', 'Wait for work to wrap up'], stop: ['关闭原服务', 'Stop the current service'], checkpoint: ['创建并验证恢复点', 'Create and verify a recovery point'], restore: ['还原恢复点', 'Restore the recovery point'], validate_target: ['核对目标版本', 'Verify the target version'], start: ['发出启动请求', 'Send the start request'], verify_successor: ['核对已启动服务', 'Verify the started service'] };
const stageStates = { running: ['进行中', 'in progress'], completed: ['完成', 'completed'], failed: ['未完成', 'not completed'], unconfirmed: ['回执未确认', 'receipt unconfirmed'], interrupted: ['中断', 'interrupted'], cancelled: ['取消', 'cancelled'] };
const stageStateOf = (language, status) => pickOf(language, stageStates[status] ?? ['待核对', 'to be checked']);
const duration = (value, language) => Number.isSafeInteger(value) && value >= 0 ? ` · ${(value / 1000).toFixed(1)}${pick(language, ' 秒', ' s')}` : '';
const preflightResults = { passed: ['必要文件可读取', 'required files are readable'], access_denied: ['读取被系统拒绝', 'read denied by the system'], failed: ['必要文件读取失败', 'reading the required files failed'], unconfirmed: ['原生读取回执未确认', 'native read receipt unconfirmed'] };
export function formatMaintenanceAttemptHistory(operation, language) {
  const attempts = (Array.isArray(operation?.attempts) ? operation.attempts : []).slice(-12); if (!attempts.length) return '';
  const total = Number.isSafeInteger(operation.attemptCount) ? operation.attemptCount : attempts.length;
  const lines = [pick(language, `已记录 ${total} 次执行，展示最近 ${attempts.length} 次；接续核对不会重复发出启动请求。`, `${total} runs recorded, showing the latest ${attempts.length}; a follow-up check never sends the start request again.`)];
  for (const attempt of attempts) {
    const number = Number.isSafeInteger(attempt.number) ? attempt.number : '?';
    lines.push(`${pick(language, `第 ${number} 次`, `Run ${number}`)} · ${stageStateOf(language, attempt.status)}${duration(attempt.elapsedMs, language)}`);
    for (const stage of (Array.isArray(attempt.stages) ? attempt.stages : []).slice(-24)) {
      if (!stageNames[stage.name]) continue;
      lines.push(`  ${pickOf(language, stageNames[stage.name])} · ${stageStateOf(language, stage.status)}${duration(stage.elapsedMs, language)}${stage.reconciled ? pick(language, ' · 已核对迟到的启动结果', ' · the late start result was reconciled') : ''}`);
      if (stage.failureType && /^[a-z_]{1,80}$/.test(stage.failureType)) lines.push(`    ${pick(language, '失败类型：', 'Failure type: ')}${stage.failureType}`);
      if (stage.nativePreflight?.context === 'launchd') {
        const result = preflightResults[stage.nativePreflight.status];
        if (result) lines.push(pick(language, `    原生读取预检：${result[0]}；${stage.nativePreflight.cleanup === 'completed' ? '探针已回收' : '探针回收待核对'}。`, `    Native read preflight: ${result[1]}; ${stage.nativePreflight.cleanup === 'completed' ? 'the probe was cleaned up' : 'probe cleanup is still to be checked'}.`));
      }
      if (stage.checkpoint?.phase && /^[a-z_]{1,40}$/.test(stage.checkpoint.phase)) {
        lines.push(`    ${pick(language, '恢复点检查阶段：', 'Recovery point check phase: ')}${stage.checkpoint.phase}`);
        for (const change of (stage.checkpoint.changes ?? []).slice(0, 8)) if (/^[a-f0-9]{32}$/.test(change.pathIdentity ?? '')) lines.push(`    ${pick(language, '文件标识', 'File identity')} ${change.pathIdentity.slice(0, 12)} · ${(change.fields ?? []).filter(value => ['presence', 'order', 'device', 'inode', 'mode', 'size', 'mtime', 'ctime', 'sha256', 'file_type', 'read_length'].includes(value)).join(pick(language, '、', ', ')) || pick(language, '需要核对', 'needs checking')}`);
      }
    }
  }
  return lines.join('\n');
}
export function maintenanceQuestionHandoffDisplay(operation, language) {
  const handoff = operation?.questionHandoff; if (!handoff) return '';
  const waiting = operation.phase === 'waiting_idle';
  if (handoff.capability === 'unsupported') return waiting
    ? pick(language, '旧服务不支持自动交接等待问题，仍在等待当前工作收尾。', 'The old service cannot hand over waiting questions automatically; it is still waiting for current work to wrap up.')
    : pick(language, '旧服务不支持自动交接等待问题，本次使用原维护流程。', 'The old service cannot hand over waiting questions automatically; this run used the original maintenance flow.');
  if (handoff.capability !== 'supported') return '';
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const suspended = count(handoff.suspended), blocked = count(handoff.blocked);
  if (suspended) {
    if (operation.phase === 'recovery_required') return pick(language, `已保留 ${suspended} 个待答问题；维护尚待核对，暂不自动接续。`, `${suspended} waiting questions were kept; maintenance still needs checking, so they are not resumed automatically.`);
    if (maintenanceTerminal(operation)) return pick(language, `本次保留了 ${suspended} 个待答问题，接续状态以原会话为准。`, `This run kept ${suspended} waiting questions; whether they resumed is shown in the original conversation.`);
    return pick(language, `已保留 ${suspended} 个待答问题，维护完成后可从原问题接续。`, `${suspended} waiting questions were kept; after maintenance finishes they can continue from the original question.`);
  }
  return waiting && blocked ? pick(language, `仍有 ${blocked} 个会话需要完成当前操作，正在等待安全交接。`, `${blocked} conversations still need to finish their current step; waiting for a safe handover.`) : '';
}
const operationKinds = { prepare: ['检查更新包', 'Check the update package'], backup: ['创建恢复点', 'Create a recovery point'], apply: ['更新应用', 'Update the app'], rollback: ['切换应用版本', 'Switch the app version'], restore: ['恢复应用数据', 'Restore app data'], cancel: ['取消等待', 'Cancel the wait'] };
const operationPhases = { waiting_idle: ['等待安全空闲', 'Waiting for a safe idle moment'], preparing: ['正在检查', 'Checking'], draining: ['正在等待现有工作结束', 'Waiting for current work to end'], checkpointing: ['正在创建恢复点', 'Creating a recovery point'], stopping: ['正在关闭服务', 'Stopping the service'], offline: ['等待服务恢复', 'Waiting for the service to come back'], switching: ['正在切换', 'Switching'], verifying: ['正在验证', 'Verifying'], completed: ['已完成', 'Completed'], failed: ['未完成', 'Not completed'], cancelled: ['已取消', 'Cancelled'], recovery_required: ['需要核对恢复状态', 'Recovery state needs checking'] };
export function maintenanceOperationDisplay(operation, language) {
  if (!operation) return { title: pick(language, '尚无维护操作', 'No maintenance operation yet'), summary: '', handoff: '', terminal: true, cancellable: false };
  const kind = pickOf(language, operationKinds[operation.kind] ?? ['应用维护', 'App maintenance']);
  const phase = pickOf(language, operationPhases[operation.phase] ?? ['正在处理', 'Working']);
  return { title: `${kind} · ${phase}`, summary: plain(operation.summary), handoff: maintenanceQuestionHandoffDisplay(operation, language), terminal: maintenanceTerminal(operation), cancellable: maintenanceCancellable(operation) };
}
export function formatMaintenanceStatus(state = {}, language) {
  const current = state.current ?? {}, operation = maintenanceOperationDisplay(state.operation, language), lines = [
    `Rna Agent ${plain(current.hostVersion) || pick(language, '版本待确认', 'version to be confirmed')} · SDK ${plain(current.sdkVersion) || pick(language, '待确认', 'to be confirmed')}`,
    state.held ? pick(language, '维护中，暂不启动新工作。', 'Maintenance is in progress; new work is not started.') : state.busy ? pick(language, '工作正在进行；需要停机的维护等待安全空闲。', 'Work is in progress; maintenance that needs a stop waits for a safe idle moment.') : pick(language, '当前空闲。', 'Idle right now.'),
    operation.title,
  ];
  if (operation.summary) lines.push(operation.summary);
  if (operation.handoff) lines.push(operation.handoff);
  if (state.operation?.id) lines.push(`${pick(language, '操作 ID：', 'Operation ID: ')}${plain(state.operation.id)}`);
  if (state.operation?.errorCode) lines.push(`${pick(language, '诊断：', 'Diagnostic: ')}${plain(state.operation.errorCode)}`);
  const attempts = formatMaintenanceAttemptHistory(state.operation, language); if (attempts) lines.push(attempts);
  const candidates = Array.isArray(state.candidates) ? state.candidates : [], checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  lines.push(pick(language, `已检查应用版本 ${candidates.length} 个 · 本机恢复点 ${checkpoints.length} 个`, `${candidates.length} app versions checked · ${checkpoints.length} recovery points on this machine`));
  for (const entry of candidates) lines.push(`  ${pick(language, '应用', 'App')} ${plain(entry.hostVersion)} / SDK ${plain(entry.sdkVersion)} · ${plain(entry.id)}`);
  for (const entry of checkpoints) lines.push(`  ${pick(language, '恢复点', 'Recovery point')} ${plain(entry.id)} · ${plain(entry.createdAt)} · ${entry.verified === true ? pick(language, '已验证', 'verified') : pick(language, '尚未验证', 'not verified yet')}`);
  lines.push(pick(language, '应用版本切换不回滚项目进化版本；恢复点不包含项目目录与远端记忆。', 'Switching the app version does not roll back project evolution versions; a recovery point does not include project directories or remote memory.'));
  return lines.join('\n');
}
