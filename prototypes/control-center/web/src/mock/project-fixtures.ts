/* Project workspace fixtures for the mock backend: schedules, background
   actions, versions, observations, sources, files, preview, capabilities. */
import { previewBinarySizes, previewTextFiles } from './preview-fixtures'
import type { InitiativeAction, ObservationRecord, DecisionRecord, Occurrence, Schedule, VersionRecord, ObservationSource, ProjectSkill } from '@/api/project-api'
import type { ProjectPlan } from '@/api/types'
import { ago } from './fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const DAILY_KEY = 'schedule:sch-daily:occ-today'

export const schedules: Schedule[] = [
  {
    id: 'sch-daily', title: '试玩反馈每日检查点', enabled: true, source: 'initiative', destinationSessionId: 's-ui',
    task: '每天 09:00 运行 16 套回归与启动探针，核对 index.html / main.js / environment3d.js 的锚点哈希是否漂移；如有界面或性能退化，给出最小复现与修复建议，否则简短报告「无变化」。',
    rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, nextRunAt: new Date(Date.now() + 14 * HOUR).toISOString(),
    initiativeProvenance: { reason: '界面重设计刚交付，需要在接下来几天持续观察回归与移动端截断表现，用户希望每天早上看到结论。' },
  },
  {
    id: 'sch-weekly', title: '每周素材与技能盘点', enabled: false, source: 'conversation', destinationSessionId: 's-research',
    task: '每周一整理已安装技能的使用情况，列出一周内未被调用的技能与可能的替代项。',
    rule: { kind: 'weekly', days: [1], time: '10:30', timeZone: 'Asia/Shanghai' }, nextRunAt: null, userEditedAt: ago(2 * DAY),
  },
]

export const occurrences: Occurrence[] = [
  { key: DAILY_KEY, scheduleId: 'sch-daily', scheduledAt: ago(18 * MIN + 2 * MIN), status: 'delivered', deliveredAt: ago(18 * MIN), deliveryItemId: 'pro-1' },
  { key: 'schedule:sch-daily:occ-yesterday', scheduledAt: ago(DAY + 20 * MIN), scheduleId: 'sch-daily', status: 'failed', errorCode: 'tool_timeout', deliveredAt: null },
  { key: 'schedule:sch-daily:occ-2', scheduledAt: ago(2 * DAY + 20 * MIN), scheduleId: 'sch-daily', status: 'delivered', deliveredAt: ago(2 * DAY + 18 * MIN), deliveryItemId: 'gone' },
]

export const actions: (InitiativeAction & Record<string, unknown>)[] = [
  {
    id: 'act-work-1', action: 'work', status: 'running', content: '核对移动端 390px 下长路径截断，并检查终端块在窄屏的横向滚动。', reason: '上一轮交付提到需要在移动端验证长路径截断。',
    createdAt: ago(6 * MIN), startedAt: ago(5 * MIN), controlRevision: 3, controls: [], simulated: false,
  },
  {
    id: 'act-work-2', action: 'work', status: 'paused', content: '整理 v12 以来的芦苇穗头贴图性能数据。', reason: '用户提到低端机掉帧。', createdAt: ago(3 * HOUR), startedAt: ago(3 * HOUR), controlRevision: 5,
    controls: [{ id: 'c1', kind: 'pause', status: 'applied' }], simulated: false,
  },
  {
    id: 'act-share-1', action: 'share', status: 'completed', content: '每日检查点结果：回归全部通过。', createdAt: ago(20 * MIN), finishedAt: ago(18 * MIN), simulated: false,
  },
  {
    id: 'act-review-1', action: 'work', status: 'needs_review', content: '批量替换 environment3d.js 中的旧贴图引用。', reasonForReview: '服务重启时工具调用未返回结果', failure: { code: 'interrupted_tool', message: 'project_edit 未确认是否写入' },
    createdAt: ago(9 * HOUR), controlRevision: 1, controls: [], blocksExecution: true, simulated: false,
  },
]

