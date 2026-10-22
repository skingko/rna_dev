/**
 * 进化观测 — what the evolution measured about itself (P2 batch D, D3; the system review's "why nothing happened"): where each
 * lane is, what every rule was run or shown for, what became of lessons and corrections that did not turn into a rule,
 * how the work fared across generations, a prediction scoreboard (rrsi loop.py:159-176), the scheduled work's outcomes
 * and the last contrast analyses. Counts and codes only; read once when opened (GET …/genes/observability).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { genesApi, type EvolutionStatus, type GeneObservability } from '@/api/genes-api'
import { relativeTime, formatPercent } from '@/lib/format'
import { fullTime } from './kit'
import { t, localized } from '@/i18n'

/** One short line per lane, in the page's own words: what each is waiting for. */
export function laneLines(status: EvolutionStatus['status']): string[] {
  const { A, B, C } = status
  return [
    A.state === 'due' ? (A.retrying ? t('经验转做法：{n} 条待处理，其中 {m} 条稍后重试', { n: A.due, m: A.retrying }) : t('经验转做法：{n} 条待处理', { n: A.due })) : t('经验转做法：没有待办'),
    B.state === 'idle' ? t('纠正复核：没有待办') : B.state === 'cooldown' ? t('纠正复核：{n} 条排队，写做法冷却中', { n: B.queued }) : t('纠正复核：{n} 条排队', { n: B.queued }),
    C.state === 'due' ? t('对照分析：可以运行') : C.state === 'spaced' ? (C.nextAt ? t('对照分析：刚跑过，{when} 之后再看', { when: fullTime(C.nextAt) }) : t('对照分析：刚跑过')) : t('对照分析：问题 {trouble}/{needed}，攒够了才跑', { trouble: C.trouble, needed: C.needed }),
  ]
}

/**
 * The gene lanes' state for a rhythm card (EVO-12): what each lane waits for, in place of the retired whole-genome learning
 * lane's quota and "no candidate guaranteed" wording. null until read (or without a host to ask: a preview, a test).
 */
export function useEvolutionLanes(projectId: string | undefined): EvolutionStatus | null {
  const [status, setStatus] = useState<EvolutionStatus | null>(null)
  useEffect(() => {
    if (!projectId) return
    let live = true
    try { void genesApi.status(projectId).then(value => { if (live) setStatus(value) }).catch(() => { /* the card reads without it */ }) } catch { /* no transport */ }
    return () => { live = false }
  }, [projectId])
  return status
}
/** The card's 进化 row: the card's own words when the user switched evolution off, the lanes' state otherwise (— until they are read; a short line when background evolution is not running). */
export const evolutionRowValue = (off: boolean, offText: string | undefined, lanes: EvolutionStatus | null): string => off ? offText ?? '—' : !lanes ? '—' : lanes.enabled ? laneLines(lanes.status).join(' · ') : t('进化已关闭，已有的规则照常起作用。')
const CODES: Record<string, string> = localized({
  guard: '检查', practice: '做法', covered: '已有规则覆盖', profile_only: '只留在画像里', conflicts_rule: '与现有规则冲突', author_skipped: '作者认为不必写', rejected: '没通过审查', schedule: '改成了日程邀请', retired: '规则已停用',
  judged_no: '不是做法问题', source_gone: '来源已删除', no_target: '没有可写入的技能', no_judge: '判断服务暂时不可用', author_error: '写作模型暂时不可用', interrupted: '被重启打断', guard_cap: '检查位已满',
  author_failed: '改写没有完成', replace_unavailable: '要替换的内容变了', commit_failed: '保存失败', not_routed: '还没处理', awaiting_confirmation: '等你确认', to_write: '等着写成做法',
  contradicted: '被你后来说的推翻了', superseded: '被更新的经验取代', revoked: '你撤销了', expired: '到期了',
  undone: '合并被撤销', dropped: '你说不再用', lesson_revoked: '来源经验被撤销', lesson_rewritten: '来源经验被改写', source_removed: '来源已不在', skill_withdrawn: '所在技能已停用', repeat: '与别的规则重复', replaced: '被新写法取代', unrecorded: '没有记录',
  review_failed: '复审没通过', smoke_failed: '程序检查没通过', invalid_tool: '检查脚本不合规', run_failed: '在现有文件上跑不起来',
})
const KINDS: Record<string, string> = localized({ gene: '成了规则', terminal: '已有定论', retryable: '稍后重试', pending: '还在等' })
const OUTCOMES: Record<string, string> = localized({ corrected: '被纠正', disliked: '被点了踩', approved: '被认可', accepted: '被接受', unanswered: '没人回应', undone: '被撤销', failed: '失败', infra: '服务故障', pending: '进行中', none: '没有结果' })
const VERDICTS: Record<string, string> = localized({ held: '之后没再被纠正', again: '之后又被纠正过', pending: '还没有结果' })
const code = (value: string) => CODES[value] ?? value
const counts = (group: Record<string, number> | undefined) => Object.entries(group ?? {}).map(([name, n]) => `${code(name)} ${n}`).join(t('、'))

