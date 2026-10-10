// D4 labelled cases (docs/research/mind-d4-probes-20261005.md). Synthetic, labelled by hand, from a Chinese novel project and an
// English code project; every text is invented for the probe (none is read from a live conversation).
//
// RESTATES (MIND-5): a user message beside the user's pending requests (newest first, as the host offers them). `label`:
// `req_<i>`, the pending request the message asks for again or tells the assistant to carry on with, or `none` (a new request,
// a question, or about something else, even on the same topic or file). `hard`: a case whose label a careful reader could dispute.
//
// PROMISE (MIND-4): a final reply (`sentence`: a distinctive part of the sentence that states the promise), labelled `true` when it commits the assistant to specific further work of its own, later, and
// without needing anything more from the user; `false` otherwise (a report of work done, an offer or a plan that waits for the
// user's answer, a description of how something works, a general intention). `regex`: what the retired agent_promise rule would
// do is computed by the probe from the production function, not labelled here.

const NOVEL = { title: '长篇小说《雾港》', goal: '写完并修订 30 章，人物和时间线前后一致' };
const CODE = { title: 'Billing service', goal: 'Keep the invoice API correct and its tests green' };
const AI = { title: 'AI 应用调研', goal: '跟踪并总结 AI 应用方向的新进展' };

const N12 = '明天把第 12 章写完发我', NREL = '整理全书的人物关系表，写完告诉我', NFRI = '每周五提醒我备份稿件';
const CTEST = 'Run the full test suite and tell me what fails when it finishes', CCSV = 'Add CSV export for invoices', CDOC = 'Update the README with the new deploy steps once the release is tagged';
const ASRC = '周末前把本周收集的十个来源整理成一页摘要给我';

