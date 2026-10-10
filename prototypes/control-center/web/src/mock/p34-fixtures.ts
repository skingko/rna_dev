/* Mock fixtures for P3 (inbox, delivery feedback, handoffs) and P4
   (RRSI evolution, signals, failures, task types, skill screening, system). */
import type { InboxEntry } from '@/api/communication-api'
import type { ChangelogEntry, ComponentRow, InteractionSignals, RrsiHistory, SystemEvolution } from '@/api/evolution-api'
import type { SkillScreening, VersionRecord } from '@/api/project-api'
import { ago } from './fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/* ------------------------------------------------------------------ P3 */

/** Oldest first, like `project.inbox` on the host. */
export const inbox = (): InboxEntry[] => [
  { id: 'ibx-5', actionId: 'act-ask-0', kind: 'ask', tier: 'inline', requestedTier: 'inbox', reachReasons: ['ask_in_conversation'], text: '低端机上要不要默认关闭芦苇的动态阴影？可以换来约 8fps。', sessionId: 's-ui', interactionId: 'q-old', createdAt: ago(3 * DAY), status: 'dismissed', readAt: ago(3 * DAY - HOUR), dismissedAt: ago(3 * DAY - HOUR), feedback: { outcome: 'dismissed', at: ago(3 * DAY - HOUR), windowMs: 12 * HOUR } },
  { id: 'ibx-4', actionId: 'act-share-0', kind: 'share', tier: 'inline', requestedTier: 'notify', reachReasons: ['desktop_notifications_off'], text: '构建产物体积比上周大了 12%，主要来自未压缩的纸纹理。', sessionId: 's-ui', itemId: 'gone', createdAt: ago(2 * DAY), status: 'read', readAt: ago(2 * DAY - 2 * HOUR), feedback: { outcome: 'ignored', at: ago(2 * DAY - 12 * HOUR), windowMs: 12 * HOUR } },
  { id: 'ibx-d1', actionId: 'act-d1', kind: 'share', tier: 'digest', requestedTier: 'inbox', reachReasons: ['jev_lowered'], text: '芦苇穗头贴图在 Redmi 9 上降到 41fps，主要开销在透明排序。', sessionId: 's-ui', createdAt: ago(14 * HOUR), status: 'read', readAt: ago(15 * MIN), digestedAt: ago(20 * MIN), digestItemId: 'digest-1', feedback: { outcome: 'replied', at: ago(12 * MIN), windowMs: 2 * DAY } },
  { id: 'ibx-d2', actionId: 'act-d2', kind: 'share', tier: 'digest', requestedTier: 'digest', text: '`docs/tool-row-spec.md` 新增后，工具行合并规则与实现一致。', sessionId: 's-ui', createdAt: ago(11 * HOUR), status: 'read', readAt: ago(15 * MIN), digestedAt: ago(20 * MIN), digestItemId: 'digest-1', feedback: null },
  { id: 'ibx-d3', actionId: 'act-d3', kind: 'share', tier: 'digest', requestedTier: 'digest', text: '昨晚的依赖更新没有引入新的构建警告。', sessionId: 's-ui', createdAt: ago(9 * HOUR), status: 'read', readAt: ago(15 * MIN), digestedAt: ago(20 * MIN), digestItemId: 'digest-1', feedback: null },
  // The second digest carries structured fields (`lines`), so the card does not parse text.
  { id: 'ibx-d4', actionId: 'act-d4', kind: 'share', tier: 'digest', requestedTier: 'digest', text: '构建产物里有两张重复的纸纹理，合并后可再省约 180KB。', sessionId: 's-ui', createdAt: ago(7 * HOUR), status: 'read', readAt: ago(15 * MIN), digestedAt: ago(19 * MIN), digestItemId: 'digest-2', feedback: null },
  { id: 'ibx-d5', actionId: 'act-d5', kind: 'share', tier: 'digest', requestedTier: 'digest', text: '芦苇动态阴影的开关已按上次的反馈默认关闭。', sessionId: 's-ui', createdAt: ago(6 * HOUR), status: 'read', readAt: ago(15 * MIN), digestedAt: ago(19 * MIN), digestItemId: 'digest-2', feedback: null },
  { id: 'ibx-1', actionId: 'act-share-1', kind: 'share', tier: 'inline', requestedTier: 'inline', text: '**每日检查点**：今天的回归测试 16/16 全部通过，界面重设计后没有发现新的布局问题。移动端长路径在 390px 宽度下会截断到文件名，符合预期。\n\n暂时没有需要你决定的事项。', sessionId: 's-ui', itemId: 'pro-1', createdAt: ago(18 * MIN), status: 'read', readAt: ago(17 * MIN), scheduled: true, feedback: { outcome: 'acted', at: ago(10 * MIN), windowMs: 12 * HOUR } },
  { id: 'ibx-3', actionId: 'act-share-3', kind: 'share', tier: 'inbox', requestedTier: 'inbox', text: '整理了 v12 以来的性能样本：iPhone 12 稳定 60fps；Redmi 9 在芦苇密集区降至 41fps，关闭穗头透明排序后回到 52fps。不急，等你有空再看。', sessionId: 's-research', createdAt: ago(40 * MIN), status: 'unread', feedback: null },
  { id: 'ibx-6', actionId: 'act-share-6', kind: 'share', tier: 'digest', requestedTier: 'digest', text: '音效资源里有两个未被引用的 ogg 文件，可以在下次清理时删除。', sessionId: 's-ui', createdAt: ago(8 * MIN), status: 'unread', heldForDigest: true, feedback: null },
  { id: 'ibx-2', actionId: 'act-share-2', kind: 'share', tier: 'notify', requestedTier: 'notify', text: '**HUD 分数在 390px 下被芦苇遮挡**：后台截图显示分数印章与前景芦苇重叠，建议把 HUD 层级提到芦苇之上（`z-index: 30`）。需要我直接修改吗？', sessionId: 's-ui', itemId: 'pro-2', createdAt: ago(6 * MIN), status: 'unread', notifiedAt: ago(6 * MIN), feedback: null },
]

