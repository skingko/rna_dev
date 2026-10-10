/** Mock 进化 tree (evolution v3) for ?mock=1: the novel project's real shape on 2026-09-30. */
import type { Gene, GeneTree } from '@/api/genes-api'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()
const gene = (layer: string, id: string, title: string, extra: Partial<Gene> = {}): Gene => ({ id: `${layer}:${id}`, layer, key: id, title, summary: title, level: 1, status: 'active', history: [], runs: 0, hits: 0, createdAt: ago(3000), updatedAt: ago(600), ...extra })

export function mockGeneTree(projectId: string): GeneTree {
  return {
    projectId,
    promptFile: { name: 'AGENTS.md', exists: true, default: 'AGENTS.md' },
    generation: { n: 2, at: ago(9), summary: '新增检查「生硬表达检查」' },
    generations: [{ n: 2, at: ago(9), summary: '新增检查「生硬表达检查」', geneIds: ['guard:stiff'], trigger: 'feedback' }, { n: 1, at: ago(70), summary: '新增检查「守夜人」字样检查', geneIds: ['guard:nightwatch'], trigger: 'feedback' }],
    forming: false,
    strands: [
      { layer: 'profile', label: '画像', genes: [
        gene('lesson', 'l1', '约束：续写时不得直接复用原著的组织名「守夜人」', { layer: 'profile', level: 2, kind: 'constraint', uses: { applied: 4, contradicted: 0 }, summary: '续写时不得直接复用原著（斩神）的专有名词如组织名「守夜人」，必须自创或明确区分设定口径。' }),
        gene('lesson', 'l2', '偏好：每日更新小说内容，目标每日约 1 万字', { layer: 'profile', level: 3, kind: 'preference', uses: { applied: 10, contradicted: 6 } }),
        gene('lesson', 'l3', '偏好：写作时用词要“俗”、自然口语化', { layer: 'profile', level: 1, kind: 'preference' }),
        gene('lesson', 'l4', '偏好：行文避免数字化的生硬表达', { layer: 'profile', level: 1, kind: 'preference' }),
        gene('lesson', 'l5', '易错点：收到重写反馈时不要只做最小化修复', { layer: 'profile', level: 0, kind: 'pitfall' }),
        gene('lesson', 'l6', '偏好：避免无信息量的修辞赘句', { layer: 'profile', level: 1, kind: 'preference' }),
        gene('lesson', 'l7', '好做法：以验收通过的第 1 章 v5.2 为模板', { layer: 'profile', level: 0, kind: 'success_habit' }),
        gene('lesson', 'l8', '约束：写作前先查证原著的整体风格', { layer: 'profile', level: 2, kind: 'constraint' }),
      ] },
      { layer: 'prompt', label: '提示', genes: [
        gene('prompt', 'p0', '你是本玄幻小说项目的专职写作代理', { file: 'AGENTS.md', body: '你是本玄幻小说项目的专职写作代理。目的：创作一部对标《斩神》的≥1000章玄幻小说。' }),
        gene('prompt', 'p1', '先设定后正文，先大纲后章节', { file: 'AGENTS.md' }),
        gene('prompt', 'p2', '当用户未明确题材偏好时，先询问再动笔', { file: 'AGENTS.md' }),
      ] },
      { layer: 'skill', label: '技能', genes: [
        gene('skill', 'project-workflow', '玄幻小说撰写项目 workflow', { size: 1180, level: 2 }),
        gene('skill', 'novel-writing', 'novel-writing', { size: 5295 }),
        gene('skill', 'novel-forge', 'novel-forge', { size: 13387 }),
        gene('skill', 'fanqie', 'fanqie-long-xianxia', { size: 11169 }),
        { ...gene('skill', 'x', '先核对人名'), id: 'skill-patch:a1b2c3', key: 'a1b2c3', summary: '写章节前先核对人名和称谓是否与设定集一致。', status: 'trial', level: 0, generation: 3, createdAt: ago(4), skillId: 'project-workflow', when: '写章节', stats: { clean: 1, missed: 0 }, origin: { kind: 'correction', quote: '人名又前后不一致了，你写之前要核对设定集' } },
      ] },
      { layer: 'guard', label: '守卫', genes: [
        gene('guard', 'stiff', '生硬表达检查', { status: 'trial', level: 0, generation: 2, runs: 6, hits: 9, stats: { clean: 1, real: 2, falseMatches: 4 }, noisy: true, createdAt: ago(9), existingHits: { files: 8, total: 14, at: ago(9) }, origin: { kind: 'lesson', quote: '行文避免数字化的生硬表达（如“四个字”“睡过三觉”）' } }),
        gene('guard', 'nightwatch', '「守夜人」字样检查', { status: 'trial', level: 0, generation: 1, deepCheckable: true, deepCheck: { status: 'done', verdict: 'better', baselineScore: 0.62, candidateScore: 0.71, cases: 8, at: ago(1) }, stats: { clean: 2, real: 1, falseMatches: 0 }, standardId: 'consistency', createdAt: ago(70), existingHits: { files: 1, total: 3, at: ago(70) }, runs: 2, hits: 1, origin: { kind: 'lesson', quote: '续写时不得直接复用原著的组织名「守夜人」' } }),
      ] },
      { layer: 'tool', label: '工具', genes: [] },
      { layer: 'standard', label: '标准', genes: [
        gene('standard', 'consistency', '人设、力量体系、伏笔与既有设定一致', { checks: [{ id: 'guard:nightwatch', title: '「守夜人」字样检查' }] }),
        gene('standard', 'hooks', '每章有明确冲突、悬念或爽点，结尾留钩'),
        gene('standard', 'pacing', '剧情推进节奏合理，不注水不跳跃'),
        gene('standard', 'integrity', '设定集、大纲、伏笔登记随写作同步更新'),
      ] },
      { layer: 'system', label: '系统', genes: [
        gene('system', 'browser', '浏览器服务连不上', { summary: '网页查看工具多次连接失败，不是写作方法的问题。', seen: 3, lastSeenAt: ago(2), origin: { kind: 'contrast', quote: '打开网页核对资料' } }),
      ] },
    ],
  }
}