export const RESTATES_CASES = [
  // --- the same message sent again, or asked again in other words
  { id: 'n-exact-resend', project: NOVEL, pending: [N12, NREL, NFRI], message: N12, label: 'req_0' },
  { id: 'n-paraphrase', project: NOVEL, pending: [N12, NREL, NFRI], message: '第 12 章明天要写完，写完发给我。', label: 'req_0' },
  { id: 'n-nudge', project: NOVEL, pending: [N12, NREL, NFRI], message: '还没写完吧？把第 12 章写完发我。', label: 'req_0' },
  { id: 'n-second-exact', project: NOVEL, pending: [N12, NREL, NFRI], message: '整理全书的人物关系表，写完告诉我。', label: 'req_1' },
  { id: 'n-second-paraphrase', project: NOVEL, pending: [N12, NREL, NFRI], message: '人物关系表做好了就发我。', label: 'req_1' },
  { id: 'n-third-reminder', project: NOVEL, pending: [N12, NREL, NFRI], message: '别忘了每周五提醒我备份。', label: 'req_2' },
  { id: 'n-resent-after-failure', project: NOVEL, pending: [NREL], message: '（重新提交）整理全书的人物关系表，写完告诉我。', label: 'req_0' },
  { id: 'n-english-resend', project: NOVEL, pending: [N12, NREL], message: 'Please write chapter 12 and send it to me tomorrow.', label: 'req_0' },
  // --- carrying on with it
  { id: 'n-continue-by-name', project: NOVEL, pending: [N12, NREL, NFRI], message: '继续写第 12 章。', label: 'req_0' },
  { id: 'n-continue-bare-single', project: NOVEL, pending: [N12], message: '接着做吧。', label: 'req_0', hard: true },
  { id: 'n-continue-bare-many', project: NOVEL, pending: [N12, NREL, NFRI], message: '接着做吧。', label: 'none', hard: true },
  { id: 'n-continue-remaining', project: NOVEL, pending: [NREL, N12], message: '把人物关系表剩下的部分做完。', label: 'req_0' },
  { id: 'n-continue-card', project: NOVEL, pending: [N12, NREL], message: '接着完成：整理全书的人物关系表，写完告诉我', label: 'req_1' },
  { id: 'n-prioritise', project: NOVEL, pending: [N12, NREL], message: '关系表先放一放，现在先把第 12 章写出来。', label: 'req_0', hard: true },
  // --- a new request on the same topic or file is not the pending one
  { id: 'n-same-file-title', project: NOVEL, pending: [N12, NREL, NFRI], message: '把第 12 章的标题改成《夜雨》。', label: 'none' },
  { id: 'n-same-chapter-scene', project: NOVEL, pending: [N12, NREL, NFRI], message: '第 12 章里加一段雨中的追逐，两百字左右。', label: 'none' },
  { id: 'n-same-chapter-check', project: NOVEL, pending: [N12, NREL, NFRI], message: '帮我检查第 12 章有没有错别字。', label: 'none' },
  { id: 'n-same-topic-table', project: NOVEL, pending: [N12, NREL, NFRI], message: '人物关系表里，反派的亲属要不要单独列一栏？', label: 'none' },
  { id: 'n-table-extra', project: NOVEL, pending: [N12, NREL, NFRI], message: '关系表再加一列“首次出场章节”。', label: 'none', hard: true },
  { id: 'n-other-chapter', project: NOVEL, pending: [N12, NREL, NFRI], message: '把第 11 章也写完，明天一起发我。', label: 'none' },
  { id: 'n-backup-other', project: NOVEL, pending: [N12, NREL, NFRI], message: '现在就备份一次稿件。', label: 'none' },
  // --- asking how it stands, cancelling it, or something unrelated
  { id: 'n-status', project: NOVEL, pending: [N12, NREL, NFRI], message: '第 12 章写得怎么样了？', label: 'none' },
  { id: 'n-cancel', project: NOVEL, pending: [N12, NREL, NFRI], message: '第 12 章不用写了，先放着。', label: 'none' },
  { id: 'n-lookup', project: NOVEL, pending: [N12, NREL, NFRI], message: '主角的口头禅是什么？', label: 'none' },
  { id: 'n-greeting', project: NOVEL, pending: [N12, NREL, NFRI], message: '早上好', label: 'none' },
  { id: 'n-opinion', project: NOVEL, pending: [N12, NREL], message: '你觉得结尾用开放式好还是交代清楚好？', label: 'none' },
  { id: 'n-standing-rule', project: NOVEL, pending: [N12, NREL, NFRI], message: '以后每章结尾都留一个悬念。', label: 'none' },
  { id: 'n-ai-new', project: AI, pending: [ASRC], message: '再帮我找三篇关于 agent 评测的论文。', label: 'none' },
  { id: 'n-ai-resend', project: AI, pending: [ASRC], message: '周末前给我一页摘要，用本周收集的十个来源。', label: 'req_0' },
  { id: 'n-ai-status', project: AI, pending: [ASRC], message: '摘要进度怎么样？', label: 'none' },
  // --- an English code project
  { id: 'c-exact', project: CODE, pending: [CCSV, CTEST], message: 'Add CSV export for invoices.', label: 'req_0' },
  { id: 'c-paraphrase', project: CODE, pending: [CCSV, CTEST], message: 'Please run the whole test suite and let me know the failures when it is done.', label: 'req_1' },
  { id: 'c-continue', project: CODE, pending: [CCSV, CTEST], message: 'Go ahead and continue with the CSV export.', label: 'req_0' },
  { id: 'c-nudge', project: CODE, pending: [CCSV, CTEST], message: 'Still waiting on the CSV export for invoices, can you do it now?', label: 'req_0' },
  { id: 'c-new-format', project: CODE, pending: [CCSV, CTEST], message: 'Add JSON export for invoices too.', label: 'none' },
  { id: 'c-new-entity', project: CODE, pending: [CCSV, CTEST], message: 'Add CSV export for customers.', label: 'none' },
  { id: 'c-status', project: CODE, pending: [CCSV, CTEST], message: 'Did the test run finish?', label: 'none' },
  { id: 'c-same-file', project: CODE, pending: [CCSV, CTEST], message: 'In invoices.js, rename totalAmt to totalAmount.', label: 'none' },
  { id: 'c-unrelated', project: CODE, pending: [CCSV, CTEST], message: 'What does the retry middleware do on a 429?', label: 'none' },
  { id: 'c-conditional-doc', project: CODE, pending: [CDOC], message: 'The release is tagged now, update the README with the deploy steps.', label: 'req_0' },
  { id: 'c-doc-other', project: CODE, pending: [CDOC], message: 'Update the CHANGELOG for the release.', label: 'none' },
];