actions.push(
  { id: 'act-work-3', action: 'work', status: 'completed', content: '复核芦苇穗头透明排序修复后的帧率。', reason: '上一轮修复后需要在低端机确认。', handoff: '交接：Redmi 9 回到 52fps，iPhone 12 稳定 60fps；剩下暗色模式截图未核对。', resultSummary: '透明排序修复有效：Redmi 9 由 41fps 回到 52fps。', createdAt: ago(3 * HOUR), startedAt: ago(3 * HOUR), finishedAt: ago(2 * HOUR), simulated: false },
  { id: 'act-plan-1', action: 'schedule', status: 'completed', content: '安排每日 09:00 检查点，持续观察一周界面回归。', reason: '界面刚交付，需要连续几天确认没有回归。', createdAt: ago(2 * DAY), finishedAt: ago(2 * DAY), simulated: false },
  { id: 'act-work-4', action: 'work', status: 'failed', content: '导出 390px 与 430px 两档的 HUD 截图对照。', failure: { code: 'tool_timeout', message: 'browser_take_screenshot 30s 内未返回' }, createdAt: ago(DAY + 2 * HOUR), finishedAt: ago(DAY + HOUR), simulated: false },
  { id: 'act-ask-1', action: 'ask', status: 'completed', content: 'HUD 分数要固定在右上角，还是跟随镜头？', createdAt: ago(5 * HOUR), finishedAt: ago(5 * HOUR), simulated: false },
)

export const jobs = [
  { id: 'act-work-1', status: 'running', toolReceiptCounts: { total: 3, completed: 2, failed: 0, uncertain: 1 }, toolReceipts: [
    { toolName: 'project_read', status: 'completed', at: ago(4 * MIN), output: 'src/components/TerminalBlock.tsx (212 lines)', recordedByHost: true },
    { toolName: 'project_exec', status: 'completed', at: ago(3 * MIN), output: 'npx playwright test mobile.spec.ts\n  ✓ 6 passed (4.1s)', recordedByHost: true },
    { toolName: 'browser_take_screenshot', status: 'uncertain', at: ago(2 * MIN), output: '', recordedByHost: true },
  ] },
  { id: 'act-work-2', status: 'paused', output: '已采样 3 台设备：iPhone 12 稳定 60fps，Redmi 9 在芦苇密集区降至 41fps。', toolReceiptCounts: { total: 2, completed: 2, failed: 0, uncertain: 0 }, toolReceipts: [] },
]

const genome = (skills: string[]) => ({
  systemPrompt: '你是水墨飞鸟项目的开发协作者。先读项目约定，再动手；每次交付附带验证证据。',
  skills: skills.map((name, i) => ({ id: `skill-${i + 1}`, name, description: `${name} 的方法与检查清单`, instructions: `# ${name}\n\n1. 先确认目标与约束\n2. 实施最小改动\n3. 截图与回归验证` })),
  tools: [{ id: 'ink_score_validator', name: 'ink_score_validator', description: '校验关卡水墨分数曲线', permission: 'read', script: 'export default async function run(input) { return { ok: true } }' }],
  evaluationSuite: { cases: [{ id: 'core_loop_design' }, { id: 'difficulty_curve_check' }, { id: 'hud_readability' }] },
})

