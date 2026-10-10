import { existsSync, readFileSync } from 'node:fs';
import { messageSimilarity } from '../../../packages/sdk/src/proactive-message.mjs';

// K4 benchmark: user-message labels and text heuristics. Deterministic, no
// model calls. Heuristic labels are a documented seed; a manual label file
// (LABEL_SCHEMA) overrides them per item. Heuristic (applied in order, multi-label):
//   correction   — negative quality judgement or explicit redirect of the agent's work
//                  (太假/单调/单一/生硬/奇怪/太差/不能接受/看不到/缺失/浮在空中/啰嗦/废话/不对/错了/不是…而是…),
//                  or a persistence marker (仍然/依然/还是/仍…) followed by a problem word.
//   preference   — durable instruction about future behaviour (以后/后续/今后/不要再/只需要/你应该/不需要问我/默认/always/never/from now on).
//   approval     — acceptance of delivered work (已解决/已消除/好不少/不错/可以了/认可/就这样/没问题/👍/lgtm) without a correction.
//   decision     — an answer to an agent question (interaction answers; 选/方案 X/就用…).
//   pending_request — asks the agent to do something (imperative verbs: 继续/检查/修复/优化/安装/搜索/实现/设计/加载/找/做/生成/请/帮…).
//   progress_query — asks for status (进展/进度/怎么样了/完成了吗/做完了吗/status/progress).
//   message_complaint — complains about how the agent communicates (啰嗦/废话/不要写…详单/太长/别再问/不需要问我).
//   question     — ends with ?/？ or contains 是否/吗 (a question to the agent).
export const LABELS = Object.freeze(['correction', 'preference', 'approval', 'decision', 'pending_request', 'progress_query', 'message_complaint', 'question']);
export const LABEL_SCHEMA = 'rna-bench-labels/1';
const PROBLEM = /(太假|假了|很假|不够真实|单调|单一|生硬|奇怪|太差|很差|不能接受|看不到|看不见|缺失|没有后续|浮在空中|悬浮|闪烁|遮挡|平面而已|只是颜色变化|算不上|差的太多|差得太多|啰嗦|废话|不够简洁|不对|错了|有问题|问题|bug|不好用|不美观|太空|不合逻辑)/i;
const PERSIST = /(仍然|依然|仍|还是|还有|又|再次|依旧|still|again)/i;
const REDIRECT = /^(?:不对|不是|错了|不要|别这样|重新|应该是|你理解错|我说的是|我的意思是|并不是|no[,.!\s]|wrong|that'?s not|not what|actually[,\s]|instead[,\s])/i;
const PREFERENCE = /((?:^|[，,。；;\s])(?:以后|后续|今后|往后)|不要再|只需要|只要|你应该|应该自己|不需要问|不用问|默认|每次都|always|never|from now on|going forward)/i;
const APPROVAL = /(已解决|已消除|已经解决|好不少|不错|可以了|很好|认可|就这样|没问题|满意|👍|\blgtm\b|looks good)/i;
const DECISION = /(^|\s)(选|方案\s*[A-Za-z一二三]|就用|按你的建议|采用|以现实为准|同意)/;
const REQUEST = /(继续|检查|修复|优化|安装|搜索|实现|设计|重新|加载|找|做|生成|请|帮|改|完善|增加|添加|去掉|删除|换|切换|更新|运行|跑|测试|列出|提供|交付|开发|打开|接入|迭代|check|fix|build|add|remove|make|implement|install|search|continue)/i;
const PROGRESS = /(进展|进度|怎么样了|完成了吗|做完了吗|好了吗|到哪了|status|progress|any update)/i;
const MESSAGE = /(啰嗦|废话|不要写.{0,12}(详单|清单|列表)|太长|别再问|不需要问我|不用问我|只需要直接交付|不够简洁)/;
const QUESTION = /([?？]\s*$|是否|吗[?？。]?\s*$)/;

/** Heuristic labels for one user message; `source` marks interaction answers. */
export function heuristicLabels(text, { source } = {}) {
  const value = String(text ?? '').trim(), out = new Set();
  if (!value) return [];
  if (source === 'interaction-answer') out.add('decision');
  const problem = PROBLEM.test(value), approval = APPROVAL.test(value);
  if (REDIRECT.test(value) || problem && (!approval || PERSIST.test(value) || /但|不过|however|but/i.test(value))) out.add('correction');
  if (PREFERENCE.test(value)) out.add('preference');
  if (approval) out.add('approval');
  if (DECISION.test(value) && !/[?？]/.test(value)) out.add('decision');
  if (REQUEST.test(value) && !/^[?？]/.test(value)) out.add('pending_request');
  if (PROGRESS.test(value)) out.add('progress_query');
  if (MESSAGE.test(value)) out.add('message_complaint');
  if (QUESTION.test(value) && source !== 'interaction-answer') out.add('question');
  return LABELS.filter(label => out.has(label));
}
/** A correction explicitly says the earlier complaint persists (仍然/依然/still…). */
export const persistenceMarked = text => PERSIST.test(String(text ?? '')) && PROBLEM.test(String(text ?? ''));

/** Manual labels file: { schema, labels: { <itemId|fixtureKey>: { labels?: [...], add?: [...], remove?: [...], topic?, note? } } }. */
export function loadLabelFile(file) {
  if (!file || !existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value?.schema !== LABEL_SCHEMA || !value.labels || typeof value.labels !== 'object') throw Object.assign(new Error(`Label file must have schema ${LABEL_SCHEMA}`), { code: 'bench_labels_invalid' });
  for (const [key, row] of Object.entries(value.labels)) for (const field of ['labels', 'add', 'remove']) if (row?.[field] !== undefined && (!Array.isArray(row[field]) || row[field].some(label => !LABELS.includes(label)))) throw Object.assign(new Error(`Unknown label in ${key}.${field}`), { code: 'bench_labels_invalid' });
  return value;
}
/** Heuristic labels overridden by a manual entry (full replace via `labels`, or add/remove). */
export function applyManualLabels(itemId, heuristic, manual) {
  const row = manual?.labels?.[itemId];
  if (!row) return { labels: heuristic, labelSource: 'heuristic' };
  let labels = Array.isArray(row.labels) ? [...row.labels] : [...heuristic];
  for (const label of row.add ?? []) if (!labels.includes(label)) labels.push(label);
  labels = labels.filter(label => !(row.remove ?? []).includes(label));
  return { labels: LABELS.filter(label => labels.includes(label)), labelSource: 'manual', ...(row.topic ? { topic: String(row.topic) } : {}) };
}
/** A template with every labelled item, for the user to edit. */
export function labelTemplate(userMessages) {
  return { schema: LABEL_SCHEMA, help: 'Edit labels per item id. Use "labels" to replace, or "add"/"remove". "topic" groups repeat corrections. Allowed: ' + LABELS.join(', '), labels: Object.fromEntries(userMessages.map(row => [row.itemId, { labels: row.labels, excerpt: String(row.text ?? '').slice(0, 60), ...(row.topic ? { topic: row.topic } : {}) }])) };
}

// Text similarity. `messageSimilarity` (character-bigram Dice) is the host's
// own near-duplicate measure; `salientSimilarity` down-weights bigrams that are
// common across the corpus (IDF), which separates paraphrases of one finding
// from messages that merely share boilerplate.
const normalized = text => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
const bigramSet = text => { const value = normalized(text), out = new Set(); for (let index = 0; index < value.length - 1; index++) out.add(value.slice(index, index + 2)); return out; };
export function idfTable(texts) {
  const df = new Map(), sets = texts.map(bigramSet);
  for (const set of sets) for (const key of set) df.set(key, (df.get(key) ?? 0) + 1);
  const n = Math.max(1, texts.length);
  return key => Math.log((n + 1) / ((df.get(key) ?? 0) + 1)) + 1;
}
export function salientSimilarity(a, b, idf = () => 1) {
  const x = bigramSet(a), y = bigramSet(b); if (!x.size || !y.size) return 0;
  let shared = 0, left = 0, right = 0;
  for (const key of x) { const w = idf(key); left += w; if (y.has(key)) shared += w; }
  for (const key of y) right += idf(key);
  return shared / Math.min(left, right);
}
export { messageSimilarity };

/** Union-find clusters over items with `similar(i, j) === true`, restricted by `linkable(i, j)`. */
export function clusters(items, similar, linkable = () => true) {
  const parent = items.map((_, index) => index), find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (linkable(items[i], items[j]) && similar(items[i], items[j])) parent[find(j)] = find(i);
  const groups = new Map(); items.forEach((item, index) => { const root = find(index); groups.set(root, [...(groups.get(root) ?? []), item]); });
  return [...groups.values()];
}

// Message shape heuristics used by metrics and scenario quality assertions.
const STATUS = /(零漂移|无漂移|无变化|没有变化|无新(进展|反馈|发现)|暂无(新|进展|反馈)|仍(在)?等待|等待.{0,8}反馈|尚无反馈|检查点.{0,12}(通过|完成|执行完毕)|全部只读|零代码改动|no (new )?(change|progress|update)s?|still waiting|nothing new)/i;
const FINDING = /(发现|根因|修复|已修|新增|建议|想法|可以试|提议|方案|结论|实测|提升|降低|idea|found|fixed|propose|suggest)/i;
/** A status report: says nothing changed / still waiting, and carries no finding or proposal. */
export const isStatusReport = text => STATUS.test(String(text ?? '')) && !FINDING.test(String(text ?? '').replace(STATUS, ''));
/** Deliverable manifest: file tables / lists of produced files (the "交付物详单" complaint). */
export const hasDeliverableManifest = text => /交付物|\|\s*文件\s*\|/.test(String(text ?? '')) || (String(text ?? '').match(/[\w.-]+\.(?:md|mjs|js|json|html|css|ts|py|jsonl)\b/g) ?? []).length >= 3;
export const fileMentions = text => (String(text ?? '').match(/[\w.-]+\.(?:md|mjs|js|json|html|css|ts|py|jsonl|png)\b/g) ?? []).length;
export const hashMentions = text => (String(text ?? '').match(/(?<![0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}(?![0-9a-z])/gi) ?? []).length;
export const addendumOpener = text => /^(补一条|补充|补上|补发|再补)/.test(String(text ?? '').trim());