export const PROMISE_CASES = [
  // --- the reply commits the assistant to specific later work of its own
  { id: 'y-after-reply-part', project: NOVEL, request: '把第 12 章写完，今晚发我。', reply: '第 12 章的前两节已经写好，保存在 chapters/12.md。第三节的收尾我会在今晚写完，写完后把全文发给你。', sentence: '第三节的收尾我会在今晚写完', label: true },
  { id: 'y-tomorrow-check', project: NOVEL, request: '那个失效的链接修好了吗？', reply: '链接已经恢复到 notes/harbor.md。明天上午我会再检查一次这些链接是否仍然有效，有变化会告诉你。', sentence: '明天上午我会再检查一次', label: true },
  { id: 'y-after-build', project: CODE, request: 'Kick off the release build.', reply: 'The release build is running in the background. Once it finishes I will report the artifact sizes and any warnings back to you.', sentence: 'Once it finishes I will report', label: true },
  { id: 'y-tonight-benchmarks', project: CODE, request: 'Compare the two parsers.', reply: 'I compared them on the small fixtures: the second is about twice as fast. I will rerun the comparison on the full corpus tonight and post the numbers tomorrow morning.', sentence: 'I will rerun the comparison', label: true },
  { id: 'y-next-round-names', project: NOVEL, request: '核对前十章的人名一致性。', reply: '前五章已核对，发现「长明」在第 3 章写成了「常明」，已改正。后五章我会在接下来的回合里继续核对，核对完给你完整清单。', sentence: '后五章我会在接下来的回合里继续核对', label: true },
  { id: 'y-daily-digest', project: AI, request: '每天帮我盯一下 agent 评测方向的新论文。', reply: '好的，今天先整理了三篇。之后我会每天汇总一次新出现的论文，附上一句话评价。', sentence: '之后我会每天汇总一次', label: true },
  { id: 'y-followup-migration', project: CODE, request: 'Dry-run the migration.', reply: 'The dry run is queued. I will follow up with the migration diff and the list of affected tables once it completes.', sentence: 'I will follow up with the migration diff', label: true },
  { id: 'y-report-back-sources', project: AI, request: '把这批来源核对一下。', reply: '已核对 4 个来源，其余 6 个需要联网抓原文。我会在抓取完成后把无法找到原文的来源单独标出来发给你。', sentence: '我会在抓取完成后', label: true },
  { id: 'y-finish-rest', project: NOVEL, request: '改写第 1 章开头，要更有悬念。', reply: '第 1 章开头已改好。第 2 章开头我会照同样的写法接着改，改完告诉你。', sentence: '第 2 章开头我会照同样的写法接着改', label: true },
  // --- no promise of the assistant's own
  { id: 'n-conditional-confirm', project: NOVEL, request: '开始写第 13 章。', reply: '第 13 章的大纲有两种走法：A 让船长在第 13 章就现身，B 留到第 15 章。你确认选哪一种之后我就开始写。', label: false },
  { id: 'n-offer', project: NOVEL, request: '把第 3 章压缩到 3000 字。', reply: '已压缩到 2960 字，保存在 chapters/03.md。如果你同意这个压缩方式，我可以把同样的做法应用到前十章。', label: false },
  { id: 'n-if-needed', project: CODE, request: 'Fix the null reduce in totals.js.', reply: 'Fixed: totals.js now treats a missing line_items list as empty, and the invoice test passes. If you need it, I can also add a regression test.', label: false },
  { id: 'n-report-done', project: NOVEL, request: '把第 12 章写完并保存。', reply: '第 12 章已写完，共 3200 字，保存在 chapters/12.md。', label: false },
  { id: 'n-describes-behaviour', project: CODE, request: 'What does the retry middleware do on a 429?', reply: 'On a 429 it reads the Retry-After header and waits that long, then retries up to three times. After the third failure it will throw a RateLimitError that the caller can handle.', label: false },
  { id: 'n-general-intention', project: NOVEL, request: '注意人物的语气要一致。', reply: '明白，我会注意保持每个人物的语气前后一致。', label: false },
  { id: 'n-needs-user-first', project: CODE, request: 'Update the theme.', reply: 'I need you to pick a colour scheme first, light or dark. Then I will update the theme and the screenshots accordingly.', label: false },
  { id: 'n-question-then-continue', project: NOVEL, request: '把人物关系表整理一下。', reply: '关系表里「顾昭」和「顾钊」可能是同一个人，你想把他们合并成一个条目吗？选好后我会接着整理。', label: false },
  { id: 'n-user-says-continue', project: NOVEL, request: '写第 14 章。', reply: '第 14 章第一节已写好。下次你直接说“继续”，我就会接着写第二节。', label: false },
  { id: 'n-let-me-know', project: CODE, request: 'Add the retry middleware.', reply: 'The retry middleware is added and its tests pass. Let me know if you want different back-off settings.', label: false },
  { id: 'n-explains-future-tense', project: AI, request: '这个评测基准是怎么打分的？', reply: '它会先让模型完成任务，然后由评审模型按 5 个维度打分，最后取平均值作为总分。之后的版本会加入人工抽检。', label: false },
  { id: 'n-recap', project: NOVEL, request: '总结一下今天做了什么。', reply: '今天写完了第 11、12 章，核对了前十章的人名，修好了两处失效链接。', label: false },
  { id: 'n-asks-for-input', project: AI, request: '把这周的来源整理一下。', reply: '我整理了 7 个来源，另外有 3 个没有原文链接。你能把这 3 个的链接补给我吗？有了链接我就把摘要补全。', label: false },
  // --- hard: a schedule already carries the later work; a promise phrased as a possibility
  { id: 'h-scheduled-already', project: AI, request: '每周一帮我汇总一次新论文。', reply: '已经为你建了每周一 09:00 的定时任务，会自动汇总新论文并发到这个对话里。', label: false, hard: true },
  { id: 'h-possibility', project: CODE, request: 'Profile the slow endpoint.', reply: 'The slowest call is the per-line tax lookup. I may profile it again after the cache change, depending on what the numbers look like.', label: false, hard: true },
  { id: 'h-promise-with-question', project: NOVEL, request: '写第 20 章。', reply: '第 20 章第一节已写好。第二节我会在今晚写完发给你；另外想问一下，船长这里要不要提前露面？', sentence: '第二节我会在今晚写完发给你', label: true, hard: true },
];