export const versions: VersionRecord[] = [
  { id: 'v10', version: 10, title: '初始能力配置：水墨跳跃机制与 Three.js 原型', state: 'baseline', createdAt: ago(9 * DAY), simulated: false, bundle: { hash: 'a1b2c3', genome: genome(['水墨跳跃机制设计', 'Three.js 水墨原型实现']) } },
  {
    id: 'v11', version: 11, title: '加入美术可读性检查：剪影、明度对比与信号色纪律', state: 'active', parentVersionId: 'v10', createdAt: ago(5 * DAY), simulated: false,
    proposal: { hypothesis: '界面改版后玩家难以分辨可落脚区域；把可读性审计加入交付前检查可以减少返工。' },
    evaluation: { gatePassed: true, baselineScore: 0.712, candidateScore: 0.804, cases: 5, simulated: false, gates: { scripts: true, deterministicCases: true, minimumScore: true, improvement: true, noRegression: true, tokenRatio: true } },
    assessment: { label: '通过评估 · 已采用', summary: '5 个冻结用例全部执行；候选 0.804 对比基线 0.712，提升 +0.092，超过 +0.08 门槛。', stage: 'completed' },
    bundle: { hash: 'd4e5f6', genome: genome(['水墨跳跃机制设计', 'Three.js 水墨原型实现', '美术可读性审计']) },
  },
  {
    id: 'v12', version: 12, title: '芦苇羽穗与 HUD 重设计的交付检查', state: 'ready', parentVersionId: 'v11', createdAt: ago(20 * HOUR), simulated: false,
    proposal: { hypothesis: '两次交付都在截图后才发现 HUD 文字被芦苇遮挡；把「截图前先检查 HUD 层级」写进交付技能。' },
    evaluation: { gatePassed: true, baselineScore: 0.804, candidateScore: 0.891, cases: 5, simulated: false },
    assessment: { label: '通过评估 · 可试用', summary: '候选 0.891 对比基线 0.804，提升 +0.087；无单项退步，用量增幅 6%。', stage: 'completed' },
    bundle: { hash: 'g7h8i9', genome: genome(['水墨跳跃机制设计', 'Three.js 水墨原型实现', '美术可读性审计', 'HUD 层级检查']) },
    evidenceIds: ['episode:turn:1', 'episode:work:2'],
  },
  {
    id: 'v13', version: 'candidate-13', title: '最小干预：为无视觉反馈时的审美判断增加像素指标协议', state: 'rejected', parentVersionId: 'v11', createdAt: ago(6 * HOUR), simulated: false,
    proposal: { hypothesis: '模型无法直接看到像素时，用确定性像素指标代替主观判断。' },
    evaluation: { gatePassed: false, baselineScore: 0.785, candidateScore: 0.74, cases: 5, simulated: false },
    bundle: { hash: 'j1k2', genome: { ...genome(['水墨跳跃机制设计', 'Three.js 水墨原型实现', '美术可读性审计']), systemPrompt: '你是水墨飞鸟项目的开发协作者。无法看到像素时使用确定性像素指标。' } },
    assessment: { label: '效果门槛未达到', summary: '已执行的行为或质量检查未满足全部冻结门槛；当前版本保持有效。', stage: 'completed', retry: { available: true, kind: 'reevaluate', reason: '评估运行环境已升级；试用前需要在新环境中重评。' } },
  },
  { id: 'v14', version: 'candidate-14', title: '难度曲线复盘：暂无需要改变的方法', state: 'no_change', parentVersionId: 'v11', createdAt: ago(2 * HOUR), simulated: false, authorAbstention: { explanation: '本批证据只涉及界面文字，不影响关卡难度方法。' } },
]

export const observations: ObservationRecord[] = [
  { id: 'obs-1', kind: 'conversation', text: '移动端长路径截断到文件名，看起来符合预期。', status: 'handled', createdAt: ago(40 * MIN), source: 'conversation', simulated: false },
  { id: 'obs-2', kind: 'workspace_change', text: '目录变化：src/components/TerminalBlock.tsx、src/lib/ansi.ts 已修改。', status: 'pending', createdAt: ago(25 * MIN), source: 'workspace', simulated: false },
  { id: 'obs-3', kind: 'ci_failure', text: '昨日 09:00 检查点执行超时：`browser_take_screenshot` 30s 内未返回。', status: 'handled', createdAt: ago(DAY), source: 'schedule', simulated: false },
  { id: 'obs-4', kind: 'preference', text: '我更希望你先给结论，再展开依据。', status: 'ignored', createdAt: ago(3 * DAY), source: 'user-observation', simulated: false },
]

