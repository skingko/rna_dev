// Decision state builder (JEV design §2/§5). Code computes every count, date,
// duration and ratio into named buckets; the judge only reads short English
// feature labels beside the user's original text. Object-shaped, per-point
// field allow-lists; the kernel still redacts secrets and bounds size.
export const DECISION_STATE_VERSION = 1;
/** work.coverage bounds: receipts and changes each get one question, so 1 + receipts + changes stays within a plan's 20. */
export const WORK_COVERAGE_RECEIPTS = 5, WORK_COVERAGE_CHANGES = 8, WORK_COVERAGE_CHECKS = 6;
/**
 * work.coverage string budget, so the largest state fits the kernel's 10,000 characters by construction (the kernel
 * counts every string, ids and buckets included, and cuts the rest; a judge asked about C<j> or R<i> it cannot see
 * answers about nothing). Worst case: project 120+240, proposal 800+120+80, 8 changes x (2+80+200+13), 5 receipts x
 * (2+40+20+40+13+160+600+240) = 360+1000+2360+5575 = 9295, which leaves room for secret redaction to lengthen a string.
 * A receipt keeps its newest check lines (each at most WORK_COVERAGE_CHECK_LINE) while they fit WORK_COVERAGE_CHECK_CHARS:
 * six short reads, or three command lines that keep their full target and the end of their output, where a command's
 * verdict is (a receipt keeps fewer lines rather than cutting them).
 */
export const WORK_COVERAGE_CHECK_LINE = 200, WORK_COVERAGE_CHECK_CHARS = 600;
/** summary.coverage bounds (A3's labelled shape: one checkpoint and one request per state): the checkpoint whole up to
 * 32,000 characters (live summaries: 0.2K–7K), the request up to 2,400 as labelled. */