// WAITING (D4 review): the reply that took a request on, and whether it ended waiting for something only the user can give (a decision,
// missing information, access, an approval) so that the work still left cannot go on. `label: true`: it waits for the user. `false`: it
// finished, reports a result, goes on by itself, picks a default, or only offers something optional or asks about what comes next. What a
// `true` verdict does in the host: the request that reply answered is not owed by Rna (not overdue, not judged, not pursued) until the user
// speaks again in that conversation, so a wrong "waiting" silences a request; a missed one leaves it owed as before.
export const WAITING_CASES = [
  // --- the work left is blocked on the user
  { id: 'w-ending-conflict', project: NOVEL, request: '按新大纲重写第 12 章。', reply: '新大纲里第 3 节和第 5 节给了两个互相冲突的结局，我先没有动笔。你想保留哪一个结局？', label: true },
  { id: 'w-token-needed', project: CODE, request: 'Deploy the billing service to staging.', reply: 'The deploy needs the staging API token, which I do not have in this environment. Please add it to the project secrets or paste it here and I will continue from there.', label: true },
  { id: 'w-two-spellings', project: NOVEL, request: '整理全书的人物关系表。', reply: '表格框架已经搭好。有三个人物的名字在前十章里出现了两种写法（林舟和林洲），请告诉我以哪一个为准，我再统一后继续。', label: true },
  { id: 'w-voided-invoices', project: CODE, request: 'Add CSV export for invoices.', reply: 'Before I change the schema: should the export include voided invoices? Answer yes or no and I will implement it.', label: true },
  { id: 'w-login-needed', project: NOVEL, request: '把稿件备份到网盘。', reply: '我这边没有网盘的登录权限，需要你先在网盘里授权这个应用。授权完告诉我，我再开始备份。', label: true },
  { id: 'w-breaking-change', project: CODE, request: 'Upgrade the ORM to v5.', reply: 'The upgrade needs a breaking change to the migration folder layout. I will not touch that without your approval. Do you approve?', label: true },
  { id: 'w-missing-links', project: AI, request: '周末前把本周的十个来源整理成一页摘要。', reply: '我只收到了 6 个来源的链接，另外 4 个还没有。把剩下的链接发给我，我就开始整理。', label: true },
  { id: 'w-half-done-ask', project: NOVEL, request: '把第 12 章里的人名统一改成新名单。', reply: '第一节已经改完。第二节里「老周」是新名单里的哪一位，我拿不准；你告诉我对应关系，我再接着改。', label: true },
  // --- not waiting: finished, reporting, going on by itself, a default taken, or an optional question about something else
  { id: 'f-chapter-done', project: NOVEL, request: '明天把第 12 章写完发我。', reply: '第 12 章已经写完，约 3200 字，保存在 chapters/12.md。', label: false },
  { id: 'f-test-results', project: CODE, request: 'Run the full test suite and tell me what fails.', reply: 'The suite ran: 212 passed, 3 failed (test_invoice_rounding, test_vat_zero, test_export_header). The traces are in the output above.', label: false },
  { id: 'f-optional-offer', project: NOVEL, request: '整理全书的人物关系表。', reply: '已经整理好，共 14 个人物，放在 notes/人物关系.md。如果你想按阵营分组，我也可以再调整一版。', label: false },
  { id: 'f-optional-json', project: CODE, request: 'Add CSV export for invoices.', reply: 'Done: the export is added with tests, and the existing suite still passes. Let me know if you would like a JSON variant as well.', label: false },
  { id: 'f-names-fixed', project: NOVEL, request: '检查前十章的人名是否一致。', reply: '检查完了，发现 2 处不一致，已在第 3 章和第 8 章统一为「林舟」。', label: false },
  { id: 'f-carry-on-itself', project: CODE, request: 'Refactor the invoice module.', reply: 'I refactored the first two files. The other three follow the same pattern, so I will carry on with them in my next steps.', label: false },
  { id: 'f-schedule-created', project: NOVEL, request: '每周五提醒我备份稿件。', reply: '已经建立每周五上午的备份提醒日程。', label: false },
  { id: 'f-explained', project: CODE, request: 'Explain why the build is slow.', reply: 'The slow step is dependency resolution: it re-fetches the lockfile on every run. Caching the lockfile directory brings the build from about 4 minutes to 50 seconds.', label: false },
  { id: 'f-plan-then-start', project: AI, request: '把这批来源整理成摘要。', reply: '我分两步做：先抽取每个来源的要点，再合并成一页。第一步现在就开始。', label: false },
  { id: 'f-flaky-fixed', project: CODE, request: 'Fix the flaky test.', reply: 'I fixed the race in the test setup and reran it 20 times: all green. Optionally I could add a retry in CI; say so if you want it.', label: false },
  { id: 'f-promise-only', project: NOVEL, request: '明天把第 12 章写完发我。', reply: '好的，我会在明天之前写完第 12 章并发给你。', label: false },
  { id: 'f-summary-more-detail', project: AI, request: '总结一下这份评测报告。', reply: '总结：这份报告比较了五个智能体评测集，结论是任务成功率与步数上限强相关。需要更详细的逐项对比的话告诉我。', label: false },
  // --- hard: a careful reader could dispute the label
  { id: 'h-done-then-next', project: NOVEL, request: '把第 12 章写完发我。', reply: '第 12 章写完了，保存在 chapters/12.md。下一章你想写战斗还是日常线？', label: false, hard: true },
  { id: 'h-default-taken', project: CODE, request: 'Export the report.', reply: 'I can export it as CSV (fast, loses the formatting) or as XLSX (slower, keeps it). I am going with XLSX unless you object.', label: false, hard: true },
  { id: 'h-needs-confirm-later', project: NOVEL, request: '改写第 3 章的开头。', reply: '开头已经改写好了，放在 chapters/03-draft.md，没有覆盖原文。你看过之后告诉我要不要替换原文。', label: false, hard: true },
  { id: 'h-partial-ask-optional', project: CODE, request: 'Clean up the unused imports.', reply: 'Removed the unused imports in 14 files. Two imports in billing/legacy.py look unused but are re-exported; I left them. Tell me if I should remove them too.', label: false, hard: true },
];