export const decisions: DecisionRecord[] = [
  { id: 'dec-1', action: 'work', reason: '目录变化涉及终端块与 ANSI 解析，属于上一轮交付范围；**在后台核对移动端表现**，不打断当前对话。', status: 'executed', at: ago(24 * MIN), evidenceIds: ['observation:obs-2'] },
  { id: 'dec-2', action: 'wait', reason: '用户正在输入，前台轮次活跃；后台不复制前台任务，等待本轮结束。', status: 'executed', at: ago(50 * MIN) },
  { id: 'dec-3', action: 'share', reason: '每日检查点完成，结果需要告知。', content: '**每日检查点**：今天的回归测试 16/16 全部通过。', status: 'executed', at: ago(19 * MIN) },
  { id: 'dec-4', action: 'schedule', reason: '界面刚交付，安排每日检查点持续观察一周。', status: 'executed', at: ago(2 * DAY) },
]

export const observationSources: ObservationSource[] = [
  {
    id: 'workspace', label: '项目目录变化', enabled: true, status: 'watching', summary: '自动检查目录变化；由 Agent 判断是否需要行动。',
    ...{ lastCheckedAt: ago(12_000), lastEventAt: ago(25 * MIN), pendingCount: 1, limits: { maxFiles: 2000, maxEntries: 6000 }, stats: { received: 42, coalesced: 17, suppressedDuringExecution: 57 },
      recent: [{ at: ago(25 * MIN), kind: 'change', summary: '2 个文件修改：src/components/TerminalBlock.tsx、src/lib/ansi.ts' }, { at: ago(3 * HOUR), kind: 'change', summary: '1 个文件新增：docs/tool-row-spec.md' }] },
  } as ObservationSource,
]

export const rhythmStatus = {
  control: 'auto', lifecycle: 'recurring', assessmentRequired: false, effective: { initiativeEnabled: true, evolutionEnabled: true },
  schedule: { activeCount: 1, dueCount: 0, nextAt: Date.now() + 14 * HOUR },
  initiative: { eligible: false, reason: 'awaiting_scheduled_work', nextAt: Date.now() + 14 * HOUR, state: 'working' },
  evolution: { eligible: false, reason: 'learning_interval', nextAt: Date.now() + 3 * HOUR, state: 'waiting', quota: { dayUsed: 1, weekUsed: 4, maxPerDay: 3, maxPerWeek: 10 } },
  assessment: { reason: '界面重设计已交付，进入周期观察：每日检查点负责回归，后台只在新证据到达时复查。', evolution: { mode: 'evidence' }, initiative: { mode: 'adaptive' } },
  assessedAt: Date.now() - 2 * HOUR,
  history: [{ at: Date.now() - 2 * DAY, lifecycle: 'active', reason: '用户请求界面重设计，项目进入活跃迭代。', initiativeMode: 'adaptive', evolutionMode: 'evidence' }],
}

export const learningRuntime = { sdkState: { reviews: [{ id: 'rev-1', status: 'completed', decision: { intervention: '把 HUD 层级检查写进交付技能', reason: '两次返工都与 HUD 遮挡有关' }, result: { status: 'ready', summary: '候选 v12 通过冻结评估。' }, completedAt: ago(20 * HOUR) }] } }