export const handoffs: Record<string, string> = {
  'act-work-2': '已采样 3 台设备的帧率；剩余低端机的穗头透明排序对比未做；数据在 docs/perf-notes.md；下一步先关闭透明排序复测 Redmi 9。',
  'act-review-1': '结果待核对（interrupted_tool）：批量替换旧贴图引用；有外部操作结果未确认，下一步先核对副作用再明确确认，不要重放。',
}

/* ------------------------------------------------------------------ P4 */

export const taskTypes = { explicit: false, taskTypes: ['coding', 'design'] as string[] }

export const screening: SkillScreening = {
  method: 'market_screen_v1', taskTypes: ['coding', 'design'],
  review: { status: 'completed', candidates: 3 },
  areas: [
    { id: 'coding-1', taskType: 'coding', query: 'code review testing', candidates: 8, screenSource: 'judge', fit: 2, reviewFit: 1, rejected: 5, selected: [{ skillId: 'skill-frontend-design', status: 'installed' }] },
    { id: 'design-1', taskType: 'design', query: 'frontend design', candidates: 6, screenSource: 'judge', fit: 1, reviewFit: 0, rejected: 4, selected: [{ skillId: 'skill-art-direction-readability', status: 'installed' }] },
    { id: 'design-2', taskType: 'design', query: 'design review accessibility', candidates: 4, screenSource: 'judge', fit: 0, reviewFit: 0, rejected: 3, selected: [], gap: 'screened_out' },
  ],
}

/** RRSI additions merged into the existing version fixtures. */
export const versionPatches: Record<string, Partial<VersionRecord>> = {
  v12: {
    rrsi: {
      round: 3, editBudget: 2,
      edits: [{ editId: 'e-12-1', key: 'skill:hud-layer-check', component: 'skill', change: 'added', hypothesis: '截图前先检查 HUD 层级，能避免两次因芦苇遮挡导致的返工。' }],
      tiers: [{ tier: 'critic', status: 'passed' }, { tier: 'prescreen', status: 'passed' }, { tier: 'smoke', status: 'passed', cases: 3 }, { tier: 'full', status: 'passed', cases: 5 }],
      prescore: { source: 'judge', better: true, probability: 0.72, expectedGain: 0.06 },
      selection: { admissible: true, enforced: false, reason: 'improvement exceeds minDelta; cost increase covered by gain', deltaS: 0.087, deltaC: 0.06, delta: null, blended: { score: null, sufficientReal: false, real: null, jev: 0.72, weights: { real: 0.8, jev: 0.2 } } },
    },
    genomeGit: { branch: 'cand/v12', base: '9c1e2f0a7b', commit: '4f7a1c9e2d', diffStat: ' skills/hud-layer-check/SKILL.md | 18 ++++++++++++++++++\n 1 file changed, 18 insertions(+)' },
  },
  v11: {
    rrsi: {
      round: 1, editBudget: 4,
      edits: [{ editId: 'e-11-1', key: 'skill:art-readability', component: 'skill', change: 'added', hypothesis: '把可读性审计加入交付前检查可以减少返工。' }, { editId: 'e-11-2', key: 'system_section:delivery', component: 'system_section', change: 'modified', hypothesis: '交付说明先给结论、再给验证证据。' }],
      tiers: [{ tier: 'critic', status: 'passed' }, { tier: 'full', status: 'passed', cases: 5 }],
      prescore: null,
      selection: { admissible: true, enforced: true, reason: 'ΔS above noise band', deltaS: 0.092, deltaC: 0.04, delta: 0.021, blended: { score: 0.781, sufficientReal: true, real: 0.77, jev: 0.8, weights: { real: 0.8, jev: 0.2 } } },
    },
    genomeGit: { branch: 'cand/v11', base: '1a2b3c4d5e', commit: '9c1e2f0a7b', diffStat: ' SYSTEM.md                        |  4 ++--\n skills/art-readability/SKILL.md | 32 ++++++++++++++++++++++++++++++++\n 2 files changed, 34 insertions(+), 2 deletions(-)' },
  },
}