export function Observability({ projectId }: { projectId: string }) {
  const [view, setView] = useState<GeneObservability | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    genesApi.observability(projectId).then(value => { if (live) { setView(value); setError(null) } }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [projectId])
  if (error) return <p className="text-fg-4">{t('进化观测暂时读不到：{message}', { message: error })}</p>
  if (!view) return <p className="text-fg-4">{t('读取中…')}</p>
  const block = (title: string, children: ReactNode) => <section className="mt-3"><h3 className="mb-1 text-[12px] font-medium text-fg-3">{title}</h3>{children}</section>
  const lessons = view.dispositions.lessons, corrections = view.dispositions.corrections, fates = view.dispositions.genes
  const kindLines = (group: Record<string, Record<string, number>>) => Object.entries(group).filter(([, row]) => Object.keys(row).length).map(([kind, row]) => <li key={kind}>{t('{kind}：{items}', { kind: KINDS[kind] ?? kind, items: counts(row) })}</li>)
  const percent = (value: number | null | undefined) => formatPercent(value ?? null)
  return (
    <div className="space-y-1 text-[12.5px] leading-[1.7]">
      {view.notes.length > 0 && <ul className="mt-2 space-y-0.5 rounded-lg bg-subtle px-3 py-2 text-fg-2">{view.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      {block(t('各条线现在'), <ul className="space-y-0.5">{laneLines(view.status).map(line => <li key={line}>{line}</li>)}</ul>)}
      {view.genes.length > 0 && block(t('每条规则被用到多少'), (
        <ul className="space-y-0.5">{view.genes.slice(0, 20).map(row => (
          <li key={row.id}><span className="text-fg-2">{row.title}</span>{' · '}{row.layer === 'guard'
            ? (!row.ran ? t('还没运行过') : row.ranRecent === null || row.ranRecent === undefined ? t('运行 {ran} 次，确认 {real} 处真问题', { ran: row.ran, real: row.real }) : t('运行 {ran} 次，最近 7 天 {recent} 次，确认 {real} 处真问题', { ran: row.ran, recent: row.ranRecent, real: row.real }))
            : row.shown !== null && row.shown !== undefined ? t('放进回合 {shown} 次（最近 7 天 {recent} 个回合），照着做 {applied} 次', { shown: row.shown, recent: row.injectedRecent ?? 0, applied: row.applied }) : t('还没有放进过回合的记录')}{row.layer !== 'guard' && row.inRuns ? <>{' · '}{t('后台运行读到 {runs} 次（没人评价）', { runs: row.inRuns })}</> : null}</li>
        ))}</ul>
      ))}
      {block(t('经验的去向'), Object.values(lessons.counts).some(row => Object.keys(row).length) ? <ul className="space-y-0.5">{kindLines(lessons.counts)}</ul> : <p className="text-fg-4">{t('还没有经验走到这一步')}</p>)}
      {Object.values(corrections.counts).some(row => Object.keys(row).length) && block(t('纠正的去向'), <ul className="space-y-0.5">{kindLines(corrections.counts)}</ul>)}
      {[fates?.retired, fates?.rejected, fates?.retryable].some(row => Object.keys(row ?? {}).length) && block(t('不再起作用的做法'), (
        <ul className="space-y-0.5">
          {Object.keys(fates.retired).length > 0 && <li>{t('{kind}：{items}', { kind: t('已停用'), items: counts(fates.retired) })}</li>}
          {Object.keys(fates.rejected).length > 0 && <li>{t('{kind}：{items}', { kind: t('没通过'), items: counts(fates.rejected) })}</li>}
          {Object.keys(fates.retryable).length > 0 && <li>{t('{kind}：{items}', { kind: t('稍后重试'), items: counts(fates.retryable) })}</li>}
        </ul>
      ))}
      {view.generations.length > 0 && block(t('每一代之后，被纠正的比例'), (
        <ul className="space-y-0.5">{view.generations.slice(0, 8).map(row => (
          <li key={row.n}><span className="tabular-nums text-fg-4">{t('第 {n} 代', { n: row.n })}</span>{' · '}{row.known ? t('{bad}/{known} 被纠正（{rate}）', { bad: row.bad, known: row.known, rate: percent(row.rate) }) : t('还没有反馈')}{row.before?.known ? ` ← ${percent(row.before.rate)}` : ''}</li>
        ))}</ul>
      ))}
      {view.scoreboard.length > 0 && block(t('做法的预测记分板'), (
        <ul className="space-y-1">{view.scoreboard.slice(0, 10).map(row => (
          <li key={row.geneId}><span className="text-fg-2">{row.title}</span>{' · '}{VERDICTS[row.verdict] ?? row.verdict}
            {row.scope.kind === 'schedule' && row.before && row.after ? <span className="text-fg-4">{' · '}{t('同一个定时任务前 {b1}/{b2}，后 {a1}/{a2} 被纠正', { b1: row.before.bad, b2: row.before.known, a1: row.after.bad, a2: row.after.known })}</span> : null}
            {row.expectation ? <span className="block text-fg-4">{t('预期：{expectation}', { expectation: row.expectation })}</span> : null}</li>
        ))}</ul>
      ))}
      {view.harm.length > 0 && block(t('做法出现前后，同一个定时任务'), (
        <ul className="space-y-0.5">{view.harm.slice(0, 8).map(row => (
          <li key={row.geneId}><span className="text-fg-2">{row.title}</span>{' · '}{t('被纠正 {before} → {after}（对照 {shared} 对）', { before: percent(row.before.rate), after: percent(row.after.rate), shared: row.shared })}{row.state === 'invited' ? ` · ${t('已邀请你决定')}` : row.state === 'watching' ? ` · ${t('观察中')}` : ''}</li>
        ))}</ul>
      ))}
      {view.outcomes.total > 0 && block(t('后台和定时任务的结果'), (
        <>
          <p>{Object.entries(view.outcomes.byOutcome).map(([name, n]) => `${OUTCOMES[name] ?? name} ${n}`).join(t('、'))}</p>
          {view.outcomes.schedules.length > 0 && <ul className="mt-0.5 space-y-0.5 text-fg-4">{view.outcomes.schedules.slice(0, 6).map(row => <li key={row.scheduleId}>{t('{title}：{n} 次，最近 {when}', { title: row.title ?? row.scheduleId, n: row.occurrences, when: row.latestAt ? relativeTime(row.latestAt) : '—' })}</li>)}</ul>}
        </>
      ))}
      {view.bloat.ratio !== null && view.bloat.rules.length > 0 && block(t('提示词膨胀'), <p>{t('提示词是起点的 {ratio}%，{n} 条技能做法被放进回合很多次却没被照着做（达到 {min} 条才会触发整理）', { ratio: Math.round(view.bloat.ratio * 100), n: view.bloat.rules.filter(row => row.unproven).length, min: view.bloat.minimum })}</p>)}
      {view.contrasts.length > 0 && block(t('最近的对照分析'), (
        <ul className="space-y-0.5">{view.contrasts.slice(0, 6).map(row => (
          <li key={row.at}><span className="text-fg-4">{relativeTime(row.at)}</span>{' · '}{row.analyzed ? t('{turns} 轮，问题 {trouble}，配对 {pairs}，写了 {patches} 条做法', { turns: row.turns, trouble: row.trouble, pairs: row.pairs ?? 0, patches: row.committed ?? 0 }) : t('没有得出结果')}</li>
        ))}</ul>
      ))}
    </div>
  )
}