export const skills: ProjectSkill[] = [
  { id: 'project-analysis', name: '项目分析', description: '根据证据理解项目目标、约束与结构。', enabled: true, builtin: true },
  { id: 'code-review', name: '代码审查', description: '审查可复现的缺陷并解释证据。', enabled: true, builtin: true },
  { id: 'skill-frontend-design', name: 'frontend-design', description: '差异化视觉方向、排版与反模板清单。', enabled: true },
  { id: 'skill-art-direction-readability', name: 'art-direction-and-readability', description: '剪影、明度对比与信号色纪律。', enabled: true },
  { id: 'gen-59b6c5f75c83c7c8-ink-jump-design', localId: 'ink-jump-design', name: '水墨跳跃机制设计', description: '项目生成技能：跳跃手感与关卡节奏。', enabled: true, generated: true },
  { id: 'gen-59b6c5f75c83c7c8-threejs-ink-prototype', localId: 'threejs-ink-prototype', name: 'Three.js 水墨原型实现', description: '项目生成技能：水墨着色与场景组织。', enabled: true, generated: true },
]

/* ------------------------------------------------------------------ files */

export const files: Record<string, string> = {
  'index.html': '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8" />\n  <title>墨跃 · 墨迹成桥</title>\n  <link rel="stylesheet" href="src/styles/app.css" />\n</head>\n<body>\n  <canvas id="stage"></canvas>\n  <div class="hud"><span class="score">0</span><span class="seal">分</span></div>\n  <script type="module" src="src/main.js"></script>\n</body>\n</html>\n',
  'README.md': '# 水墨飞鸟\n\nThree.js 水墨风休闲游戏。\n\n## 运行\n\n```bash\nnpm install\nnpm run dev\n```\n\n## 目录\n\n| 目录 | 说明 |\n| --- | --- |\n| `src/` | 游戏源码 |\n| `docs/` | 设计记录 |\n\n> 所有交付都附带截图与回归结果。\n',
  'docs/hud-layering-report.md': '# HUD 层级复核（390px）\n\n| 设备 | 宽度 | 结果 |\n| --- | --- | --- |\n| iPhone 12 | 390px | 分数印章右上角被芦苇穗头覆盖约 14px |\n| Redmi 9 | 393px | 同上 |\n| iPad mini | 744px | 正常 |\n\n## 原因\n\n分数印章 `z-index: 10`，前景芦苇层 `z-index: 20`。\n\n## 建议\n\n- HUD 层级提到 `30`\n- 印章加 `isolation: isolate`，避免后续粒子层再次覆盖\n',
  'docs/tool-row-spec.md': '# 工具行规范\n\n- 单行 28px\n- 图标 + 动词 + 对象\n- 同类连续调用合并\n- 点击在右侧查看详情\n',
  'src/main.js': "import * as THREE from 'three'\nimport { createInkMaterial } from './inkArt.js'\n\nconst canvas = document.getElementById('stage')\nconst renderer = new THREE.WebGLRenderer({ canvas, antialias: true })\nconst scene = new THREE.Scene()\n\n// 墨迹桥：每次跳跃留下一段可落脚的墨痕\nexport function spawnBridge(from, to, ink = 0.6) {\n  const material = createInkMaterial({ opacity: ink })\n  const geometry = new THREE.PlaneGeometry(to.x - from.x, 0.2)\n  return new THREE.Mesh(geometry, material)\n}\n\nfunction loop(time) {\n  renderer.render(scene, camera)\n  requestAnimationFrame(loop)\n}\nrequestAnimationFrame(loop)\n",
  'src/inkArt.js': "export function createInkMaterial({ opacity = 1 } = {}) {\n  return { type: 'ink', opacity, color: '#1d1a17' }\n}\n",
  'src/styles/app.css': ':root {\n  --paper: #f3efe6;\n  --ink: #1d1a17;\n  --cinnabar: #9a3730; /* 唯一紧急信号色 */\n}\n.hud { position: fixed; inset: 16px auto auto 16px; font-family: serif; }\n.seal { color: var(--cinnabar); }\n',
  'package.json': '{\n  "name": "ink-bird",\n  "version": "0.12.0",\n  "type": "module",\n  "scripts": { "dev": "vite", "build": "vite build" },\n  "dependencies": { "three": "^0.170.0" }\n}\n',
  ...previewTextFiles,
  ...Object.fromEntries(Object.keys(previewBinarySizes).map(path => [path, ''])),
}