export const extraVersions: VersionRecord[] = [
  {
    id: 'v15', version: 'candidate-15', title: '在评测用例描述中直接写入期望输出', state: 'rejected', parentVersionId: 'v11', createdAt: ago(90 * MIN), simulated: false,
    proposal: { hypothesis: '让候选记住评测用例的标准答案可以提高得分。' },
    error: { message: '评测前审查发现针对用例的投机。', ...({ code: 'critic_rejected' } as object) },
    assessment: { category: 'rrsi_screened', label: '进化筛选未通过', summary: '评测前审查发现针对用例的投机、无效编辑、超出编辑预算或重复已被证伪的假设，未花费评测。', stage: 'proposal' },
    rrsi: {
      round: 4, editBudget: 1,
      edits: [{ editId: 'e-15-1', key: 'evaluation_standard:cases', component: 'evaluation_standard', change: 'modified', hypothesis: '让候选记住评测用例的标准答案可以提高得分。' }, { editId: 'e-15-2', key: 'system_section:output', component: 'system_section', change: 'modified', hypothesis: '输出前复述用例标题。' }],
      tiers: [{ tier: 'critic', status: 'failed', reason: 'case_leakage' }],
      critic: { verdict: 'reject', reasons: [{ code: 'case_leakage', message: '新增内容复制了冻结评测用例（hud_readability）的标识或原文，属于针对用例的投机。' }, { code: 'budget_exceeded', message: '候选包含 2 个组件编辑，超过本轮预算 1。' }] },
      prescore: null, selection: null,
    },
  },
  {
    id: 'v16', version: 'candidate-16', title: '节奏调整：周期交付期间暂停复盘', state: 'failed', parentVersionId: 'v11', createdAt: ago(50 * MIN), simulated: false,
    error: { message: '候选生成模型返回的 JSON 不符合结构。', ...({ code: 'invalid_submission', diagnostic: { phase: 'proposal', kind: 'invalid_json' } } as object) },
    assessment: { label: '候选生成失败', summary: '提议模型没有交付有效候选；未进入评测。', stage: 'proposal' },
  },
]

export const changelog: ChangelogEntry[] = [
  { at: ago(5 * DAY - HOUR), versionId: 'v11', key: 'skill:art-readability', component: 'skill', label: '技能', verdict: 'trial_adopted', title: 'Rna 学到了：把可读性审计加入交付前检查可以减少返工。', detail: '技能「美术可读性审计」新增，得分变化 +0.092' },
  { at: ago(5 * DAY - HOUR), versionId: 'v11', key: 'system_section:delivery', component: 'system_section', label: '系统提示段落', verdict: 'trial_adopted', title: 'Rna 学到了：交付说明先给结论、再给验证证据。', detail: '系统提示段落「Delivery」调整，得分变化 +0.092' },
  { at: ago(20 * HOUR), versionId: 'v12', key: 'skill:hud-layer-check', component: 'skill', label: '技能', verdict: 'accepted', title: 'Rna 学到了：截图前先检查 HUD 层级，能避免两次因芦苇遮挡导致的返工。', detail: '技能「HUD 层级检查」新增，得分变化 +0.087' },
  { at: ago(6 * HOUR), versionId: 'v13', key: 'system_section:pixel-metrics', component: 'system_section', label: '系统提示段落', verdict: 'rejected', title: 'Rna 验证后没有采用：模型无法直接看到像素时，用确定性像素指标代替主观判断。', detail: '系统提示段落「Pixel metrics」新增，得分变化 -0.045' },
].reverse()