export const SUMMARY_COVERAGE_CHECKPOINT_CHARS = 32000, SUMMARY_COVERAGE_REQUEST_CHARS = 2400;
/** Hard bounds on the sources shown for one row of a revocation judgment (mind.judge `rows[].sources`). */
export const MIND_ROW_SOURCES = 8, MIND_ROW_SOURCE_CHARS = 400;
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const INTENTS = Object.freeze([
  ['stop', /停止|停一?下|停掉|别再|不要再|取消|中止|暂停|先别|\b(?:stop|cancel|halt|pause|abort|quit)\b/i],
  ['redirect', /改成|换成|改为|转而|改方向|优先做|先做|\b(?:instead|switch to|focus on|change direction|pivot|prioriti[sz]e)\b/i],
  ['fix', /修复|修一下|报错|错误|异常|崩溃|\b(?:fix|bug|error|broken|fails?|failing|crash)\b/i],
  ['explain', /解释|为什么|是什么|什么意思|怎么理解|原理|\b(?:explain|why|what is|what are|how does|meaning)\b/i],
  ['create', /写一|创建|生成|新建|实现|做一个|搭建|\b(?:create|write|build|implement|generate|make|scaffold)\b/i],
  ['edit', /修改|改一下|重构|调整|优化|更新|\b(?:edit|refactor|modify|update|change|tweak|improve)\b/i],
  ['search', /查一下|查找|搜索|检索|找一下|调研|\b(?:search|find|look up|lookup|research)\b/i],
  ['review', /审查|检查|评审|复核|看看|\b(?:review|check|audit|inspect)\b/i],
  ['run', /运行|执行|跑一下|部署|安装|发布|\b(?:run|execute|deploy|install|publish|launch)\b/i],
  ['plan', /计划|方案|设计|规划|架构|\b(?:plan|design|architecture|roadmap|strategy)\b/i],
  ['continue', /继续|接着|然后呢|\b(?:continue|go on|keep going|next)\b/i],
  ['recall', /之前|上次|记得|以前|前面说|\b(?:earlier|last time|remember|previous(?:ly)?|we discussed)\b/i],
  ['delete', /删除|清空|删掉|移除|\b(?:delete|remove|drop|wipe|erase)\b/i],
  ['greeting', /^\s*(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|好的?|嗯+|你好|您好|嗨|谢谢|多谢|收到|明白了?)[\s!！。.,，~～?？]*$/i],
]);
/** Short English labels for a Chinese or English message. Never numbers. */
export function textFeatures(text) {
  const value = String(text ?? ''), han = (value.match(/[一-鿿]/g) ?? []).length, latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return { language: !value.trim() ? 'none' : han && latin > han * 2 ? 'mixed' : han ? 'chinese' : latin ? 'english' : 'other', length: lengthBucket(value.length),
    hasCode: /```|`[^`\n]+`|\b(?:function|const|let|class|def|import|return)\b|[{};]\s*$|=>/m.test(value), hasPath: /(?:^|[\s"'(])(?:~?\/|\.\.?\/)[\w.@-]+\/?[\w./@-]*|\b[\w-]+\.(?:mjs|js|ts|tsx|py|md|json|css|html|go|rs|java|yaml|yml|toml|sh)\b/.test(value),
    hasUrl: /\bhttps?:\/\/\S+/i.test(value), isQuestion: /[?？]\s*$|^(?:为什么|怎么|如何|是否|能不能|可以吗|what|why|how|when|where|which|who|can|could|should|is|are|do|does)\b/i.test(value.trim()),
    intents: INTENTS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name).slice(0, 6) };
}
export function lengthBucket(chars) { return !Number.isFinite(chars) || chars <= 0 ? 'empty' : chars <= 20 ? 'very_short' : chars <= 120 ? 'short' : chars <= 600 ? 'medium' : chars <= 2000 ? 'long' : 'very_long'; }
/** Elapsed time as a named bucket (jev-1.13 is weak at date arithmetic). */
export function recencyBucket(ms) { return !Number.isFinite(ms) || ms < 0 ? 'never' : ms < 120000 ? 'just_now' : ms < 1800000 ? 'recent' : ms < 21600000 ? 'earlier_today' : ms < 86400000 ? 'within_a_day' : ms < 604800000 ? 'this_week' : 'stale'; }
export function countBucket(count) { return !Number.isFinite(count) || count <= 0 ? 'none' : count === 1 ? 'one' : count <= 4 ? 'few' : 'many'; }
const since = (now, at) => { const value = typeof at === 'number' ? at : Date.parse(at); return Number.isFinite(value) ? now - value : NaN; };

const COMMAND_FLAGS = Object.freeze([
  ['deletes_files', /\b(?:rm|rmdir|unlink|shred|trash)\b|\bgit\s+clean\b|-delete\b|\bdel\s+\/|Remove-Item/i],
  ['force_flag', /(?:^|\s)-(?:[a-zA-Z]*f[a-zA-Z]*|-force)\b/],
  ['privileged', /\bsudo\b|\bdoas\b|\bchmod\s+(?:-R\s+)?[0-7]*7[0-7]*\b|\bchown\b/i],
  ['network_write', /\bcurl\b[^|]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|\s-d\s|-F\s|--upload)|\bwget\b[^|]*--post|\bgit\s+push\b|\bnpm\s+publish\b|\bscp\b|\brsync\b[^|]*:\S|\bssh\b|\bgh\s+(?:pr|issue|release|repo)\s+(?:create|merge|delete|edit)/i],
  ['history_rewrite', /\bgit\s+(?:reset\s+--hard|push\s+[^|]*(?:--force|-f)\b|rebase|filter-branch|checkout\s+--\s|restore\s)/i],
  ['package_install', /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bcargo\s+install\b/i],
  ['database_change', /\b(?:DROP|TRUNCATE|ALTER)\s+(?:TABLE|DATABASE|SCHEMA)\b|\bDELETE\s+FROM\b/i],
  ['disk_or_system', /\b(?:dd|mkfs|diskutil|launchctl|systemctl|crontab|defaults\s+write|killall|pkill|kill\s+-9)\b/i],
  ['system_path', /(?:^|[\s"'=])(?:\/etc|\/usr|\/bin|\/sbin|\/System|\/Library|~\/Library|\/var|\/opt)(?:\/|\b)/],
  ['home_path', /(?:^|[\s"'=])(?:~\/|\$HOME\b|\/Users\/[^/\s]+\/?(?:\s|$))/],
]);
/** Code-extracted flags for a command or tool argument text. */
export function commandFeatures(text, { workspace } = {}) {
  const value = String(text ?? ''), flags = COMMAND_FLAGS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  const absolute = [...value.matchAll(/(?:^|[\s"'=:(])((?:~|\/)[^\s"'`;|&)]*)/g)].map(match => match[1]).filter(path => path.length > 1);
  const root = typeof workspace === 'string' && workspace.startsWith('/') ? workspace.replace(/\/+$/, '') : null;
  const outside = absolute.filter(path => !root || !(path === root || path.startsWith(`${root}/`)));
  const placement = /(?:^|[\s/])\.\.(?:\/|\s|$)/.test(value) || outside.length ? 'mentions_outside_workspace' : absolute.length ? 'inside_workspace_only' : 'relative_paths_only';
  return { flags, placement, length: lengthBucket(value.length) };
}

// Per-point allow-list of top-level state roots. Templates may only reference
// these roots with backtick paths; the kernel passes only these keys through.
export const DECISION_STATE_ROOTS = Object.freeze({
  // D1: `rulebook`: the lessons and working rules this message may call for (ids L<n>, M<n>), whose bodies the exposure questions read.
  'turn.route': ['turn', 'project', 'background', 'rulebook'],
  'turn.settled': ['turn', 'project', 'user'],
  'tool.admission': ['turn', 'tool'],
  'input.interjection': ['turn', 'input'],
  'feedback.signal': ['feedback', 'project'],
  'notes.worth': ['notes', 'project'],
  'ask.necessity': ['ask', 'user', 'project'],
  'gene.route': ['lesson', 'project'],
  'gene.review': ['gene', 'origin', 'existing', 'project', 'replaced'],
  'guard.triage': ['guard', 'project'],
  'turn.review': ['retro', 'project'],
  'invite.stale': ['invite', 'conversation', 'project'],
  'standard.link': ['link', 'project'],
  'gene.consolidate': ['consolidate', 'project'],
  'skill.retire': ['retire', 'recent', 'project'],
  'answer.match': ['answer', 'card'],
  'lesson.applied': ['reply', 'lessons'],
  'diagnostics.delivery': ['diag'],
  'schedule.suggest': ['recent', 'project'],
  'tool.constraint': ['write', 'rules'],
  'turn.drift': ['focus'],
  'turn.rewind': ['stuck'],
  'plan.better': ['proposal', 'project'],
  'commitment.due': ['due', 'project'],
  'share.resolved': ['topic'],
  // C3: which proactive message a user message answers (bucketed ages, ids positional D<n>).
  'reply.target': ['reply', 'project'],
  'attention.now': ['activity'],
  'evidence.select': ['learning', 'project'],
  'capability.disclosure': ['disclosure', 'project'],
  'context.forget': ['forget'],
  'session.resume': ['resume', 'project'],
  // Compaction coverage (raw probe only: the A3 baseline and the C5 fork probe): one checkpoint and one user request.
  'summary.coverage': ['checkpoint', 'request'],
  // Internal reasoning effort (spec p1 effort §3.3): the model call about to run, as code-computed facts beside its text.
  'effort.decision': ['call', 'project'],
  'effort.work': ['call', 'project'],
  'effort.narrator': ['call', 'project'],
  'effort.setup': ['call', 'project'],
  'effort.compaction': ['call', 'project'],
  'initiative.review': ['review', 'project'],
  // D2 (option B, shadow): the handoff of one finished background run, and what the user was told since.
  'work.completion': ['run', 'review', 'project'],
  // Receipts before changes, as the judge reads them: with the changes first, the labelled repeat iso-00ec913d fell from
  // covers 0.78-0.79 to 0.74, below its threshold (docs/research/jev-work-coverage-probe-20261004.md). No item is lost to the kernel's budget
  // either way: the state fits it by construction (WORK_COVERAGE_CHECK_CHARS) and the host does not judge a state the
  // kernel would cut (DecisionService.workCoverage: state_truncated).
  'work.coverage': ['proposal', 'receipts', 'changes', 'project'],
  'delivery.reach': ['message', 'user', 'recentDeliveries'],
  'message.check': ['message', 'recentDeliveries', 'project'],
  'initiative.direct': ['message', 'project'],
  'message.value': ['message', 'threads', 'findings', 'openItems', 'user', 'project'],
  'candidate.prescore': ['proposal', 'observed'],
  'skill.screen': ['project'],
  'tool.risk': ['tool', 'turn'],
  'memory.filter': ['turn', 'passages'],
  'mind.judge': ['mind', 'turn'],
});
// Paths that carry user- or model-authored text: instructions that read them
// must say that the text is data, not instructions (adversarial content).
export const UNTRUSTED_STATE_PATHS = Object.freeze(['turn.message', 'turn.request', 'turn.reply', 'turn.effects', 'tool.preview', 'tool.omitted', 'turn.progress', 'input.message', 'feedback.note', 'feedback.reply', 'ask.request', 'ask.questions', 'lesson.text', 'lesson.quote', 'gene', 'origin.text', 'existing', 'message.text', 'tool.arguments', 'passages', 'review.newEvidence', 'review.handoff', 'run.handoff', 'review.recentReports', 'review.currentTopic', 'recentDeliveries', 'receipts', 'changes', 'background.work', 'user.currentTopic', 'observed', 'proposal', 'mind', 'threads', 'findings', 'openItems', 'project.deliverable', 'notes', 'guard', 'retro', 'invite', 'conversation', 'link', 'retire', 'recent', 'answer', 'card', 'reply', 'lessons', 'diag', 'write', 'rules', 'focus', 'stuck', 'due', 'topic', 'activity', 'learning', 'disclosure', 'forget', 'call.task', 'call.evidence', 'call.message', 'call.request', 'review.foregroundTurn', 'review.backgroundWork', 'checkpoint', 'request', 'rulebook']);
/** The internal reasoning-effort points, one per purpose family (spec p1 effort §3.3). */
export const EFFORT_POINTS = Object.freeze(['effort.decision', 'effort.work', 'effort.narrator', 'effort.setup', 'effort.compaction']);
const FACT_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/** An effort call's facts as the judge may read them: at most 16 keys; booleans become yes/no, words and buckets stay
 * short, lists keep eight short words. Numbers never pass (AGENTS.md: amounts reach JEV as buckets computed in code). */
export function effortFacts(facts) {
  const out = {};
  for (const [key, value] of Object.entries(record(facts) ? facts : {})) {
    if (Object.keys(out).length >= 16 || !FACT_KEY.test(key)) continue;
    if (typeof value === 'boolean') out[key] = value ? 'yes' : 'no';
    else if (typeof value === 'string' && value.trim()) out[key] = clip(value, 80);
    else if (Array.isArray(value)) { const words = value.filter(item => typeof item === 'string' && item.trim()).slice(0, 8).map(item => clip(item, 60)); out[key] = words.length ? words : ['none']; }
  }
  return out;
}

/** A receipt's newest check lines, oldest first, while they fit WORK_COVERAGE_CHECK_CHARS (six short reads, three long commands). */
function checkLines(values) {
  const lines = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).slice(-WORK_COVERAGE_CHECKS).map(value => clip(value, WORK_COVERAGE_CHECK_LINE)), kept = [];
  for (let index = lines.length - 1, size = 0; index >= 0 && size + lines[index].length <= WORK_COVERAGE_CHECK_CHARS; index--) { kept.unshift(lines[index]); size += lines[index].length; }
  return kept;
}
/** D1: how many lessons and working rules one use judgment reads (the state is built to fit the point's budget: the sum of the
 * clips below, with the digest's, stays under it), and how much of a rule's body the judges read. */
export const USE_LESSON_LIMIT = 16, USE_METHOD_LIMIT = 8, EXPOSE_LESSON_LIMIT = 12, EXPOSE_METHOD_LIMIT = 8, RULE_TEXT_CHARS = 240, METHOD_TEXT_CHARS = 500;
/** The files whose written text one use judgment reads, and how much of each (turn-digest.mjs writtenExcerpts). */
export const EXCERPT_FILES_LIMIT = 3, EXCERPT_TEXT_CHARS = 720;
/** The rulebook one exposure question set reads: lessons (id L<n>: their text) and working rules (id M<n>: title, when, body). */
function ruleBook(input) {
  const lessons = (Array.isArray(input.lessons) ? input.lessons : []).slice(0, EXPOSE_LESSON_LIMIT), methods = (Array.isArray(input.methods) ? input.methods : []).slice(0, EXPOSE_METHOD_LIMIT);
  return { ...(lessons.length ? { lessons: lessons.map((row, index) => ({ id: `L${index}`, text: clip(row?.text, RULE_TEXT_CHARS) })) } : {}),
    ...(methods.length ? { methods: methods.map((row, index) => ({ id: `M${index}`, title: clip(row?.title, 60), ...(row?.when ? { when: clip(row.when, 160) } : {}), text: clip(row?.text, METHOD_TEXT_CHARS) })) } : {}) };
}
/** A turn digest's parts as state fields (each under the minimizer's string bound, the step lists under its list bound). */
function turnDigestState(digest) {
  const lines = (value, max, limit) => (Array.isArray(value) ? value : []).filter(row => typeof row === 'string' && row.trim()).slice(0, limit).map(row => clip(row, max));
  const first = lines(digest.firstSteps, 200, 6), last = lines(digest.lastSteps, 200, 14), excerpts = (Array.isArray(digest.excerpts) ? digest.excerpts : []).filter(row => row && typeof row.text === 'string' && row.text.trim()).slice(0, EXCERPT_FILES_LIMIT);
  return { request: clip(digest.request, 400), ...(first.length ? { firstSteps: first } : {}), ...(typeof digest.skipped === 'string' && digest.skipped ? { between: clip(digest.skipped, 40) } : {}), ...(last.length ? { lastSteps: last } : {}),
    ...(typeof digest.wrote === 'string' && digest.wrote ? { wrote: clip(digest.wrote, 1200) } : {}),
    // The start of what the last few files held (host code reads it from the turn's own record): a rule about the prose is judged from it.
    ...(excerpts.length ? { written: excerpts.map(row => ({ path: clip(row?.path, 200), text: clip(row?.text, EXCERPT_TEXT_CHARS) })) } : {}),
    ...(typeof digest.ended === 'string' && digest.ended ? { ended: clip(digest.ended, 40) } : {}), text: clip(digest.reply, 800) };
}
const projectKind = project => ({ title: clip(project?.title, 160), kind: (project?.taskTypes ?? []).filter(value => typeof value === 'string').slice(0, 4), ...(project?.deliverable ? { deliverable: clip(project.deliverable, 600) } : {}) });
/** Builds the object-shaped state for one decision point. Only fields the
 * point's questions need are included; unknown input fields are dropped. */
export function buildDecisionState(point, input = {}, { now = Date.now() } = {}) {
  const roots = DECISION_STATE_ROOTS[point];
  if (!roots) throw Object.assign(new Error(`Decision state: unknown point ${point}`), { code: 'invalid_point' });
  const state = {};
  const turn = message => ({ message: clip(message, 2400), features: textFeatures(message) });
  if (point === 'turn.route') {
    state.turn = { ...turn(input.message), mode: input.mode === 'plan' ? 'plan' : 'normal', hasAttachments: input.hasAttachments === true, previousTurn: ['failed', 'stopped'].includes(input.previousStatus) ? input.previousStatus : input.previousStatus ? 'completed' : 'none',
      lastUserMessage: recencyBucket(since(now, input.previousUserAt)), ...(input.previousReply ? { previousReply: clip(input.previousReply, 600) } : {}) };
    if (input.project) state.project = { title: clip(input.project.title, 160), goal: clip(input.project.goal, 400) };
    const work = (input.background ?? []).filter(record).slice(-3);
    state.background = { active: work.length ? 'yes' : 'no', work: work.map(row => clip(`${row.kind ?? 'work'} (${row.status ?? 'running'}): ${row.summary ?? ''}`, 240)) };
    // D1 exposure: the rules that may apply to this message, each with its body (AGENTS.md: rules sent with their body beat
    // titles plus summaries). Host code picks and orders them; ids are positional (L<n> lessons, M<n> working rules).
    if (record(input.rulebook)) state.rulebook = ruleBook(input.rulebook);
  } else if (point === 'initiative.review') {
    const evidence = (input.evidence ?? []).filter(record).slice(-6);
    // Wake routing (Headlong's code-computed routing signals): what is open and who it waits on, as buckets.
    const open = record(input.openWork) ? input.openWork : {};
    // Rows are readable text the host wrote (request, reply excerpt, receipt names), not JSON whose first 200 characters
    // are ids (live 2026-10-04: JEV saw ~90 characters of the reply and no receipt). recentReports lists the latest
    // foreground replies next to the proactive ones, each labelled, so `already_reported` can see what the user was told.
    // Work in progress (PDL-2), first so the kernel's budget keeps it: the reply the assistant is writing now (its request)
    // and background work queued or running. Present only while there is such work, so other wakes keep v2's state.
    const progress = {
      ...(record(input.foregroundTurn) ? { foregroundTurn: { running: true, since: recencyBucket(since(now, input.foregroundTurn.since)), request: clip(input.foregroundTurn.request, 400) } } : {}),
      ...(Array.isArray(input.backgroundWork) && input.backgroundWork.length ? { backgroundWork: input.backgroundWork.filter(record).slice(0, 3).map(row => clip(`${row.status ?? 'running'}: ${row.intent ?? ''}`, 240)) } : {}),
    };
    state.review = { ...progress, newEvidence: evidence.map(row => clip(`${row.type ?? 'evidence'}: ${row.summary ?? row.text ?? ''}`, 420)), newEvidenceAmount: countBucket(evidence.length), handoff: clip(input.handoff, 400),
      lastReport: recencyBucket(since(now, input.lastReportAt)), lastUserMessage: recencyBucket(since(now, input.lastUserAt)), userActive: input.userActive === true,
      recentReports: (input.recentReports ?? []).slice(-4).map(text => clip(text, 300)), currentTopic: clip(input.currentTopic, 300), pendingQuestions: countBucket(input.pendingQuestions ?? 0),
      newSinceLastDecision: countBucket(Number.isFinite(input.freshCount) ? input.freshCount : evidence.length),
      openWork: { pendingRequests: countBucket(open.commitments), overdueRequests: countBucket(open.overdue), openAgenda: countBucket(open.agenda), waitingOnUser: countBucket(open.awaitingUser), heldFindings: countBucket(open.heldFindings) },
      lastWake: ['work', 'thought', 'failed', 'deferred'].includes(input.lastWake) ? input.lastWake : 'none' };
    if (input.project) state.project = { title: clip(input.project.title, 160), goal: clip(input.project.goal, 400), phase: clip(input.project.phase, 40) };
  } else if (point === 'work.completion') {
    // D2 (option B, shadow): one finished background run, and nothing else. `run.handoff` is the worker's own last line
    // (done, left, where, next step); `review.recentReports` is what the user was told (the same labelled rows the initiative
    // gate reads, the run's own line among them). What the host knows by code (a scheduled occurrence, a run that resolves a
    // request, a run that ended without a report, the change set, how many files) never reaches the judge: code routes on it.
    // The review that follows a completion is the main model's, and `names_next_step` / `reports_untold` ask only what the
    // handoff literally says (mu goal-met.ts:7-17: closing-message booleans are too thin for "is it done"; never asked here).
    state.run = { handoff: clip(input.handoff, 400) };
    state.review = { recentReports: (input.recentReports ?? []).slice(-4).map(text => clip(text, 300)) };
    if (input.project) state.project = { title: clip(input.project.title, 160), goal: clip(input.project.goal, 400) };
  } else if (point === 'work.coverage') {
    // A background work the main model proposed, the checks that already covered the same ground (receipts R<n>: the host
    // keeps only those that ran where the proposal will look, newest first) and what changed since (changes C<n>, picked
    // by time and owner in code). Which receipt a change post-dates is code's business; the judge sees times as buckets.
    // Every clip below is part of the WORK_COVERAGE_CHECK_CHARS budget arithmetic: change one, recheck the sum.
    const proposal = record(input.proposal) ? input.proposal : {};
    state.proposal = { intent: clip(proposal.intent, 800), ...(proposal.title ? { title: clip(proposal.title, 120) } : {}), where: clip(proposal.where, 80) };
    state.receipts = (input.receipts ?? []).filter(record).slice(0, WORK_COVERAGE_RECEIPTS).map((row, index) => ({ id: `R${index}`, source: clip(row.source, 40), status: clip(row.status, 20), where: clip(row.where, 40), when: recencyBucket(since(now, row.at)),
      asked: clip(row.asked, 160), checks: checkLines(row.checks), ...(row.result ? { result: clip(row.result, 240) } : {}) }));
    state.changes = (input.changes ?? []).filter(record).slice(0, WORK_COVERAGE_CHANGES).map((row, index) => ({ id: `C${index}`, kind: clip(row.kind, 80), text: clip(row.text, 200), when: recencyBucket(since(now, row.at)) }));
    if (input.project) state.project = { title: clip(input.project.title, 120), goal: clip(input.project.goal, 240) };
  } else if (point === 'delivery.reach' || point === 'message.check') {
    // Project kind decides which references a user needs (a failing test path in a coding project, the delivered file itself).
    if (point === 'message.check') state.project = projectKind(input.project);
    state.message = { text: clip(input.text, 1600), kind: input.kind === 'ask' ? 'question' : 'finding', features: textFeatures(input.text) };
    if (point === 'delivery.reach') { state.message.requestedTier = input.requestedTier ?? 'unknown'; state.user = { lastMessage: recencyBucket(since(now, input.lastUserAt)), activeConversation: input.activeConversation === true, currentTopic: clip(input.currentTopic, 300) }; }
    state.recentDeliveries = (input.recent ?? []).slice(-6).map(row => ({ text: clip(row.message ?? row.text, 240), reaction: typeof row.reaction === 'string' ? row.reaction : 'none', when: recencyBucket(since(now, row.at)) }));
  } else if (point === 'turn.settled') {
    // The user's instruction, the final reply and what was actually done this turn (tool effects, not prose).
    state.turn = { request: clip(input.request, 2400), reply: clip(input.reply, 2400), effects: (input.effects ?? []).filter(value => typeof value === 'string' && value).slice(-16).map(value => clip(value, 200)), continuedAlready: countBucket(input.continuations ?? 0) };
    state.project = projectKind(input.project);
    // How this user treated the last requests for a reaction (answered, dismissed, left to lapse): asking is paced by that, not by a counter.
    if (input.recentFeedbackAsks?.length) state.user = { recentFeedbackAsks: input.recentFeedbackAsks.slice(-6).map(row => ({ outcome: ['answered', 'dismissed', 'expired'].includes(row.outcome) ? row.outcome : 'open', when: recencyBucket(since(now, row.at)) })) };
  } else if (point === 'gene.route') {
    // One learned rule and the kind of project: what mechanism should it become?
    state.lesson = { kind: clip(input.kind, 40), text: clip(input.text, 1000), quote: clip(input.quote, 800), source: clip(input.source, 40) };
    state.project = projectKind(input.project);
  } else if (point === 'gene.review') {
    // A proposed gene, the feedback it came from, and the active genes it must not contradict.
    state.gene = { layer: clip(input.layer, 20), title: clip(input.title, 160), summary: clip(input.summary, 400), body: clip(input.body, 2400), ...(input.trigger ? { trigger: clip(input.trigger, 200) } : {}) };
    state.origin = { text: clip(input.origin, 1000) };
    state.existing = (input.existing ?? []).slice(0, 12).map((row, index) => ({ id: `g${index}`, layer: clip(row.layer, 20), title: clip(row.title, 160), summary: clip(row.summary, 300) }));
    // A rewrite that replaces rules (gene.consolidate): what each replaced rule required.
    if (Array.isArray(input.replaced) && input.replaced.length) state.replaced = input.replaced.slice(0, 4).map((row, index) => ({ id: `r${index}`, title: clip(row?.title, 160), text: clip(row?.text, 1200) }));
    state.project = projectKind(input.project);
  } else if (point === 'feedback.signal') {
    // The user's rating and note on one reply, and the reply itself.
    state.feedback = { vote: input.vote === 'up' ? 'helpful' : input.vote === 'down' ? 'not_helpful' : 'none', note: clip(input.note, 1000), reply: clip(input.reply, 900) };
    state.project = projectKind(input.project);
  } else if (point === 'guard.triage') {
    // One guard run: the rule it enforces and the lines it matched (ids are positional H<n>).
    state.guard = { title: clip(input.title, 160), rule: clip(input.rule, 1000), file: clip(input.file, 200), hits: (input.hits ?? []).slice(0, 8).map((row, index) => ({ id: `H${index}`, excerpt: clip(row?.excerpt, 240), ...(row?.note ? { note: clip(row.note, 160) } : {}) })) };
    state.project = projectKind(input.project);
  } else if (point === 'turn.review') {
    // A corrected turn: what was asked, what was replied, the correction, and the notes already in force (E<n>).
    state.retro = { request: clip(input.request, 1200), reply: clip(input.reply, 1500), correction: clip(input.correction, 1000), existing: (input.existing ?? []).slice(0, 10).map((row, index) => ({ id: `E${index}`, text: clip(row, 300) })) };
    state.project = projectKind(input.project);
  } else if (point === 'invite.stale') {
    // An invitation left open during a long absence, and the conversation since it was offered.
    state.invite = { kind: clip(input.kind, 40), text: clip(input.text, 600), age: recencyBucket(since(now, input.createdAt)) };
    state.conversation = (input.conversation ?? []).slice(-8).map(row => clip(`[${row?.role ?? 'message'}] ${row?.text ?? ''}`, 500));
    state.project = projectKind(input.project);
  } else if (point === 'gene.consolidate') {
    // A proposed rule and the existing rules of the same kind (ids are positional R<n>).
    state.consolidate = { layer: clip(input.layer, 20), candidate: { title: clip(input.title, 120), summary: clip(input.summary, 300), body: clip(input.body, 900) },
      // Up to 6 rules with their text (rule against rule), or up to 20 by title and summary (new content placed among all rules).
      existing: (input.existing ?? []).slice(0, 20).map((row, index) => ({ id: `R${index}`, title: clip(row?.title, 120), summary: clip(row?.summary, (input.existing ?? []).length > 6 ? 160 : 300), ...(row?.body ? { body: clip(row.body, 600) } : {}) })) };
    state.project = projectKind(input.project);
  } else if (point === 'standard.link') {
    // A check (guard) and the project's acceptance standards (ids are positional S<n>).
    state.link = { check: { title: clip(input.title, 160), summary: clip(input.summary, 400) }, standards: (input.standards ?? []).slice(0, 8).map((row, index) => ({ id: `S${index}`, text: clip(row, 300) })) };
    state.project = projectKind(input.project);
  } else if (point === 'skill.retire') {
    // A capability that has gone unused, and what the user has been asking for lately.
    state.retire = { kind: clip(input.kind, 20), name: clip(input.name, 120), summary: clip(input.summary, 400), usage: clip(input.usage, 60) };
    state.recent = (input.recent ?? []).slice(-8).map(row => clip(row, 300));
    state.project = projectKind(input.project);
  } else if (point === 'answer.match') {
    // The message the user typed and the open card's questions (ids are positional Q<n>, options O<n>).
    state.answer = { message: clip(input.message, 1500) };
    state.card = { questions: (input.questions ?? []).slice(0, 3).map((row, index) => ({ id: `Q${index}`, question: clip(row?.question, 400), options: (row?.options ?? []).slice(0, 8).map((option, at) => ({ id: `O${at}`, label: clip(option?.label, 160) })) })) };
  } else if (point === 'lesson.applied') {
    // A finished turn and the rules that were in its context (ids are positional: L<n> lessons, M<n> working rules). `digest`
    // (D1): the turn as the shared digest reads it (turn-digest.mjs: the request, the first and the last steps, the paths the
    // turn wrote, how it ended, the end of its reply); without it the reply text alone (the first version of this point).
    const digest = record(input.digest) ? input.digest : null;
    state.reply = digest ? turnDigestState(digest) : { request: clip(input.request, 800), text: clip(input.reply, 2400) };
    const lessons = Array.isArray(input.lessons) ? input.lessons : [], methods = Array.isArray(input.methods) ? input.methods : [];
    state.lessons = { rules: lessons.slice(0, USE_LESSON_LIMIT).map((row, index) => ({ id: `L${index}`, kind: clip(row?.kind ?? 'lesson', 20), text: clip(row?.text, RULE_TEXT_CHARS) })),
      ...(methods.length ? { methods: methods.slice(0, USE_METHOD_LIMIT).map((row, index) => ({ id: `M${index}`, title: clip(row?.title, 60), when: clip(row?.when, 160), text: clip(row?.text, METHOD_TEXT_CHARS) })) } : {}) };
  } else if (point === 'diagnostics.delivery') {
    // The request being worked on, the edited file and its warnings (ids are positional W<n>).
    state.diag = { request: clip(input.request, 800), file: clip(input.file, 200), tool: clip(input.tool, 20), warnings: (input.warnings ?? []).slice(0, 6).map((row, index) => ({ id: `W${index}`, code: clip(row?.code, 40), message: clip(row?.message, 300) })) };
  } else if (point === 'schedule.suggest') {
    // The user's recent requests with a coarse day and time of day (ids are positional R<n>).
    state.recent = (input.requests ?? []).slice(-12).map((row, index) => ({ id: `R${index}`, text: clip(row?.text, 300), day: clip(row?.day, 20), time: clip(row?.time, 20) }));
    state.project = projectKind(input.project);
  } else if (point === 'tool.constraint') {
    // A pending write (its target and the text it would put there) and the user's stated constraints (C<n>).
    state.write = { tool: clip(input.tool, 40), path: clip(input.path, 200), text: clip(input.text, 1500) };
    state.rules = (input.rules ?? []).slice(0, 8).map((row, index) => ({ id: `C${index}`, text: clip(row, 240) }));
  } else if (point === 'turn.drift') {
    // What the user asked, and the latest steps of a long turn.
    state.focus = { request: clip(input.request, 1000), recent: (input.recent ?? []).slice(-10).map(row => clip(row, 200)) };
  } else if (point === 'turn.rewind') {
    // A failure that keeps repeating, and the attempts that ended in it.
    state.stuck = { request: clip(input.request, 1000), failure: clip(input.failure, 400), attempts: (input.attempts ?? []).slice(-6).map(row => clip(row, 240)) };
  } else if (point === 'plan.better') {
    // A proactive question that may propose a different approach from the one the user asked for.
    state.proposal = { question: clip(input.question, 800), userApproach: clip(input.userApproach, 800), evidence: clip(input.evidence, 1200) };
    state.project = projectKind(input.project);
  } else if (point === 'commitment.due') {
    // Pending requests with a coarse age, and the recent conversation (ids are positional C<n>).
    state.due = { commitments: (input.commitments ?? []).slice(0, 6).map((row, index) => ({ id: `C${index}`, request: clip(row?.request, 300), age: recencyBucket(since(now, row?.createdAt)) })), conversation: (input.conversation ?? []).slice(-6).map(row => clip(row, 300)) };
    state.project = projectKind(input.project);
  } else if (point === 'share.resolved') {
    // The proactive topic's latest messages and the user's reply to it.
    state.topic = { messages: (input.messages ?? []).slice(-3).map(row => clip(row, 400)), reply: clip(input.reply, 800) };
  } else if (point === 'reply.target') {
    // The message the user typed, the proactive messages still waiting for a reaction (newest first, ids positional D<n>,
    // each with its kind and how long before the message it was sent, as a bucket) and the assistant's latest reply to the
    // user's own request when it came after the oldest of them (docs/research/jev-reply-target-probe-20261005.md).
    state.reply = { message: clip(input.message, 1200),
      deliveries: (input.deliveries ?? []).slice(0, 5).map((row, index) => ({ id: `D${index}`, kind: clip(row?.kind ?? 'message', 30), ...(Number.isFinite(row?.ageMs) ? { sent: recencyBucket(row.ageMs) } : {}), text: clip(row?.text, 400) })),
      ...(input.latestReply ? { latestReply: clip(input.latestReply, 400) } : {}) };
    state.project = projectKind(input.project);
  } else if (point === 'attention.now') {
    // Coarse activity signals (labels, not numbers) and the last few exchanges.
    state.activity = { typing: input.typing === true ? 'typing' : 'not_typing', pace: clip(input.pace, 30), since_last_message: clip(input.sinceLast, 30), recent: (input.recent ?? []).slice(-4).map(row => clip(row, 200)) };
  } else if (point === 'evidence.select') {
    // Learning episodes (ids are positional E<n>): their kind and bounded summary.
    state.learning = { episodes: (input.episodes ?? []).slice(0, 8).map((row, index) => ({ id: `E${index}`, kind: clip(row?.kind, 60), summary: clip(row?.summary, 700) })) };
    state.project = projectKind(input.project);
  } else if (point === 'capability.disclosure') {
    // The opening request and the tool services assigned to the project (ids are positional S<n>).
    state.disclosure = { request: clip(input.request, 1000), services: (input.services ?? []).slice(0, 8).map((row, index) => ({ id: `S${index}`, name: clip(row?.name, 80), description: clip(row?.description, 300), tools: (row?.tools ?? []).slice(0, 16).map(name => clip(name, 60)) })) };
    state.project = projectKind(input.project);
  } else if (point === 'session.resume') {
    // An idle conversation: bucketed idle time and activity (computed by the host), its last exchange and open plan items.
    state.resume = { idle: clip(input.idle, 30), conversationTurns7d: clip(input.conversationTurns, 30), latestConversation: input.latest === true ? 'yes' : 'no', projectTurns7d: clip(input.projectTurns, 30),
      lastUserMessage: clip(input.lastUserMessage, 600), lastReply: clip(input.lastReply, 400), openPlan: (input.plan ?? []).slice(0, 4).map(row => clip(row, 200)) };
    state.project = projectKind(input.project);
  } else if (point === 'summary.coverage') {
    // A compaction checkpoint (its line breaks kept: it is a structured summary; the caller may append the file lists its
    // record carries) and one user request, as A3 labelled them (docs/research/compaction-summary-coverage-20261005.md).
    // Raw probe only: the kernel's minimizer cuts a string at 2,400 characters and a checkpoint is longer.
    const checkpoint = String(input.checkpoint ?? '').trim();
    state.checkpoint = checkpoint.length > SUMMARY_COVERAGE_CHECKPOINT_CHARS ? `${checkpoint.slice(0, SUMMARY_COVERAGE_CHECKPOINT_CHARS - 1)}…` : checkpoint;
    state.request = String(input.request ?? '').trim().slice(0, SUMMARY_COVERAGE_REQUEST_CHARS);
  } else if (EFFORT_POINTS.includes(point)) {
    // The internal model call about to run: its purpose, facts computed in code, and only the text the judgment needs
    // (the task, the newest evidence, the flagged message, the latest request). Worst case ≈5.9K of the kernel's 8,000.
    state.call = { purpose: point.slice('effort.'.length), facts: effortFacts(input.facts),
      ...(input.task ? { task: clip(input.task, 1200) } : {}),
      ...(Array.isArray(input.evidence) && input.evidence.length ? { evidence: input.evidence.filter(row => typeof row === 'string' && row.trim()).slice(-6).map(row => clip(row, 300)) } : {}),
      ...(input.message ? { message: clip(input.message, 1600) } : {}),
      ...(input.request ? { request: clip(input.request, 600) } : {}) };
    state.project = { title: clip(input.project?.title, 120), kind: (input.project?.taskTypes ?? []).filter(value => typeof value === 'string').slice(0, 4) };
  } else if (point === 'context.forget') {
    // The current request, the latest steps, and earlier tool results (ids are positional R<n>) with a bounded preview.
    state.forget = { request: clip(input.request, 1200), recent: (input.recent ?? []).slice(-8).map(row => clip(row, 200)), results: (input.results ?? []).slice(0, 12).map((row, index) => ({ id: `R${index}`, tool: clip(row?.toolName, 80), arguments: clip(row?.args, 300), preview: clip(row?.preview, 600) })) };
  } else if (point === 'notes.worth') {
    // The user's recent messages and the notes already kept about them.
    state.notes = { messages: (input.messages ?? []).slice(-8).map(row => clip(row, 500)), existing: (input.existing ?? []).slice(0, 24).map(row => clip(row, 200)) };
    state.project = projectKind(input.project);
  } else if (point === 'ask.necessity') {
    // What the user asked for, the questions the assistant wants to put to them, and whether they are here.
    state.ask = { request: clip(input.request, 1200), questions: (input.questions ?? []).slice(0, 3).map(row => ({ question: clip(row.question, 500), options: (row.options ?? []).slice(0, 8).map(option => clip(option.label, 160)) })) };
    if (Array.isArray(input.known) && input.known.length) state.ask.known = input.known.slice(0, 10).map(row => clip(row, 240));
    state.user = { state: input.present === true ? 'present' : 'away' };
    state.project = projectKind(input.project);
  } else if (point === 'input.interjection') {
    // What the user asked, what the assistant is writing right now, and the message that just arrived.
    state.turn = { request: clip(input.request, 1200), progress: clip(input.progress, 900) };
    state.input = { message: clip(input.message, 1200), features: textFeatures(input.message) };
  } else if (point === 'tool.admission') {
    // One oversized tool result: what the user asked, what stayed visible, and the omitted middle in chunks.
    state.turn = { request: clip(input.request, 1600) };
    state.tool = { name: clip(input.name, 80), preview: clip(input.preview, 1600), omitted: (input.chunks ?? []).slice(0, 12).map((row, index) => ({ id: `c${index}`, lines: clip(row.lines, 40), text: clip(row.text, 700) })) };
  } else if (point === 'initiative.direct') {
    // A proactive finding and what kind of project it is about; nothing about the user is needed.
    state.message = { text: clip(input.text, 2400), features: textFeatures(input.text) };
    state.project = projectKind(input.project);
  } else if (point === 'message.value') {
    // Narrator value questions (K2): the candidate message, open conversation threads (with what each already said) and what was already told.
    state.message = { text: clip(input.text, 2400), kind: input.kind === 'ask' ? 'question' : input.kind === 'schedule' ? 'scheduled_delivery' : 'finding', features: textFeatures(input.text) };
    state.threads = (input.threads ?? []).slice(0, 5).map((row, index) => ({ id: `thread_${index}`, title: clip(row.title, 160), recent: (row.messages ?? []).slice(-2).map(text => clip(text, 400)), lastMessage: recencyBucket(since(now, row.lastMessageAt)) }));
    state.project = projectKind(input.project);
    state.findings = (input.findings ?? []).slice(-8).map(row => ({ summary: clip(row.summary ?? row, 400), when: recencyBucket(since(now, row.lastSharedAt)) }));
    state.openItems = (input.openItems ?? []).slice(0, 6).map(text => clip(text, 200));
    state.user = { lastMessage: recencyBucket(since(now, input.lastUserAt)), currentTopic: clip(input.currentTopic, 300) };
  } else if (point === 'candidate.prescore') {
    state.proposal = { summary: clip(input.summary, 900), hypothesis: clip(input.hypothesis, 900), changedAreas: (input.changedAreas ?? []).filter(value => typeof value === 'string').slice(0, 10) };
    state.observed = (input.evidence ?? []).filter(record).slice(-6).map(row => clip(`${row.type ?? 'signal'}: ${row.summary ?? ''}`, 400));
  } else if (point === 'skill.screen') {
    state.project = { title: clip(input.title, 200), goal: clip(input.goal, 400), taskTypes: (input.taskTypes ?? []).filter(value => typeof value === 'string').slice(0, 6) };
  } else if (point === 'tool.risk') {
    const text = typeof input.arguments === 'string' ? input.arguments : JSON.stringify(input.arguments ?? {});
    state.tool = { name: clip(input.name, 80), effect: ['read', 'write', 'exec'].includes(input.effect) ? input.effect : 'write', arguments: clip(text, 1600), features: commandFeatures(text, { workspace: input.workspace }) };
    if (input.message !== undefined) state.turn = turn(input.message);
  } else if (point === 'memory.filter') {
    state.turn = turn(input.message);
    state.passages = (input.passages ?? []).slice(0, 16).map((text, index) => ({ id: `p${index}`, text: clip(text, 700) }));
  } else if (point === 'mind.judge') {
    // Ids are positional (L<n>, C<n>) and match the template's questions.
    if (input.message !== undefined) state.turn = turn(input.message);
    if (Array.isArray(input.rows)) {
      // Revocation (C4): rows that may still lean on what was withdrawn (ids N<n>, positional), what was withdrawn, and what is
      // left, and nothing else (unrelated text lowers accuracy, AGENTS.md). A row's `sources` are the texts of the messages
      // that still stand behind it, never the removed ones.
      // Which sources of a row to show, and how much of each, is the caller's choice (the nearest remaining messages of a note, chosen in
      // code: the sources a note links are the whole batch it was written from, most of which never said it); these are the hard bounds.
      // The kernel cuts a state past its limit (a judge asked about a row it cannot see answers about nothing), so the caller fits the
      // rows of one call into it (decision-service mindStale splits them into as many calls as that takes).
      state.mind = { rows: input.rows.slice(0, 12).map((row, index) => ({ id: `N${index}`, kind: clip(row?.kind ?? 'note', 12), text: clip(row?.text, 240), ...(Array.isArray(row?.sources) ? { sources: row.sources.slice(0, MIND_ROW_SOURCES).map(text => clip(text, MIND_ROW_SOURCE_CHARS)) } : {}) })),
        ...(input.revoked !== undefined ? { revoked: clip(input.revoked, 300) } : {}),
        // D4 (covered): the rules the model reads in every request, ids R<n>, that the rows are asked against.
        ...(Array.isArray(input.rules) ? { rules: input.rules.slice(0, 24).map((row, index) => ({ id: `R${index}`, text: clip(typeof row === 'string' ? row : row?.text, 240) })) } : {}),
        ...(input.tools ? { tools: { withdrawn: (input.tools.withdrawn ?? []).slice(0, 8).map(name => clip(name, 100)), available: (input.tools.available ?? []).slice(0, 40).map(name => clip(name, 40)) } } : {}) };
      return state;
    }
    state.mind = { ...(input.candidate !== undefined ? { candidate: clip(input.candidate, 400) } : {}),
      lessons: (input.lessons ?? []).slice(0, 12).map((row, index) => ({ id: `L${index}`, kind: clip(row?.kind ?? 'lesson', 20), text: clip(row?.text, 240) })),
      commitments: (input.commitments ?? []).slice(0, 8).map((row, index) => ({ id: `C${index}`, request: clip(row?.request, 300), age: recencyBucket(since(now, row?.createdAt)) })),
      evidence: (input.evidence ?? []).slice(-6).map(text => clip(text, 600)) };
    // Reconciliation: each open item carries its own host-selected passages (strings). The text is cut to the passage budget, then
    // the `[role · age] ` label goes on (cutting after the label took the last ~30 characters of every full window away).
    if (Array.isArray(input.items)) state.mind.items = input.items.slice(0, 4).map((row, index) => ({ id: `A${index}`, kind: clip(row?.kind ?? 'item', 20), text: clip(row?.text, 300), age: recencyBucket(since(now, row?.createdAt)),
      passages: (row?.passages ?? []).slice(0, 3).map(passage => `[${passage.role ?? 'message'} · ${recencyBucket(since(now, passage.at))}] ${clip(passage.text ?? '', 420)}`) }));
  }
  return state;
}