export function listDirectory(path: string) {
  const prefix = path ? `${path}/` : ''
  const seen = new Map<string, { name: string; path: string; type: 'file' | 'directory'; size: number | null }>()
  for (const [file, content] of Object.entries(files)) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length)
    const [head, ...tail] = rest.split('/')
    const full = prefix + head
    if (tail.length) seen.set(full, { name: head, path: full, type: 'directory', size: null })
    else seen.set(full, { name: head, path: full, type: 'file', size: previewBinarySizes[full] ?? new TextEncoder().encode(content).length })
  }
  return [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
}

/* H3: a second project with its own live work, so the global 任务 list spans projects. */
export const agentSchedules: Schedule[] = [
  {
    id: 'sch-deps', title: '依赖与构建健康巡检', enabled: true, source: 'initiative', destinationSessionId: 's-plan',
    task: '每 6 小时检查 npm 依赖的安全公告与 v2 协议测试是否通过；只在出现新问题时汇报。',
    rule: { kind: 'interval', everyMs: 6 * HOUR }, nextRunAt: new Date(Date.now() + 42 * MIN).toISOString(),
    initiativeProvenance: { reason: 'v2 事件协议联调期间依赖变化频繁，需要及早发现回归。' },
  },
]
export const agentActions: (InitiativeAction & Record<string, unknown>)[] = [
  {
    id: 'act-agent-1', action: 'work', status: 'queued', content: '对照 stream-protocol-v2 规范复核 tool_args 增量事件的字段命名。', reason: '联调计划中提到字段命名尚未冻结。',
    createdAt: ago(2 * MIN), controlRevision: 1, controls: [], simulated: false,
  },
  // Failed runs a scope change revoked (a new conversation, another model): only their receipts are listed. `keptLabel` is
  // the name the host kept for the user (its job or delivered message); the second kept nothing, so 接着做 cannot work
  // (the host would not list it at all; the mock does, to show that guard).
  {
    id: 'act-agent-lost-1', action: 'work', status: 'failed', contextRevoked: true, keptLabel: '可以，按这个标准重写 1-30 章所有章节，替换原正文',
    content: '[revoked]', failure: { code: 'tool_timeout' }, createdAt: ago(3 * DAY), startedAt: ago(3 * DAY), finishedAt: ago(3 * DAY - HOUR), simulated: false,
  },
  {
    id: 'act-agent-lost-2', action: 'work', status: 'failed', contextRevoked: true, keptLabel: '',
    content: '[revoked]', failure: { code: 'interrupted' }, createdAt: ago(2 * DAY), startedAt: ago(2 * DAY), finishedAt: ago(2 * DAY - 2 * HOUR), simulated: false,
  },
]

/** Rna Agent's working plan, left stale for days (the 任务 page's plan lines the user settles or clears). */
export const agentPlan: ProjectPlan = {
  doing: [{ id: 'pl-agent-1', text: 'prose_review → prose_patch ≤6处 → 复查', status: 'doing', updatedAt: ago(3 * DAY) }],
  next: [
    { id: 'pl-agent-2', text: '接着完成：可以，按这个标准重写 1-30 章所有章节，替换原正文', status: 'next', updatedAt: ago(3 * DAY - HOUR), interruptedAt: ago(3 * DAY - HOUR) } as ProjectPlan['next'][number],
    { id: 'pl-agent-3', text: '如实计字 → 原子替换正文文件 → 最终自检与交接', status: 'next', updatedAt: ago(2 * DAY) },
  ],
  done: [],
}

export const isBinaryFixture = (path: string) => path in previewBinarySizes
export const languageOf = (path: string) => ({ md: 'markdown', js: 'javascript', css: 'css', html: 'html', json: 'json', py: 'python', csv: 'text', txt: 'text' } as Record<string, string>)[path.split('.').at(-1) ?? ''] ?? 'text'