export const components = (): ComponentRow[] => [
  { key: 'system_section:role', component: 'system_section', componentLabel: '系统提示段落', label: '角色与约定', attempts: 0, accepted: 0, lastVerdict: null, pruneCandidate: false, history: [] },
  { key: 'system_section:delivery', component: 'system_section', componentLabel: '系统提示段落', label: 'Delivery', attempts: 1, accepted: 1, lastVerdict: 'trial_adopted', pruneCandidate: false, history: [
    { t: 1, at: ago(5 * DAY), versionId: 'v11', verdict: 'accepted', hypothesis: '交付说明先给结论、再给验证证据。', deltaS: 0.092, change: 'modified' },
    { t: 2, at: ago(5 * DAY - HOUR), versionId: 'v11', verdict: 'trial_adopted', hypothesis: '交付说明先给结论、再给验证证据。', deltaS: 0.092, change: 'modified' },
  ] },
  { key: 'system_section:pixel-metrics', component: 'system_section', componentLabel: '系统提示段落', label: 'Pixel metrics', attempts: 1, accepted: 0, lastVerdict: 'rejected', pruneCandidate: false, history: [
    { t: 3, at: ago(6 * HOUR), versionId: 'v13', verdict: 'rejected', hypothesis: '模型无法直接看到像素时，用确定性像素指标代替主观判断。', deltaS: -0.045, change: 'added' },
  ] },
  { key: 'skill:art-readability', component: 'skill', componentLabel: '技能', label: '美术可读性审计', attempts: 2, accepted: 2, lastVerdict: 'trial_adopted', pruneCandidate: false, history: [
    { t: 1, at: ago(5 * DAY), versionId: 'v11', verdict: 'accepted', hypothesis: '把可读性审计加入交付前检查可以减少返工。', deltaS: 0.092, change: 'added' },
    { t: 2, at: ago(5 * DAY - HOUR), versionId: 'v11', verdict: 'trial_adopted', hypothesis: '把可读性审计加入交付前检查可以减少返工。', deltaS: 0.092, change: 'added' },
  ] },
  { key: 'skill:threejs-ink-prototype', component: 'skill', componentLabel: '技能', label: 'Three.js 水墨原型实现', attempts: 4, accepted: 0, lastVerdict: 'rejected', pruneCandidate: true, history: [
    { t: 0, at: ago(8 * DAY), versionId: 'v10', verdict: 'rejected', hypothesis: '把着色器参数写成表格便于复用。', deltaS: -0.01, change: 'modified' },
  ] },
  { key: 'tool_description:ink_score_validator', component: 'tool_description', componentLabel: '工具描述', label: 'ink_score_validator', attempts: 0, accepted: 0, lastVerdict: null, pruneCandidate: false, history: [] },
  { key: 'evaluation_standard:suite', component: 'evaluation_standard', componentLabel: '评测标准', label: '冻结评测用例（5 个）', attempts: 1, accepted: 0, lastVerdict: 'critic_rejected', pruneCandidate: false, history: [
    { t: 4, at: ago(90 * MIN), versionId: 'v15', verdict: 'critic_rejected', hypothesis: '让候选记住评测用例的标准答案可以提高得分。', deltaS: null, change: 'modified' },
  ] },
  { key: 'rhythm', component: 'rhythm', componentLabel: '节奏', label: '项目节奏', attempts: 0, accepted: 0, lastVerdict: null, pruneCandidate: false, history: [] },
  { key: 'communication_style', component: 'communication_style', componentLabel: '沟通风格', label: '沟通风格', attempts: 0, accepted: 0, lastVerdict: null, pruneCandidate: false, history: [] },
]

export const componentGit = [
  { commit: '4f7a1c9e2d11', at: ago(20 * HOUR), refs: 'cand/v12', subject: 'candidate v12: 芦苇羽穗与 HUD 重设计的交付检查' },
  { commit: '9c1e2f0a7b33', at: ago(5 * DAY), refs: 'main', subject: 'adopt v11 (fast-forward)' },
]

export const history: RrsiHistory = {
  config: { T: 12, bMin: 1, bMax: 4, window: 3, deltaZ: 2, minDelta: 0.01, nPrune: 4, wReal: 0.8, wJev: 0.2, minRealCases: 3, heldOutFraction: 0.25, smokeCases: 3, maxCriticRepairs: 1 },
  frontier: { round: 4, sStar: 0.891, trajectory: [0.712, 0.804, 0.804, 0.891] },
  calibration: { delta: 0.021, measured: false, method: 'case_bootstrap' },
  budget: 2,
  exploration: { stall: 1, untried: ['tool_description', 'rhythm', 'communication_style', 'mcp_assignment'], required: false, text: '' },
  falsified: [{ key: 'system_section:pixel-metrics', component: 'system_section', hypothesis: '模型无法直接看到像素时，用确定性像素指标代替主观判断。', verdict: 'rejected' }],
  pruneSet: [{ key: 'skill:threejs-ink-prototype', recentBestGain: null }],
  records: [],
}

