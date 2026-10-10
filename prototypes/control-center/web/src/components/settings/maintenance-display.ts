/** Port of public/maintenance-display.js (pure presentation of /api/maintenance). */
import type { MaintenanceOperation } from '@/api/panels-types'
import { t, localized } from '@/i18n'

const plain = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
export const maintenanceTerminal = (operation?: MaintenanceOperation | null) => !operation || ['completed', 'failed', 'cancelled', 'recovery_required'].includes(operation.phase ?? '')
export const maintenanceCancellable = (operation?: MaintenanceOperation | null) => operation?.phase === 'waiting_idle'

const stageNames: Record<string, string> = localized({ prepare: '检查更新包', validate_runtime: '核对原运行版本', native_preflight: '停机前核对新运行时访问', waiting_idle: '等待工作收尾', stop: '关闭原服务', checkpoint: '创建并验证恢复点', restore: '还原恢复点', validate_target: '核对目标版本', native_preflight_start: '启动前核对新运行时访问', start: '发出启动请求', verify_successor: '核对已启动服务' })
const stageStates: Record<string, string> = localized({ running: '进行中', completed: '完成', failed: '未完成', unconfirmed: '回执未确认', interrupted: '中断', cancelled: '取消' })
const duration = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? t(' · {v} 秒', { v: ((value as number) / 1000).toFixed(1) }) : '')

export function formatMaintenanceAttemptHistory(operation?: MaintenanceOperation | null) {
  const attempts = (Array.isArray(operation?.attempts) ? operation!.attempts : []).slice(-12)
  if (!attempts.length) return ''
  const total = Number.isSafeInteger(operation!.attemptCount) ? operation!.attemptCount : attempts.length
  const lines = [t('已记录 {total} 次执行，展示最近 {length} 次；接续核对不会重复发出启动请求。', { total, length: attempts.length })]
  for (const attempt of attempts) {
    lines.push(t('第 {v} 次 · {v2}{v3}', { v: Number.isSafeInteger(attempt.number) ? attempt.number : '?', v2: stageStates[attempt.status ?? ''] ?? t('待核对'), v3: duration(attempt.elapsedMs) }))
    for (const stage of (Array.isArray(attempt.stages) ? attempt.stages : []).slice(-24)) {
      if (!stageNames[stage.name]) continue
      lines.push(`  ${stageNames[stage.name]} · ${stageStates[stage.status ?? ''] ?? t('待核对')}${duration(stage.elapsedMs)}${stage.reconciled ? t(' · 已核对迟到的启动结果') : ''}`)
      if (stage.failureType && /^[a-z_]{1,80}$/.test(stage.failureType)) lines.push(t('    失败类型：{failureType}', { failureType: stage.failureType }))
      if (stage.nativePreflight?.context === 'launchd') {
        const result = ({ passed: t('必要文件可读取'), access_denied: t('读取被系统拒绝'), failed: t('必要文件读取失败'), unconfirmed: t('原生读取回执未确认') } as Record<string, string>)[stage.nativePreflight.status ?? '']
        if (result) lines.push(t('    原生读取预检：{result}；{v}。', { result, v: stage.nativePreflight.cleanup === 'completed' ? t('探针已回收') : t('探针回收待核对') }))
      }
      if (stage.checkpoint?.phase && /^[a-z_]{1,40}$/.test(stage.checkpoint.phase)) {
        lines.push(t('    恢复点检查阶段：{phase}', { phase: stage.checkpoint.phase }))
        for (const change of (stage.checkpoint.changes ?? []).slice(0, 8)) if (/^[a-f0-9]{32}$/.test(change.pathIdentity ?? '')) lines.push(t('    文件标识 {v} · {v2}', { v: change.pathIdentity!.slice(0, 12), v2: (change.fields ?? []).filter(value => ['presence', 'order', 'device', 'inode', 'mode', 'size', 'mtime', 'ctime', 'sha256', 'file_type', 'read_length'].includes(value)).join(t('、')) || t('需要核对') }))
      }
    }
  }
  return lines.join('\n')
}

export function maintenanceQuestionHandoffDisplay(operation?: MaintenanceOperation | null) {
  const handoff = operation?.questionHandoff
  if (!handoff) return ''
  const waiting = operation!.phase === 'waiting_idle'
  if (handoff.capability === 'unsupported') return waiting ? t('旧服务不支持自动交接等待问题，仍在等待当前工作收尾。') : t('旧服务不支持自动交接等待问题，本次使用原维护流程。')
  if (handoff.capability !== 'supported') return ''
  const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0)
  const suspended = count(handoff.suspended), blocked = count(handoff.blocked)
  if (suspended) {
    if (operation!.phase === 'recovery_required') return t('已保留 {suspended} 个待答问题；维护尚待核对，暂不自动接续。', { suspended })
    if (maintenanceTerminal(operation)) return t('本次保留了 {suspended} 个待答问题，接续状态以原会话为准。', { suspended })
    return t('已保留 {suspended} 个待答问题，维护完成后可从原问题接续。', { suspended })
  }
  return waiting && blocked ? t('仍有 {blocked} 个会话需要完成当前操作，正在等待安全交接。', { blocked }) : ''
}

export function maintenanceOperationDisplay(operation?: MaintenanceOperation | null) {
  if (!operation) return { title: t('尚无维护操作'), summary: '', handoff: '', terminal: true, cancellable: false }
  const kind = ({ prepare: t('检查更新包'), backup: t('创建恢复点'), apply: t('更新应用'), rollback: t('切换应用版本'), restore: t('恢复应用数据'), cancel: t('取消等待') } as Record<string, string>)[operation.kind ?? ''] ?? t('应用维护')
  const phase = ({ waiting_idle: t('等待安全空闲'), preparing: t('正在检查'), draining: t('正在等待现有工作结束'), checkpointing: t('正在创建恢复点'), stopping: t('正在关闭服务'), offline: t('等待服务恢复'), switching: t('正在切换'), verifying: t('正在验证'), completed: t('已完成'), failed: t('未完成'), cancelled: t('已取消'), recovery_required: t('需要核对恢复状态') } as Record<string, string>)[operation.phase ?? ''] ?? t('正在处理')
  return { title: `${kind} · ${phase}`, summary: plain(operation.summary), handoff: maintenanceQuestionHandoffDisplay(operation), terminal: maintenanceTerminal(operation), cancellable: maintenanceCancellable(operation) }
}
