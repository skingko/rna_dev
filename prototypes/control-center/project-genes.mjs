import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { privateStatePaths } from './state-privacy.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { validateProjectGenome, projectGenomeHash, runGenomeScript, genomeToolName, projectGenomeSchema, GENOME_READ_LIMIT_BYTES } from '../../packages/sdk/src/project-genome.mjs';
import { ProjectGenomeStore, genomeSkillId } from './project-genome-store.mjs';
import { workspacePrivateSegment } from '../../packages/sdk/src/workspace-tools.mjs';
import { isBootstrapWorkflowSkill } from '../../packages/sdk/src/bootstrap-lite.mjs';

// Evolution v3 (docs/planning/evolution-v3-gene-tree-20260930.md): the project's
// abilities as a tree of genes on five strands. The genome bundle stays the
// executable truth; `project.genes` is the human-readable registry over it
// (title, one-sentence summary, level, status, origin, history) plus the
// guards' triggers, and every committed change set is one generation = one
// immutable version. Nothing here calls a model.
// The system strand records problems in Rna itself or the machine (lane C), not the project's method; it changes no bundle.
export const GENE_LAYERS = Object.freeze(['profile', 'prompt', 'skill', 'tool', 'guard', 'standard', 'system']);
export const GENE_LAYER_LABELS = Object.freeze({ profile: '画像', prompt: '提示', skill: '技能', tool: '工具', guard: '守卫', standard: '标准', system: '系统' });
export const GENE_STATUSES = Object.freeze(['proposed', 'testing', 'trial', 'active', 'retired', 'rejected']);
export const MAX_LEVEL = 5, GUARD_TIMEOUT_MS = 5000, GUARD_FILE_LIMIT = 40;
/** The size `matchingFiles` keeps by default: the files a list of names is made from (authorGuard's sample files). */
export const GUARD_FILE_BYTES = 64000;
/** The largest file a check is run on to try it or to count what it finds: what a generated check can read at all
 * (`readFile` refuses a larger one), so a file the check can read is a file it is tried on. It was 64,000 with the read bound. */