const SKILL_TEXT = '# novel-writing\n\n写长篇连载小说的完整方法。\n\n## 工作流程\n\n1. 先建立故事圣经：世界观、力量体系、人物卡。\n2. 分卷大纲与章节梗概，登记伏笔。\n3. 逐章写作：核对大纲 → 成文 → 自检节奏与一致性。\n\n## 检查清单\n\n- 每章有冲突、悬念或爽点\n- 人名、称谓、数字与设定集一致\n- 结尾留钩'
export function mockGeneDetail(projectId: string, geneId: string) {
  const gene = mockGeneTree(projectId).strands.flatMap(row => row.genes).find(row => row.id === geneId)
  if (!gene) return null
  const content = gene.id.startsWith('skill-patch:') ? { name: '玄幻小说撰写项目 workflow', patch: '- 写每一章前，先列出本章出场人物，逐个对照设定集核对名字与称谓。\n- 发现不一致先改设定引用，再动笔。', when: '写章节', expectation: '人名不再前后不一' }
    : gene.layer === 'skill' ? { name: gene.title, description: 'Assists with writing novels, serialized fiction, and long-form fiction.', instructions: SKILL_TEXT, resources: ['references/outline-template.md'], source: gene.key === 'project-workflow' ? 'generated' : 'marketplace-package' }
    : gene.layer === 'guard' ? { name: gene.title, description: '检查一个正文文件里是否出现数字化的生硬表达，并给出行号。', permission: 'read', script: "const text = await api.readFile(input.path);\nconst hits = [];\ntext.split('\\n').forEach((line, i) => { if (/[一二三四五六七八九十两]个字|睡过[一二三四五六七八九十两]觉/.test(line)) hits.push({ line: i + 1, excerpt: line.slice(0, 160) }); });\nreturn { hits, summary: hits.length ? `发现 ${hits.length} 处` : '未发现' };", trigger: ['正文/**/*.md'] }
      : gene.layer === 'profile' ? { text: gene.summary, kind: gene.kind, evidence: ['行文里别再写“四个字”“睡过三觉”这种数字化的说法，太生硬了'] }
        : gene.layer === 'system' ? { detail: 'The browser MCP service refused connections in three turns (ECONNREFUSED 127.0.0.1:9222).', seen: gene.seen, lastSeenAt: gene.lastSeenAt }
        : { description: gene.summary }
  return { gene: { ...gene, ...(gene.layer === 'skill' && gene.key !== 'project-workflow' ? { summary: '帮你按章节写长篇连载小说', original: 'Assists with writing novels, serialized fiction, and long-form fiction.' } : {}) }, content }
}