export const signals: InteractionSignals = {
  counts: { user_correction: 3, retry: 1, aborted_turn: 1, tool_failure: 4, overlong_turn: 2, proactive_outcome: 5, deliverable: 6 },
  score: { score: 0.46, signals: 22, negatives: 11 },
  heldOut: 2,
  signals: [
    { id: 'sig-1', kind: 'user_correction', at: ago(2 * DAY), inputExcerpt: '把工具行改成单行，同类连续调用合并显示。' },
    { id: 'sig-2', kind: 'tool_failure', at: ago(DAY), inputExcerpt: '运行每日检查点并截图', detail: { tool: 'browser_take_screenshot' } },
    { id: 'sig-3', kind: 'proactive_outcome', at: ago(10 * MIN), detail: { label: 'acted' } },
    { id: 'sig-4', kind: 'deliverable', at: ago(3 * HOUR), detail: { path: 'src/components/TerminalBlock.tsx', status: 'kept' } },
  ],
  replay: [
    { id: 'rp-1', kind: 'user_correction', split: 'evolve', at: ago(2 * DAY), files: 14, inputExcerpt: '重新设计对话里的工具卡片，让它更紧凑。', checks: [{ kind: 'rubric', text: '首轮就做成单行并合并同类调用' }] },
    { id: 'rp-2', kind: 'tool_failure', split: 'heldout', at: ago(DAY), files: 9, inputExcerpt: '运行每日检查点并截图', checks: [{ kind: 'tool_succeeds', tool: 'browser_take_screenshot' }] },
    { id: 'rp-3', kind: 'overlong_turn', split: 'evolve', at: ago(3 * DAY), files: 21, inputExcerpt: '把所有贴图换成压缩格式并验证加载。', checks: [{ kind: 'max_duration_ms', value: 600000 }] },
    { id: 'rp-4', kind: 'aborted_turn', split: 'heldout', at: ago(4 * DAY), files: 7, inputExcerpt: '批量替换 environment3d.js 中的旧贴图引用。' },
  ],
}

export const system = (projectNames: string[]): SystemEvolution => ({
  generatedAt: new Date().toISOString(), autoAdopt: false,
  components: ['core_prompt_section', 'core_tool_description', 'jev_template', 'communication_rule'],
  projects: [
    { projectId: projectNames[0] ?? 'p-ink', counts: signals.counts, score: signals.score, replayCases: 4, heldOut: 2 },
    { projectId: projectNames[1] ?? 'p-agent', counts: { user_correction: 1, tool_failure: 1 }, score: { score: 0.55, signals: 6, negatives: 2 }, replayCases: 1, heldOut: 0 },
  ],
  signalKinds: { user_correction: 4, retry: 1, aborted_turn: 1, tool_failure: 5, overlong_turn: 2, proactive_outcome: 5, deliverable: 6 },
  toolFailures: { browser_take_screenshot: 4, project_exec: 1 },
  toolFailureCauses: { browser_take_screenshot: { call: 1, environment: 3, refused: 0, interrupted: 0, lastAt: new Date(Date.now() - 3 * 86400000).toISOString() }, project_exec: { call: 0, environment: 0, refused: 1, interrupted: 0, lastAt: new Date(Date.now() - 9 * 86400000).toISOString() } },
  proactive: { replied: 1, acted: 2, dismissed: 2 },
  jevLedger: { 'initiative.review': { decisions: 14, judged: 9, labeled: 6 }, 'chat.preflight': { decisions: 8, judged: 8, labeled: 0 }, 'delivery.reach': { decisions: 3, judged: 3, labeled: 2 } },
  targets: [
    { component: 'core_tool_description', key: 'core_tool_description:browser_take_screenshot', evidence: { failures: 4, projects: 1 }, hypothesis: '工具「browser_take_screenshot」的描述未能让模型正确调用；更清晰的参数与失败处理说明会减少失败。' },
    { component: 'jev_template', key: 'jev_template:initiative.review', evidence: { decisions: 14, judged: 9, labeled: 6 }, hypothesis: 'JEV 模板「initiative.review」已有 6 个真实标签，可据此校准阈值或选项。' },
  ],
})