export const GUARD_RUN_FILE_BYTES = GENOME_READ_LIMIT_BYTES;
const fail = (message, code = 'invalid_gene', status = 400) => Object.assign(new Error(message), { code, status });
const iso = value => new Date(value).toISOString();
const copy = value => structuredClone(value);
const clipText = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const short = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
/** A title in 「」 unless the author already quoted it (titles may contain their own quotes). */
export const quotedTitle = title => (/^[「『“"《]/.test(String(title ?? '')) ? String(title) : `「${title}」`);
/** Characters a genome puts in front of the model: the system prompt and the project's own (non-imported) skills. */
export const promptChars = genome => (genome?.systemPrompt?.length ?? 0) + (genome?.skills ?? []).filter(row => !row.source).reduce((sum, row) => sum + (row.instructions?.length ?? 0), 0);

export function ensureGenes(project) {
  project.genes ??= { genes: [], generations: [] };
  project.genes.genes ??= []; project.genes.generations ??= [];
  return project.genes;
}

/** Simple glob: `**` any path segments, `*` within a segment, `?` one char. Paths are workspace-relative with `/`. */
export function matchGlob(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  const normal = path.replace(/\\/g, '/').replace(/^\.\//, ''), glob = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') { const slash = glob[index + 2] === '/'; source += slash ? '(?:.*/)?' : '.*'; index += slash ? 2 : 1; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`).test(normal);
}

/** Level from a lesson's confirmations and use record (profile strand). */
export function lessonLevel(lesson) {
  const uses = lesson.uses ?? {}, applied = uses.applied ?? 0, contradicted = uses.contradicted ?? 0;
  return clamp((lesson.confirmedAt ? 1 : 0) + Math.floor(applied / 3) + (lesson.confirmations ?? 0) - contradicted, 0, MAX_LEVEL);
}

/**
 * Level of a mechanism gene (guard, skill patch) from evidence of use (EVO-13): a user confirmation, every three times
 * lesson.applied confidently said a reply followed the rule, every three real catches (hits guard.triage confirmed);
 * each time the user had to correct the same thing again takes one away. Turns without a correction (`stats.clean`) are
 * shown, never counted: at a 10–20% correction rate a useless rule collects them about as fast as a useful one (live:
 * a check at level 5 from 15 such turns with no real catch). ModularRSI charges only what ran; mu counts only confident
 * applied judgments.
 */
export function geneLevel(record) {
  const stats = record?.stats ?? {};
  return clamp((record?.confirmations ?? (record?.confirmedAt ? 1 : 0)) + Math.floor((stats.applied ?? 0) / TRIAL_USES) + Math.floor((stats.real ?? 0) / TRIAL_USES) - (stats.missed ?? 0), 0, MAX_LEVEL);
}
/** A trial gene becomes active after this many uses with evidence: confidently followed (a skill rule) or real catches (a
 * check), with no same-topic correction and not noisy. */
export const TRIAL_USES = 3;
/** The rule before EVO-13 (clean uses), kept for the history notes it wrote. */
export const TRIAL_CLEAN_USES = TRIAL_USES;
/** Mechanism genes whose level is computed from their record (the tree shows the computed one, not a stored stale one). */
export const isMechanism = record => record?.layer === 'guard' || /^skill-(patch|merge):/.test(String(record?.id ?? ''));
/** The project genome's tool slots (its schema's bound): a new check needs a free one (EVO-4 study, guard slots). */
export const GENOME_TOOL_LIMIT = projectGenomeSchema.properties.tools.maxItems;
/** A guard whose confident false matches reach this count and outnumber its real catches is noisy. */
export const NOISY_FALSE_MATCHES = 3;
export const isNoisy = record => (record?.stats?.falseMatches ?? 0) >= NOISY_FALSE_MATCHES && (record.stats.falseMatches ?? 0) > (record.stats.real ?? 0);

/**
 * How a rule that left, left (D3; ModularRSI dispositions.py): `retiredAs` on its record, a closed set so it can be counted.
 * undone (a merge or a consolidation was reverted: what it replaced came back), dropped (the user's 不再用: nothing came back),
 * contradicted (the user said the opposite later: nothing came back, EVO-6), lesson_revoked / lesson_rewritten (the lesson it grew
 * from was), source_removed (the message or the project scope it grew from is gone), skill_withdrawn (its skill left), repeat
 * (consolidation found it said what another rule says), replaced (a later rule was written over it). A rule retired before this
 * was recorded has no fate (`unrecorded` in the counts).
 */
export const GENE_FATES = Object.freeze(['undone', 'dropped', 'contradicted', 'lesson_revoked', 'lesson_rewritten', 'source_removed', 'skill_withdrawn', 'repeat', 'replaced']);

// ------------------------------------------------------------------------------ exposure (D3)
/** mu's retire rule (features/memory.ts:131): a rule recalled this many times and never followed is evidence of no use. */
export const EXPOSURE_EVIDENCE = 8;
const DAY_MS = 86400000;
/** The local calendar day of an instant ('YYYY-MM-DD'), the day buckets of a gene's exposure (the metric windows' local days). */
export const dayKey = at => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
/** One more run (or recall) of a rule on `at`'s day, kept on the gene (`exposure.days`); days older than a fortnight are dropped. */
export function bumpExposure(gene, field, at = Date.now()) {
  const days = { ...(gene.exposure?.days ?? {}) }, key = dayKey(at), keep = dayKey(at - 14 * DAY_MS);
  days[key] = { ...(days[key] ?? {}), [field]: (days[key]?.[field] ?? 0) + 1 };
  for (const day of Object.keys(days)) if (day < keep) delete days[day];
  gene.exposure = { ...(gene.exposure ?? {}), days };
}
/**
 * What a rule was shown or run for — never the self-confirming `level`. A check is exposed when it ran (`runs`, and its runs
 * per local day over the last `days`, `exposure.days`: null until a run was counted by day — a check that ran before the days were
 * kept would read as dead); a skill rule is exposed when it was put in front of the model for a turn (`shown`: D1's
 * `stats.injected`, the turn block that carried it; a rule judged relevant to a reply was shown whatever put it there, so the
 * count is never below `stats.recalled`; null until either was written) and used when a confident judgment said the reply followed
 * it (`stats.applied`). `recalled` is D1's own count: the turns where the rule was judged relevant (followed it or went against it).
 * `inRuns`: the background runs that read the rule in its skill (`stats.injectedRuns`, a part of `stats.injected`). Nobody judges
 * a background run (its work is never put to the lesson.applied judgment, and the user's next message is no answer to it), so
 * those are not `shown`: `shown` stays what the bloat rule and the analyses read it as, a count of placements a judgment could use.
 */
export function exposureOf(gene, { now = Date.now(), days = 7 } = {}) {
  const stats = gene?.stats ?? {}, since = dayKey(now - (days - 1) * DAY_MS), counted = gene?.exposure?.days;
  const recent = Object.entries(counted ?? {}).filter(([day]) => day >= since).reduce((sum, [, row]) => sum + (row?.ran ?? 0), 0);
  const inRuns = Math.min(stats.injectedRuns ?? 0, stats.injected ?? 0);
  const shown = stats.injected == null && !stats.recalled ? null : Math.max((stats.injected ?? 0) - inRuns, stats.recalled ?? 0);
  return { ran: gene?.runs ?? 0, ranRecent: gene?.layer === 'guard' && counted && typeof counted === 'object' ? recent : null, hits: gene?.hits ?? 0, real: stats.real ?? 0, falseMatches: stats.falseMatches ?? 0, shown, inRuns, recalled: stats.recalled ?? 0, applied: stats.applied ?? 0, notFollowed: stats.notFollowed ?? 0, missed: stats.missed ?? 0, lastRunAt: gene?.lastRunAt ?? null };
}
/**
 * The bloat rule's evidence for one skill rule (rrsi history.py:143-163: prune what measured no yield): it earned nothing when
 * it was shown at least `evidence` times and never confidently followed, or when none of that many turns since it was
 * written put it in front of the model at all (`observed`: the turns whose exposure was judged, `putIn` the ones of them that
 * carried this rule, either way, both counted by the caller from the turns' records). A rule the user confirmed or kept, or one
 * followed even once, has earned its place. With no exposure records (nothing shown, nothing observed) nothing can be said:
 * that is not evidence. A rule only background runs read (`inRuns`) is neither: those runs are never judged, so "never
 * followed" is unmeasured for it, and it did reach a model (the trial that has no road to proof is trial-evidence.mjs's).
 */
export function unproven(gene, observed = 0, { evidence = EXPOSURE_EVIDENCE, putIn = 0 } = {}) {
  const stats = gene?.stats ?? {}, { shown, inRuns } = exposureOf(gene), applied = stats.applied ?? 0;
  if (applied > 0 || gene?.confirmedAt || (gene?.confirmations ?? 0) > 0 || gene?.keep === true) return false;
  return shown !== null && shown >= evidence || (shown ?? 0) === 0 && inRuns === 0 && putIn === 0 && observed >= evidence;
}

/** Sections of a system prompt: blank-line paragraphs, or sentence groups for a one-paragraph prompt. */
export function promptSections(systemPrompt) {
  const text = String(systemPrompt ?? '').trim();
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/).map(row => row.trim()).filter(Boolean);
  const parts = paragraphs.length > 1 ? paragraphs : text.split(/(?<=[。！？.!?])\s*/).reduce((out, sentence) => { const last = out.at(-1); if (last && (last + sentence).length < 160) out[out.length - 1] = `${last}${sentence}`; else out.push(sentence); return out; }, []).filter(Boolean);
  return parts.map((body, index) => ({ key: `p${index}-${short(body)}`, index, body }));
}

// Generations written before titles were unwrapped read 新增检查「「守夜人」字样检查」: shown with one pair of brackets.
export const generationLine = text => (typeof text === 'string' ? text.replace(/「「([^「」]+)」([^「」]*)」/g, '「$1」$2') : text);
const registryOf = project => (project.genes?.genes ?? []).filter(row => row && typeof row.id === 'string');
// A plain-language summary is kept per interface language; the older single field was Chinese.
const plainOf = (record, language) => record?.plainSummaries?.[language] ?? (language === 'zh' ? record?.plainSummary : undefined) ?? null;
// The bootstrap's workflow skill is named and described in English for the model (`<project> workflow`); the user
// reads the host's wording in the interface language, with no "original" under it.
const WORKFLOW_TEXT = { zh: { title: '项目做法', summary: '这个项目的做事方法：处理常见任务时按这里的步骤来。' }, en: { title: 'Project workflow', summary: 'How this project is worked on: the steps the assistant follows for typical tasks.' } };
const skillText = (skill, language) => isBootstrapWorkflowSkill(skill) ? { ...inLanguage(language, WORKFLOW_TEXT), hostText: true } : { title: clipText(skill.name, 40), summary: clipText(skill.description, 200) };
/** A skill's name as the user reads it (announcements and generation lines use this, not the model-facing name). */
export const skillLabel = (skill, language = 'zh') => skillText(skill, language).title;
// History notes keep the language they were written in. The host's own fixed notes read in the current interface
// language; a system problem the user marked resolved reads 由你确认, not 用户停用. Every fixed say({ zh, en }) note in
// gene-evolution-service.mjs must be listed here (test/gene-notes.test.mjs checks it); notes that carry a count or a
// title keep the language they were written in.
const RETIRED_BY_USER = { zh: '用户停用', en: 'Retired by the user' }, RESOLVED_BY_USER = { zh: '由你确认', en: 'Confirmed by you' };
const HOST_NOTES = [RETIRED_BY_USER, RESOLVED_BY_USER, { zh: '你同意停用', en: 'You agreed to retire it' }, { zh: '开始验证', en: 'Checking' },
  { zh: '误报较多，退回试用', en: 'Too many false matches; back on trial' }, { zh: '你后来说的与它相反', en: 'You later asked for the opposite' },
  { zh: '同一件事又被纠正了一次', en: 'Corrected on the same point again' }, { zh: '写进技能，试用中', en: 'Written into the skill; on trial' },
  { zh: '替换原有做法，试用中', en: 'Replaces the earlier rule; on trial' }, { zh: '又出现了', en: 'Seen again' }, { zh: '对照分析发现', en: 'Found by contrast analysis' },
  { zh: '合并后试用中', en: 'Merged; on trial' }, { zh: '通过验证，已生效', en: 'Passed its checks; now active' },
  { zh: `用了 ${TRIAL_CLEAN_USES} 次没被纠正，已生效`, en: `Used ${TRIAL_CLEAN_USES} times without a correction; now active` },
  // B2 (EVO-5, EVO-7, EVO-10, EVO-13, lane C infrastructure).
  { zh: `照它做了 ${TRIAL_USES} 次，没被纠正，已生效`, en: `Followed ${TRIAL_USES} times without a correction; now active` }, { zh: `确认抓到 ${TRIAL_USES} 处真问题，已生效`, en: `Caught ${TRIAL_USES} real problems; now active` },
  { zh: '还没有匹配的文件，试用中', en: 'No file matches it yet; on trial' }, { zh: '还没运行过，退回试用', en: 'Never ran yet; back on trial' },
  { zh: '验证被中断（应用重启），稍后重试', en: 'Checking was interrupted by a restart; will retry' }, { zh: '修改没有完成，原来的检查照常运行', en: 'The revision did not finish; the check runs as before' },
  { zh: '重新判断：程序从文件里查不出这条规则', en: 'Re-judged: a program cannot tell this rule from the file' }, { zh: '对话失败时记下', en: 'Recorded when a turn failed' }, { zh: '对话或后台运行失败时记下', en: 'Recorded when a turn or a background run failed' },
  // C4 (revocation): what grew from a lesson, or lived in a skill, that went away.
  { zh: '你撤销了它的来源经验', en: 'You revoked the lesson it came from' }, { zh: '你改了它的来源经验', en: 'You changed the lesson it came from' }, { zh: '它所在的技能已停用', en: 'The skill it belongs to was retired' },
  { zh: '它的来源消息已被编辑或删除', en: 'The message it came from was edited or deleted' }, { zh: '项目范围已变化，它的来源已撤销', en: 'The project scope changed; its source was revoked' }];
const NOTE_BY_TEXT = new Map(HOST_NOTES.flatMap(pair => [[pair.zh, pair], [pair.en, pair]]));
const historyRow = (row, layer, language) => {
  const pair = row && typeof row === 'object' ? NOTE_BY_TEXT.get(row.note) : null;
  if (!pair) return row;
  return { ...row, note: inLanguage(language, layer === 'system' && row.status === 'retired' && pair === RETIRED_BY_USER ? RESOLVED_BY_USER : pair) };
};
/** The note a user retirement writes: a system problem is marked resolved, any other gene is retired. */
export const userRetireNote = (layer, language) => inLanguage(language, layer === 'system' ? RESOLVED_BY_USER : RETIRED_BY_USER);
const viewOf = ({ hostText = false, ...base }, record, language = 'zh') => ({ ...base, ...(record ? { title: record.title ?? base.title, summary: record.summary ?? (hostText ? null : plainOf(record, language)) ?? base.summary, ...(!hostText && plainOf(record, language) && !record.summary ? { original: base.summary } : {}), level: isMechanism(record) ? geneLevel(record) : record.level ?? base.level, status: record.status ?? base.status, origin: record.origin ?? null, generation: record.generation ?? null, history: (record.history ?? []).slice(-8).map(row => historyRow(row, base.layer, language)), runs: record.runs ?? 0, hits: record.hits ?? 0, existingHits: record.existingHits ?? null, rejection: record.rejection ?? null, trigger: record.body?.trigger?.onWrite ?? null, lastError: record.lastError ?? null, stats: record.stats ?? null, ...(isMechanism(record) ? { exposure: exposureOf(record) } : {}), ...(GENE_FATES.includes(record.retiredAs) ? { fate: record.retiredAs } : {}), ...(record.status === 'rejected' && record.rejection?.code ? { fate: record.rejection.retryable === true ? `retryable:${record.rejection.code}` : `rejected:${record.rejection.code}` } : {}), ...(record.harmWatch ? { harmWatch: { since: record.harmWatch.at, shared: record.harmWatch.shared ?? 0, delta: record.harmWatch.delta ?? null } } : {}), noisy: record.noisy === true, standardId: record.body?.standardId ?? null, ...(record.body?.when ? { when: record.body.when } : {}), ...(record.body?.skillId && record.id?.startsWith('skill-patch:') ? { skillId: record.body.skillId } : {}), ...(record.body?.mergedFrom ? { mergedFrom: record.body.mergedFrom } : {}), ...(record.body?.reroute?.checkable === false ? { notCheckable: true } : {}), ...(record.layer === 'system' ? { seen: record.body?.count ?? 1, lastSeenAt: record.body?.lastAt ?? record.updatedAt ?? null } : {}), ...(record.deepCheck ? { deepCheck: record.deepCheck } : {}), createdAt: record.createdAt ?? base.createdAt, updatedAt: record.updatedAt ?? base.updatedAt } : { origin: null, generation: null, history: [], runs: 0, hits: 0, existingHits: null, rejection: null, trigger: null }) });

/** The version a gene's generation created and its parent, when both still carry a bundle (the deep check compares them). */
export function generationVersions(project, gene) {
  const generation = (project.genes?.generations ?? []).find(row => row.n === gene?.generation && row.geneIds?.includes(gene.id));
  const version = generation && project.versions?.find(row => row.id === generation.versionId);
  const parent = version?.parentVersionId && project.versions?.find(row => row.id === version.parentVersionId);
  return version?.bundle && parent?.bundle ? { version, parent } : null;
}
export const DEEP_CHECK_LAYERS = Object.freeze(['skill', 'tool', 'guard']);

/** A gene is forming while one was proposed or is being checked in the last 15 minutes (the tree and the project summary agree). */
export const genesForming = (project, now = Date.now()) => registryOf(project).some(row => ['proposed', 'testing'].includes(row.status) && now - Date.parse(row.updatedAt ?? row.createdAt ?? 0) < 15 * 60000);

/** The whole tree, read-only: strands with gene views, the current generation, and whether one is forming. */
export function geneTree(project, { genome = null, instructions = null, now = Date.now(), language = 'zh' } = {}) {
  const registry = registryOf(project), byId = new Map(registry.map(row => [row.id, row]));
  const active = genome ?? project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.genome ?? null;
  const strands = Object.fromEntries(GENE_LAYERS.map(layer => [layer, []]));
  const push = (layer, base) => strands[layer].push(viewOf({ layer, level: 1, status: 'active', createdAt: null, updatedAt: null, ...base }, byId.get(base.id), language));
  const lessonLabel = { preference: '偏好', constraint: '约束', pitfall: '易错点', success_habit: '好做法' };
  for (const lesson of (project.mind?.lessons ?? []).filter(row => row.status === 'active')) push('profile', { id: `lesson:${lesson.id}`, key: lesson.id, kind: lesson.kind, title: `${lessonLabel[lesson.kind] ?? '经验'}：${clipText(lesson.text, 40)}`, summary: clipText(lesson.text, 200), level: lessonLevel(lesson), status: lesson.needsConfirmation ? 'trial' : 'active', createdAt: lesson.createdAt ?? null, updatedAt: lesson.updatedAt ?? null, source: lesson.source?.kind ?? null, uses: lesson.uses ?? null, confirmed: Boolean(lesson.confirmedAt) });
  // The prompt strand is the project's instruction file when it has one (shared with other agents); else the genome's prompt.
  const promptSource = instructions?.content?.trim() ? instructions.content : active?.systemPrompt ?? '';
  for (const section of promptSections(promptSource)) push('prompt', { id: `prompt:${section.key}`, key: section.key, title: clipText(section.body, 40), summary: clipText(section.body, 220), body: section.body, file: instructions?.name ?? null });
  if (active) {
    const guardToolIds = new Set(registry.filter(row => row.layer === 'guard' && row.body?.toolId && !['retired', 'rejected'].includes(row.status)).map(row => row.body.toolId));
    for (const skill of active.skills) push('skill', { id: `skill:${skill.id}`, key: skill.id, ...skillText(skill, language), size: skill.instructions.length, source: skill.source?.kind ?? 'generated' });
    for (const tool of active.tools) push(guardToolIds.has(tool.id) ? 'guard' : 'tool', { id: guardToolIds.has(tool.id) ? `guard:${tool.id}` : `tool:${tool.id}`, key: tool.id, title: clipText(tool.name, 40), summary: clipText(tool.description, 200), permission: tool.permission });
    for (const criterion of active.evaluationSuite?.criteria ?? []) push('standard', { id: `standard:${criterion.id}`, key: criterion.id, title: clipText(criterion.description, 40), summary: clipText(criterion.description, 200) });
  }
  // Registry-only genes (proposed, testing, retired) that the bundle no longer or not yet carries.
  const shown = new Set(Object.values(strands).flat().map(row => row.id));
  for (const record of registry) if (!shown.has(record.id) && GENE_LAYERS.includes(record.layer) && GENE_STATUSES.includes(record.status) && record.status !== 'rejected') strands[record.layer].push(viewOf({ layer: record.layer, id: record.id, key: record.key, title: record.title, summary: record.summary, level: 0, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt }, record, language));
  // Standards show the checks that verify them (standard.link), guards the standard they serve.
  const checks = new Map();
  for (const gene of strands.guard) if (gene.standardId && !['retired', 'rejected'].includes(gene.status)) checks.set(gene.standardId, [...(checks.get(gene.standardId) ?? []), { id: gene.id, title: gene.title }]);
  for (const gene of strands.standard) gene.checks = checks.get(gene.key) ?? [];
  // A gene that formed a generation can be compared with the one before it (optional deep check).
  for (const layer of DEEP_CHECK_LAYERS) for (const gene of strands[layer]) if (gene.generation && ['trial', 'active'].includes(gene.status) && byId.has(gene.id) && generationVersions(project, byId.get(gene.id))) gene.deepCheckable = true;
  const generations = (project.genes?.generations ?? []).map(row => ({ ...row, summary: generationLine(row.summary) })), last = generations.at(-1) ?? null;
  const forming = genesForming(project, now);
  return { projectId: project.id, promptFile: { name: instructions?.name ?? null, exists: Boolean(instructions), default: 'AGENTS.md' }, generation: { n: last?.n ?? 0, at: last?.at ?? null, summary: last?.summary ?? null }, generations: generations.slice(-30).reverse().map(row => ({ n: row.n, at: row.at, summary: row.summary, geneIds: row.geneIds, trigger: row.trigger ?? null })), forming, strands: GENE_LAYERS.map(layer => ({ layer, label: GENE_LAYER_LABELS[layer], genes: strands[layer] })) };
}

/** One gene in full for the detail panel: a skill's whole SKILL.md, a tool's script and trigger, a prompt section, a lesson with its evidence. */
export function geneDetail(project, geneId, { genome = null, instructions = null, language = 'zh' } = {}) {
  const tree = geneTree(project, { genome, instructions, language }), view = tree.strands.flatMap(row => row.genes).find(row => row.id === geneId);
  if (!view) return null;
  const active = genome ?? project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.genome ?? null;
  const record = registryOf(project).find(row => row.id === geneId), [layer, key] = geneId.split(':');
  const content = {};
  if (layer === 'skill') {
    const skill = active?.skills?.find(row => row.id === key);
    if (skill) Object.assign(content, { name: skill.name, description: skill.description, instructions: skill.instructions, resources: (skill.resources ?? []).map(row => row.path).slice(0, 40), source: skill.source?.kind ?? 'generated' });
  } else if (layer === 'tool' || layer === 'guard') {
    const tool = active?.tools?.find(row => row.id === (record?.body?.toolId ?? key));
    if (tool) Object.assign(content, { name: tool.name, description: tool.description, permission: tool.permission, script: tool.script, trigger: record?.body?.trigger?.onWrite ?? null });
  } else if (layer === 'skill-patch') {
    // A practice written into a skill after a correction (lane B): the section itself, where and when it applies.
    const skill = active?.skills?.find(row => row.id === record?.body?.skillId);
    Object.assign(content, { name: skill?.name ?? record?.body?.skillId ?? '', patch: String(record?.body?.note ?? '').replace(/^\s*##[^\n]*\n/, '').trim(), when: record?.body?.when ?? '', expectation: record?.body?.expectation ?? '' });
  } else if (layer === 'prompt') Object.assign(content, { body: view.body ?? view.summary, file: view.file ?? null });
  else if (layer === 'system') { const record = registryOf(project).find(row => row.id === geneId); Object.assign(content, { detail: record?.body?.detail ?? '', seen: record?.body?.count ?? 1, lastSeenAt: record?.body?.lastAt ?? null }); }
  else if (layer === 'standard') { const criterion = active?.evaluationSuite?.criteria?.find(row => row.id === key); if (criterion) Object.assign(content, { description: criterion.description }); }
  else if (layer === 'lesson') {
    const lesson = project.mind?.lessons?.find(row => row.id === key);
    if (lesson) Object.assign(content, { text: lesson.text, kind: lesson.kind, evidence: (lesson.evidence ?? []).map(row => typeof row === 'string' ? row : row?.excerpt ?? row?.text ?? '').filter(Boolean).slice(-3) });
  }
  return { gene: view, content };
}

/** Guards in force (active or on trial) with their executable tool from the active bundle. */
export function guardsOf(project, genome = null) {
  const active = genome ?? project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.genome ?? null;
  if (!active) return [];
  return registryOf(project).filter(row => row.layer === 'guard' && ['active', 'trial'].includes(row.status) && row.body?.toolId).flatMap(gene => { const tool = active.tools.find(item => item.id === gene.body.toolId); return tool ? [{ gene, tool }] : []; });
}
export const guardMatches = (gene, path) => (gene.body?.trigger?.onWrite ?? []).some(pattern => matchGlob(pattern, path));
/** One path segment of a glob as a regular expression (`*` and `?` stay within the segment, as in matchGlob). */
const segmentPattern = segment => new RegExp(`^${[...segment].map(char => char === '*' ? '[^/]*' : char === '?' ? '[^/]' : /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char).join('')}$`);
// Can a file below the workspace-relative folder `dir` match `pattern` (matchGlob's syntax)? A code fact from the glob's
// literal leading segments: 正文/**/*.md can match below 正文 and 正文/卷一, never below .next or build. A segment
// holding ** can match any folders, so everything below it stays in.

export function globCanEnter(pattern, dir) {
  if (typeof pattern !== 'string') return false;
  const glob = pattern.replace(/\\/g, '/').replace(/^\.\//, '').split('/'), folders = String(dir ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let index = 0; index < folders.length; index++) {
    const segment = glob[index];
    // The glob ran out at a folder (or its last segment names the file itself): nothing deeper can match.
    if (segment === undefined || index === glob.length - 1 && !segment.includes('**')) return false;
    if (segment.includes('**')) return true;
    if (!segmentPattern(segment).test(folders[index])) return false;
  }
  return true;
}

/** Files a guard's result may name as unchecked (a read of them was rejected), and the longest path and reason kept. */
export const UNCHECKED_LIMIT = 20, UNCHECKED_TEXT = 200;
/**
 * Normalize a guard script's result into hits: in line order (hits without a line last), cut at 50. A cut list
 * (`truncated`) is every hit up to its last line, which a pre-write baseline relies on (tool-policy.mjs).
 * `unchecked`: `{ path, reason }` rows for what the script could not read (a rejected read: too large, denied; the
 * contract in project-genome.mjs asks for them in place of a hit). Never counted as a hit: the host reports them as
 * "could not check", and nothing is to be fixed for them. Present only when the script returned some.
 */
export function guardResult(value) {
  const rows = Array.isArray(value?.hits) ? value.hits.filter(row => row && typeof row === 'object') : [];
  const lineOf = row => Number.isSafeInteger(row.line) ? row.line : Infinity;
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => (lineOf(a.row) - lineOf(b.row)) || a.index - b.index).map(item => item.row);
  const hits = ordered.slice(0, 50).map(row => ({ ...(Number.isSafeInteger(row.line) ? { line: row.line } : {}), excerpt: clipText(row.excerpt ?? row.text ?? '', 200), ...(row.note ? { note: clipText(row.note, 200) } : {}) }));
  const unchecked = (Array.isArray(value?.unchecked) ? value.unchecked : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, UNCHECKED_LIMIT)
    .map(row => ({ path: clipText(row.path ?? '', UNCHECKED_TEXT), reason: clipText(row.reason ?? '', UNCHECKED_TEXT) })).filter(row => row.path || row.reason);
  return { hits, summary: clipText(value?.summary ?? '', 300), ...(rows.length > hits.length ? { truncated: true } : {}), ...(unchecked.length ? { unchecked } : {}) };
}

/** Matching files compared when files are ranked by recency (a bound on the walk's matches, not on its answer). */
export const RECENT_SCAN_LIMIT = 4000;
/**
 * Files under the workspace matching a guard's trigger (bounded, private paths skipped). Folders the trigger cannot
 * match below are not entered (globCanEnter), so a large build or cache folder that sorts first neither costs the walk
 * nor uses up its bound. `recent`: the most recently written first (by mtime, over the first RECENT_SCAN_LIMIT matching
 * files) — what a new check is tried on (EVO-5): the files the project is writing now, not the alphabetically first ones
 * (the oldest chapters). Only matching files count toward that bound, as the plain walk counts only matches toward `limit`.
 * `maxBytes`: files larger than this are left out (a list of names: GUARD_FILE_BYTES; the files a check is run on: GUARD_RUN_FILE_BYTES).
 */
export async function matchingFiles(workspace, gene, { limit = GUARD_FILE_LIMIT, recent = false, maxBytes = GUARD_FILE_BYTES, signal } = {}) {
  const root = await realpath(workspace), out = [], patterns = gene?.body?.trigger?.onWrite ?? [];
  const cap = recent ? RECENT_SCAN_LIMIT : limit;
  const walk = async dir => {
    if (out.length >= cap) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted(); if (out.length >= cap) return;
      if (workspacePrivateSegment(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name), rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) { if (patterns.some(pattern => globCanEnter(pattern, rel))) await walk(full); continue; }
      if (!entry.isFile() || !guardMatches(gene, rel)) continue;
      try { const info = await lstat(full); if (info.size <= maxBytes) out.push({ rel, at: info.mtimeMs }); } catch {}
    }
  };
  await walk(root);
  if (recent) out.sort((a, b) => b.at - a.at || a.rel.localeCompare(b.rel));
  return out.slice(0, limit).map(row => row.rel);
}

export class GeneStore {
  constructor(store, { genomeStore = new ProjectGenomeStore(store), now = Date.now } = {}) { this.store = store; this.genomes = genomeStore; this.now = now; this.onWithdrawn = null; }
  /** C4: a check or a skill left the project's genome. Told to the revocation dispatcher (`onWithdrawn`, set by the host), which asks which notes, plan items and lessons still tell the assistant to use it. Never blocks a retirement. */
  withdrawn(projectId, tools) {
    if (typeof this.onWithdrawn !== 'function' || !tools.length) return;
    try { this.onWithdrawn({ type: 'tool_withdrawn', projectId, tools }); } catch { /* an observer never blocks evolution */ }
  }
  project(id, state = this.store.state) { return state.projects.find(row => row.id === id && !row.archivedAt) ?? null; }
  async activeGenome(project) {
    const version = project.versions?.find(row => row.id === project.activeVersionId);
    if (!version?.bundle) return null;
    try { return (await this.genomes.read(project.id, version.id)).genome; } catch { return version.bundle.genome ?? null; }
  }
  /** Run one guard on one file relative to `root` (the turn's root, design 0.63 §9; absent → the project folder).
   * `record: false` (a pre-write baseline, tool-policy.mjs) leaves the guard's stats alone. */
  async runGuard(project, entry, path, { signal, turnId = null, root = null, record = true } = {}) {
    const started = this.now();
    try {
      const result = await runGenomeScript(entry.tool, { path }, { workspace: root ?? project.workspace, signal, timeoutMs: GUARD_TIMEOUT_MS, deniedPaths: privateStatePaths(this.store.file) });
      const normalized = guardResult(result.value);
      // The turns a guard ran in are its uses: the next user message tells whether it held (leveling).
      if (record) this.record(project.id, entry.gene.id, gene => { gene.runs = (gene.runs ?? 0) + 1; gene.hits = (gene.hits ?? 0) + normalized.hits.length; if (normalized.unchecked) gene.unchecked = (gene.unchecked ?? 0) + 1; gene.lastRunAt = iso(this.now()); bumpExposure(gene, 'ran', this.now()); if (turnId && !(gene.turns ?? []).includes(turnId)) gene.turns = [...(gene.turns ?? []), turnId].slice(-12); });
      return { ...normalized, ms: this.now() - started };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (record) this.record(project.id, entry.gene.id, gene => { gene.runs = (gene.runs ?? 0) + 1; gene.failures = (gene.failures ?? 0) + 1; bumpExposure(gene, 'ran', this.now()); gene.lastError = clipText(error.message, 200); });
      return { hits: [], summary: '', error: clipText(error.message, 200), ms: this.now() - started };
    }
  }
  record(projectId, geneId, fn) {
    try { this.store.mutate(state => { const project = this.project(projectId, state); const gene = project && ensureGenes(project).genes.find(row => row.id === geneId); if (gene) { fn(gene); gene.updatedAt = iso(this.now()); } }); } catch {}
  }
  /** One generation: apply `change` to the active genome, publish it as a new version, and record the genes. */
  async commitGeneration(projectId, { change, genes = [], summary, trigger = 'feedback', signal } = {}) {
    const project = this.project(projectId); if (!project) throw fail('项目不存在', 'project_unavailable', 404);
    const baseVersion = project.versions?.find(row => row.id === project.activeVersionId);
    const base = await this.activeGenome(project); if (!base) throw fail('项目还没有可执行的能力包', 'baseline_bundle_required', 409);
    const next = validateProjectGenome(change(copy(base)));
    if (projectGenomeHash(next) === projectGenomeHash(base)) throw fail('这次进化没有改变任何内容', 'unchanged', 409);
    const versionId = randomUUID(), prepared = await this.genomes.prepare(project, { genome: next, versionId, parentVersionId: project.activeVersionId ?? null, signal });
    let committed = false;
    try {
      await prepared.commit(); committed = true;
      const at = iso(this.now());
      let generation;
      this.store.mutate(state => {
        const target = this.project(projectId, state); if (!target) throw fail('项目不存在', 'project_unavailable', 404);
        if (target.activeVersionId !== (baseVersion?.id ?? null)) throw fail('项目版本在进化期间已改变', 'version_changed', 409);
        const registry = ensureGenes(target), n = (registry.generations.at(-1)?.n ?? 0) + 1;
        generation = n;
        const oldSkills = new Set((baseVersion?.generatedSkills ?? []).map(row => row.id)), oldTools = new Set((baseVersion?.generatedTools ?? []).map(row => row.id));
        // Genome skills and tools are declared from the bundle itself; explicit assignments (when the
        // project has them) are kept in step so capability lists show the current generation. Names are stable across
        // generations (EVO-3): a kept skill or tool keeps its place and its reason, only added ids are appended and only
        // removed ones go, so a generation that changes no capability leaves the assignments exactly as they were.
        const previous = target.assignments;
        const newSkills = new Set(prepared.skillManifests.map(row => row.id)), newTools = new Set(prepared.toolDescriptors.map(row => row.id));
        const keep = (ids, old, added) => { const kept = (ids ?? []).filter(id => !old.has(id) || added.has(id)), present = new Set(kept); return [...new Set([...kept, ...[...added].filter(id => !present.has(id))])]; };
        const skillIds = previous ? keep(previous.skillIds, oldSkills, newSkills) : [], toolIds = previous ? keep(previous.toolIds, oldTools, newTools) : [];
        const existing = new Set([...(previous?.skillIds ?? []), ...(previous?.toolIds ?? [])]), gone = id => oldSkills.has(id) && !newSkills.has(id) || oldTools.has(id) && !newTools.has(id);
        const reasons = [...(previous?.reasons ?? []).filter(row => !gone(row.id)),
          ...prepared.skillManifests.filter(row => !existing.has(row.id)).map(row => ({ kind: 'skill', id: row.id, reason: `第 ${n} 代项目能力。` })), ...prepared.toolDescriptors.filter(row => !existing.has(row.id)).map(row => ({ kind: 'tool', id: row.id, reason: `第 ${n} 代项目能力。` }))];
        const assignments = previous ? { ...previous, skillIds, toolIds, mcpServerIds: [...(previous.mcpServerIds ?? [])], ...(Array.isArray(previous.reasons) || reasons.length ? { reasons } : {}) } : undefined;
        // One manifest per id (CapabilityRegistry throws on a duplicate): this project's rows of the old and the new
        // generation are replaced, never stacked.
        if (state.capabilities && Array.isArray(state.capabilities.skills)) { state.capabilities.skills = [...state.capabilities.skills.filter(row => !oldSkills.has(row.id) && !newSkills.has(row.id)), ...copy(prepared.skillManifests)]; state.capabilities.revision = (state.capabilities.revision ?? 0) + 1; }
        if (assignments && JSON.stringify(assignments) !== JSON.stringify(previous)) target.assignments = assignments;
        target.capabilityRevision = (target.capabilityRevision ?? 0) + 1;
        target.versions.push({ id: versionId, version: `gen-${n}`, title: clipText(summary, 160), state: 'active', source: 'gene-tree', parentVersionId: baseVersion?.id ?? null, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, systemPrompt: next.systemPrompt, evaluationSuite: next.evaluationSuite, ...(assignments ? { assignments: copy(assignments) } : {}), createdAt: at, simulated: false, evaluation: null, evaluationPerformed: false, qualityClaim: 'none', generation: n });
        target.activeVersionId = versionId; target.updatedAt = at;
        for (const input of genes) {
          const existing = registry.genes.find(row => row.id === input.id);
          const entry = { ...(existing ?? { id: input.id, createdAt: at, history: [] }), ...copy(input), generation: n, updatedAt: at };
          entry.history = [...(existing?.history ?? []), { at, generation: n, status: entry.status, note: clipText(input.note ?? summary, 200) }].slice(-20); delete entry.note;
          if (existing) Object.assign(existing, entry); else registry.genes.push(entry);
        }
        // `promptChars`: what this generation puts in front of the model (system prompt + the project's own skills), so growth can be watched (RRSI's cost rule).
        registry.generations.push({ n, at, versionId, summary: clipText(summary, 160), trigger, geneIds: genes.map(row => row.id), promptChars: promptChars(next) });
      });
      return { versionId, generation, hash: prepared.record.hash, toolNames: Object.fromEntries(prepared.toolDescriptors.map(row => [row.localId, row.toolName])), skillIds: Object.fromEntries(prepared.skillManifests.map(row => [row.localId, row.id])) };
    } catch (error) {
      if (!committed) await prepared.rollback().catch(() => {}); else await prepared.rollback().catch(() => {});
      throw error;
    }
  }
  /**
   * Retire a guard/tool/skill-note gene: a new generation without its parts (EVO-6). `restore: true` is an undo (a merge
   * or consolidation reverted: every rule it replaced and an extended check's earlier version return); `false`, the
   * default, is a drop or a contradiction — nothing comes back, and an extended check leaves together with the version it
   * replaced. mu never resurrects a retired lesson (store.ts:15); ModularRSI rolls back only to the seed or baseline
   * (archive.py:218-258). `restored` lists the rules that came back.
   */
  async retireGene(projectId, geneId, { reason = '用户不再需要', restore = false, as = null, signal } = {}) {
    const project = this.project(projectId), gene = project && registryOf(project).find(row => row.id === geneId);
    if (!gene) throw fail('基因不存在', 'gene_not_found', 404);
    if (['retired', 'rejected'].includes(gene.status)) return { versionId: null, generation: null, restored: [] };
    const body = gene.body ?? {};
    // `as`: why it left, typed (D3; ModularRSI dispositions.py — what became of it, not a sentence): one of GENE_FATES.
    const fate = GENE_FATES.includes(as) ? { retiredAs: as } : {};
    // A system record changes no bundle, nor does a gene whose text is no longer in it (merged away): the record alone retires.
    const recordOnly = () => { const at = iso(this.now()); this.record(projectId, geneId, row => { row.status = 'retired'; Object.assign(row, fate); row.history = [...(row.history ?? []), { at, status: 'retired', note: clipText(reason, 200) }].slice(-20); }); return { versionId: null, generation: null, restored: [] }; };
    if (gene.layer === 'system') return recordOnly();
    try {
      const earlier = Array.isArray(body.before) ? body.before.filter(row => row?.note && row.skillId) : [];
      const registry = registryOf(project), replaced = restore === true ? earlier : [], checkBefore = restore === true && body.before?.tool ? body.before : null;
      const back = inLanguage(interfaceLanguageOf(this.store.state), { zh: `恢复（${quotedTitle(gene.title)}已停用）`, en: `Restored (“${String(gene.title ?? '')}” was retired)` });
      // An extended check returns to what it was (same gene); replaced rules return to their earlier status.
      const records = checkBefore ? [{ ...copy(gene), ...copy(checkBefore.record), body: { ...copy(checkBefore.record.body ?? {}) }, note: back }]
        : [{ ...copy(gene), status: 'retired', ...fate, note: reason }, ...replaced.map(row => registry.find(item => item.id === row.id)).filter(Boolean).map(row => ({ ...copy(row), status: replaced.find(item => item.id === row.id).status ?? 'trial', supersededBy: null, retiredAs: undefined, note: back }))];
      const committed = await this.commitGeneration(projectId, { trigger: 'user', summary: inLanguage(interfaceLanguageOf(this.store.state), { zh: `停用${quotedTitle(gene.title)}`, en: `Retired “${String(gene.title ?? '').replace(/^[「『“"《]|[」』”"》]$/g, '')}”` }), genes: records, signal, change: genome => {
        if (checkBefore) {
          genome.tools = genome.tools.map(row => row.id === body.toolId ? copy(checkBefore.tool) : row);
          const skill = genome.skills.find(row => row.id === (checkBefore.skillId ?? body.skillId));
          if (skill && body.note && checkBefore.note) skill.instructions = skill.instructions.split(body.note).join(checkBefore.note);
          return genome;
        }
        // A dropped check leaves whole: its tool (an extended one with the version it replaced) and its note in the skill.
        if (body.toolId) genome.tools = genome.tools.filter(row => row.id !== body.toolId);
        if (body.mergedFrom && body.before) {
          // Undo a merge: the kept skill gets its own text back and the absorbed one returns whole. Dropped, the merged text stays.
          if (restore === true) {
            const kept = genome.skills.find(row => row.id === body.skillId); if (kept && typeof body.before.instructions === 'string') kept.instructions = body.before.instructions;
            if (body.before.absorbed && !genome.skills.some(row => row.id === body.before.absorbed.id)) genome.skills.push(copy(body.before.absorbed));
          }
        } else if (body.skillId && body.note) { const skill = genome.skills.find(row => row.id === body.skillId); if (skill) skill.instructions = skill.instructions.split(body.note).join('').replace(/\n{3,}/g, '\n\n').trim(); }
        // An undone revision or merge gives back the rules it replaced.
        for (const row of replaced) { const skill = genome.skills.find(item => item.id === row.skillId); if (skill && !skill.instructions.includes(row.note)) skill.instructions = `${skill.instructions.trimEnd()}${row.note}`; }
        return genome;
      } });
      // A check is run by the host on the files the project writes; no note or plan item tells the assistant to call it, so its
      // retirement is not a `tool_withdrawn`: that event asks which rows tell the assistant to use what left, and a check's own
      // title and summary are not a tool the assistant had (the rows it would pick up are near-duplicates of the rule itself).
      return { ...committed, restored: replaced.map(row => row.id), reverted: Boolean(checkBefore) };
    } catch (error) { if (error.code === 'unchanged') return recordOnly(); throw error; }
  }
  /** Retire a whole skill the user agreed is no longer needed: a new generation without it (never the project's own primary skill). */
  async retireSkill(projectId, skillId, { reason = '用户同意停用', signal } = {}) {
    const project = this.project(projectId); if (!project) throw fail('项目不存在', 'project_unavailable', 404);
    const genome = await this.activeGenome(project), skill = genome?.skills?.find(row => row.id === skillId);
    if (!skill) throw fail('技能不存在', 'gene_not_found', 404);
    if (skill === (genome.skills.find(row => !row.source) ?? genome.skills[0])) throw fail('项目自己的主技能不能停用', 'primary_skill', 409);
    const existing = registryOf(project).find(row => row.id === `skill:${skillId}`);
    const committed = await this.commitGeneration(projectId, { trigger: 'user', signal, summary: inLanguage(interfaceLanguageOf(this.store.state), { zh: `停用技能${quotedTitle(skill.name)}`, en: `Retired skill “${skill.name}”` }),
      genes: [{ ...(existing ? copy(existing) : { id: `skill:${skillId}`, layer: 'skill', key: skillId }), title: skill.name, summary: existing?.summary ?? clipText(skill.description, 200), status: 'retired', note: reason }],
      change: draft => { draft.skills = draft.skills.filter(row => row.id !== skillId); return draft; } });
    this.withdrawn(projectId, [{ kind: 'skill', id: skillId, name: clipText(skill.name, 60), description: clipText(skill.description, 160) }]);
    return committed;
  }
}
export { genomeToolName, genomeSkillId };
