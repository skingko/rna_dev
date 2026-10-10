// Labelled cases for docs/research/jev-delivery-evidence-probe-20261010.md. Every text is synthetic (shaped after the real
// reconcile situations of the live projects, nothing copied): one open agenda item, a short conversation after it, and one
// proactive delivered message that carries `initiative.deliverables`. `expect` is whether the item is settled by what the
// conversation shows (yes) or not (no); `kind` names the situation:
//   settled      the deliverable alone says the item's artifact exists (the message text is vague or silent about it)
//   unsettled    deliverables exist but only a draft, a part, a plan or something else
//   irrelevant   the message and its deliverables are about a neighbouring thing (same words, other subject)
//   long-tail    a delivered message past the 6000-character cut, the deliverables after it settle (or do not settle) the item
//   mid-tail     a message of about 690 characters: the deliverables start where no 420-character window holds a whole entry
//   many-files   eight deliverables (more than one window), the item concerns the sixth or none
//   long-body    a long message whose own text, in the middle, settles (or refutes) the item; the deliverables are beside the point
export const T0 = Date.parse('2026-10-01T00:00:00Z');
const basename = path => path.split('/').pop();
const file = (path, description) => ({ path, name: basename(path), description });

// ---- long bodies (deterministic, ~6.2-6.8K characters, none of them about the item)
const ORGS = ['Orbis Labs', 'Kestrel AI', 'Mantle Robotics', 'Quill Systems', 'Harbor Compute', 'Lumen Research', 'Tidewater Data', 'Nimbus Works', 'Ferrous AI', 'Aster Models', 'Brightwell', 'Cobalt Vision', 'Delta Loom'];
const THINGS = ['开源了一个 7B 推理模型', '发布了新的向量检索库 1.4', '更新了多模态接口的计费方式', '公开了安全评测基准', '推出面向代码审查的小模型', '宣布与两家芯片厂商合作', '修复了评测集泄漏的问题', '发布了语音合成的流式接口'];
const SOURCES = ['官方博客', '项目仓库发布页', '论文预印本', '官方公告邮件', '二手转载（未核实）'];
const IMPACT = ['对本地部署的用户影响较小，主要是兼容性提示。', '可能影响现有调用方的成本估算，建议下周复核。', '对检索类应用有直接帮助，但需要先在小数据上验证。', '暂时只看到单一来源，先放入监测区。', '与上周的更新方向一致，没有新的风险点。'];
export const newsBody = ({ count = 24, header = '# AI 日报', insertAt = null, insert = '' } = {}) => {
  const parts = [`${header}\n> 窗口 24h｜正式条目 ${count} 条｜跨日去重已完成\n## 一、新闻`];
  for (let index = 0; index < count; index++) {
    if (insertAt === index && insert) parts.push(insert);
    parts.push(`### ${index + 1}.【新】${ORGS[index % ORGS.length]}${THINGS[(index * 3) % THINGS.length]}\n来源：${SOURCES[(index * 2) % SOURCES.length]}｜日期：2026-10-0${1 + (index % 7)}\n- 事实：${ORGS[(index + 5) % ORGS.length]}的公告写明了版本号、适用范围和发布时间，细节与官方页面一致。\n- 影响：${IMPACT[(index * 2 + 1) % IMPACT.length]}`);
  }
  return parts.join('\n\n');
};
const CHAPTER = ['夜里的渡口没有灯，水声却比白天更清楚。', '她把船篙插进泥里，听见远处有人在敲更。', '老船夫说，过了子时的客人，最好别问来处。', '岸上的雾慢慢退开，露出一排没有影子的石墩。', '他攥紧了袖中的符纸，指节发白，没有出声。', '风从芦苇丛里穿过去，带着一股潮湿的纸灰味。'];
export const chapterBody = (paragraphs = 40) => Array.from({ length: paragraphs }, (_, index) => `${CHAPTER[index % CHAPTER.length]}${CHAPTER[(index * 5 + 2) % CHAPTER.length]}第${index + 1}段，场景推进，人物状态记录如下：体力${60 + (index % 30)}，警觉${40 + (index * 7) % 50}。`).join('\n');
const ENGLISH_DIGEST = Array.from({ length: 46 }, (_, index) => `Item ${index + 1}: the ${['parser', 'scheduler', 'billing', 'export', 'search', 'auth'][index % 6]} team reported ${['two flaky tests', 'a slow query', 'a config drift', 'an unused flag', 'a stale cache'][index % 5]} on ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][(index * 2) % 5]}; owner notified, no user impact so far, follow-up tracked in the weekly review.`).join('\n');

/** Unrelated status prose of exactly `length` characters (so a file list appended after it starts at a chosen offset). */
const PROSE = { zh: ['今晚的巡检没有发现新的异常，几条旧告警维持原状。', '来源核对按既定顺序进行，二手转载一律先放监测区再看后续。', '备份任务在凌晨完成，耗时与上周相近，没有出现重试。', '定时任务的下一次运行安排在明早，参数沿用上一轮的配置。', '磁盘占用保持在正常范围，日志按天归档，旧文件已清理。'], en: ['The overnight check found nothing new; the older alerts are unchanged.', 'Source verification followed the usual order, secondhand reposts stay in monitoring first.', 'The backup finished before dawn, taking about as long as last week with no retries.', 'The next scheduled run is tomorrow morning with the previous parameters.', 'Disk usage stays in the normal range and old logs were rotated away.'] };
export const proseTo = (length, language = 'zh') => { let text = ''; for (let index = 0; text.length < length; index++) text += PROSE[language][index % PROSE[language].length]; return `${text.slice(0, length - 1)}${language === 'zh' ? '。' : '.'}`; };

// ---- the conversation around the delivered message
const DISTRACTORS = {
  zh: [['user', '先别管排版，内容准确最重要。'], ['assistant', '收到，我先核对来源再继续。'], ['delivered', '监测摘要：今天没有新的异常，下次检查在明早。']],
  en: [['user', 'Accuracy first, formatting can wait.'], ['assistant', 'Understood, I will check the sources before I continue.'], ['delivered', 'Monitoring digest: nothing unusual today, next check tomorrow morning.']],
};
const make = (id, kind, expect, language, item, key, extra = {}) => ({ id, kind, expect, language, item: { kind: item.kind ?? 'todo', text: item.text }, key, ...extra });
const zh = (id, kind, expect, item, text, deliverables, extra) => make(id, kind, expect, 'zh', item, { role: 'delivered', text, deliverables }, extra);
const en = (id, kind, expect, item, text, deliverables, extra) => make(id, kind, expect, 'en', item, { role: 'delivered', text, deliverables }, extra);

export const CASES = [
  // ---------------------------------------------------------------- settled by the deliverable alone
  zh('S01', 'settled', 'yes', { text: '把 2026-10-08 的 AI 日报放到 reports/2026-10-08/ 目录' }, '本轮已跑完，二手来源的 2 条已单独标注，详情见附件。', [file('reports/2026-10-08/daily.md', '2026-10-08 日报正文（7 条正式条目 + 3 条监测，校验 12/12 通过）')]),
  zh('S02', 'settled', 'yes', { text: '给第 12 章写完整初稿并存到 正文/卷一/' }, '按上次说的节奏推进了，这章的钩子放在结尾。', [file('正文/卷一/第012章-夜渡.md', '第 12 章完整初稿，约 3200 字，结尾留钩子')]),
  zh('S03', 'settled', 'yes', { text: '做一个能一键跑完全部曲目的 BGM 对比工具' }, '工具放好了，打开就能看到结果，有两对曲子偏近。', [file('tools/bgm-diff.html', 'BGM 全量对比工具，覆盖全部 19 首，打开即跑并标出雷同')]),
  zh('S04', 'settled', 'yes', { text: '写一个按日期范围导出 CSV 的脚本' }, '脚本已按要求做了，用法写在文件头注释里。', [file('scripts/export_csv.py', 'CSV 导出脚本，支持 --from/--to 日期范围')]),
  zh('S05', 'settled', 'yes', { text: '产出本周周报 PDF' }, '周报在这里，下周一前不再改动。', [file('reports/week-41.pdf', '第 41 周周报，6 页，含指标与风险')]),
  zh('S06', 'settled', 'yes', { text: '为登录页做一版移动端设计稿' }, '第二版出来了，按你的反馈去掉了渐变。', [file('design/login-mobile-v2.png', '登录页移动端设计稿 v2，375px 宽')]),
  zh('S07', 'settled', 'yes', { text: '准备一份竞品价格对比表（xlsx）' }, '整理完了，有 3 家需要你确认口径。', [file('data/competitor-prices.xlsx', '5 家竞品价格对比，含口径备注')]),
  zh('S08', 'settled', 'yes', { text: '建立跨日去重索引并落盘到 data/index/', kind: 'intention' }, '今晚的任务跑完了，没有报错。', [file('data/index/dedupe.json', '跨日去重索引，共 412 个键，按日期可回溯')]),
  en('S09', 'settled', 'yes', { text: 'Write the release notes for v2.3 into docs/' }, 'Done for this round; two items need your wording check.', [file('docs/release-notes-2.3.md', 'Release notes for v2.3: 14 changes grouped by area')]),
  en('S10', 'settled', 'yes', { text: 'Export the dashboard screenshots for the audit' }, 'Finished. Tell me if the crop is wrong.', [file('audit/dashboard-screenshots.zip', '12 dashboard screenshots at 1440px, one per panel')]),
  zh('S11', 'settled', 'yes', { text: '整理第三章的人物关系图' }, '第三章整理好了，人物数比预想的多。', [file('设定集/第三章人物关系.md', '第三章 14 个人物及相互关系（mermaid 图）')]),
  zh('S12', 'settled', 'yes', { text: '出一份数据库迁移回滚方案文档' }, '方案写完了，风险点在结尾列了。', [file('docs/migration-rollback.md', '迁移回滚方案：步骤、校验点、耗时估计')]),
  // ---------------------------------------------------------------- deliverables exist, the item is not settled
  zh('N01', 'unsettled', 'no', { text: '给第 12 章写完整初稿并存到 正文/卷一/' }, '第 12 章的大纲和人物状态先出来了，正文还没动。', [file('设定集/第012章大纲.md', '第 12 章大纲与人物状态表，尚无正文')]),
  zh('N02', 'unsettled', 'no', { text: '产出本周周报 PDF' }, '周报的数据部分汇总好了，PDF 排版还没做。', [file('data/week-41.csv', '第 41 周原始指标汇总，未排版')]),
  zh('N03', 'unsettled', 'no', { text: '导出审计用的仪表盘截图' }, '截图脚本写好了，还没跑。', [file('scripts/shoot.mjs', '仪表盘截图脚本（尚未运行）')]),
  en('N04', 'unsettled', 'no', { text: 'Write the release notes for v2.3 into docs/' }, 'I drafted the outline only; the body comes next.', [file('docs/release-outline.md', 'Outline for the v2.3 release notes, headings only')]),
  zh('N05', 'unsettled', 'no', { text: '为登录页做一版移动端设计稿' }, '桌面端设计稿更新了，移动端是下一步。', [file('design/login-desktop-v3.png', '登录页桌面端设计稿 v3')]),
  zh('N06', 'unsettled', 'no', { text: '建立跨日去重索引并落盘到 data/index/', kind: 'intention' }, '索引的设计文档写好了，实现等你确认方案。', [file('docs/dedupe-design.md', '去重索引设计方案，待确认')]),
  zh('N07', 'unsettled', 'no', { text: '准备一份竞品价格对比表（xlsx）' }, '已经找到 2 家的价格，其余 3 家的官网要登录。', [file('data/prices-partial.csv', '2 家竞品价格（共需 5 家），缺 3 家')]),
  zh('N08', 'unsettled', 'no', { text: '完成第一卷 100 章正文', kind: 'intention' }, '本轮推进到第 31 章。', [file('正文/卷一/第031章.md', '第 31 章正文，约 3000 字')]),
  zh('N09', 'unsettled', 'no', { text: '修复支付回调的重复扣款' }, '定位到原因了：回调没做幂等。方案在文件里，代码还没改。', [file('docs/payment-callback-fix-plan.md', '幂等修复方案，未实施')]),
  zh('N10', 'unsettled', 'no', { text: '确定最终版封面并导出' }, '候选封面 3 张，等你选。', [file('design/cover-candidates.zip', '3 张候选封面，均为草图')]),
  // ---------------------------------------------------------------- the message and its files are about a neighbouring thing
  zh('I01', 'irrelevant', 'no', { text: '给第 12 章写完整初稿并存到 正文/卷一/' }, '第 11 章终稿校对完了，改了 4 处错别字。', [file('正文/卷一/第011章-终稿.md', '第 11 章终稿，已校对')]),
  zh('I02', 'irrelevant', 'no', { text: '把 2026-10-08 的 AI 日报放到 reports/2026-10-08/ 目录' }, '2026-10-07 的日报已发出。', [file('reports/2026-10-07/daily.md', '2026-10-07 日报正文')]),
  zh('I03', 'irrelevant', 'no', { text: '为登录页做一版移动端设计稿' }, '注册页的桌面设计稿完成了。', [file('design/register-desktop.png', '注册页桌面端设计稿')]),
  en('I04', 'irrelevant', 'no', { text: 'Write the release notes for v2.3 into docs/' }, 'The v2.2 release notes are published.', [file('docs/release-notes-2.2.md', 'Release notes for v2.2')]),
  zh('I05', 'irrelevant', 'no', { text: '写一个按日期范围导出 CSV 的脚本' }, 'CSV 导入脚本做好了，会自动识别编码。', [file('scripts/import_csv.py', 'CSV 导入脚本，自动识别 GBK/UTF-8')]),
  zh('I06', 'irrelevant', 'no', { text: '建立跨日去重索引并落盘到 data/index/', kind: 'intention' }, '日报里的去重记录一栏补全了。', [file('reports/2026-10-08/daily.md', '2026-10-08 日报正文，含去重记录栏')]),
  zh('I07', 'irrelevant', 'no', { text: '做一个能一键跑完全部曲目的 BGM 对比工具' }, '音效的响度统一好了。', [file('assets/sfx-normalized.zip', '全部音效统一响度到 -16 LUFS')]),
  zh('I08', 'irrelevant', 'no', { text: '产出本周周报 PDF' }, '月报模板更新好了。', [file('templates/monthly.md', '月报模板，新增风险栏')]),
  // ---------------------------------------------------------------- long message, the deliverables sit after the 6000-character cut
  zh('L01', 'long-tail', 'yes', { text: '同时产出机读版 news.json（含每条证据的 sha256）' }, newsBody({ count: 49, header: '# AI 日报 · 2026-10-08' }), [file('reports/2026-10-08/daily.md', '日报正文，49 条条目'), file('reports/2026-10-08/news.json', '机读清单：49 条条目，每条带 evidence sha256')]),
  zh('L02', 'long-tail', 'yes', { text: '把第 5 章增补稿存为 正文/卷一/第005章-v2.md' }, chapterBody(95), [file('正文/卷一/第005章-v2.md', '第 5 章增补稿，已替换原稿')]),
  zh('L03', 'long-tail', 'yes', { text: '产出带图表的周报 PDF' }, newsBody({ count: 49, header: '# 本周动态摘要' }), [file('reports/week-41.pdf', '周报 PDF，含 3 张图表，共 8 页')]),
  en('L04', 'long-tail', 'yes', { text: 'Publish the changelog as docs/changelog-2.3.md' }, ENGLISH_DIGEST, [file('docs/changelog-2.3.md', 'Changelog for v2.3, 14 entries')]),
  zh('L05', 'long-tail', 'no', { text: '产出带图表的周报 PDF' }, newsBody({ count: 49, header: '# 本周动态摘要' }), [file('data/week-41-charts.csv', '图表原始数据，尚未出图')]),
  zh('L06', 'long-tail', 'no', { text: '同时产出机读版 news.json（含每条证据的 sha256）' }, newsBody({ count: 49, header: '# AI 日报 · 2026-10-08' }), [file('reports/2026-10-08/daily.md', '日报正文，49 条条目')]),
  // ---------------------------------------------------------------- mid-length message: the file entry that decides starts near 700 characters, where a 420-character window with a 360 step has no window holding a 150-character span
  zh('M01', 'mid-tail', 'yes', { text: '整理 2026-10-08 的机读清单 news.json' }, proseTo(690), [file('reports/2026-10-08/news.json', '2026-10-08 机读清单：12 条正式条目加 4 条监测，每条含 evidence sha256、pipelineRun 运行细节与去重键'), file('reports/2026-10-08/daily.md', '日报正文')]),
  zh('M02', 'mid-tail', 'yes', { text: '更新设定集的进度与时间线，登记本轮 10 章扩容的字数与验证结论' }, proseTo(690), [file('设定集/07-进度与时间线.md', '本轮 10 章扩容逐章前后字数、验证结论与待裁定项，已登记在进度与时间线第 36 条'), file('正文/卷一/第008章.md', '第 8 章正文')]),
  en('M03', 'mid-tail', 'yes', { text: 'Add the migration checklist to docs/runbook-migration.md' }, proseTo(682, 'en'), [file('docs/runbook-migration.md', 'Runbook section with the migration checklist: pre-checks, cutover steps, rollback triggers and the sign-off table'), file('docs/changelog.md', 'Changelog')]),
  zh('M04', 'mid-tail', 'yes', { text: '把赛道调参记录写进 tuning.md，每次单变量改动和结果都要记' }, proseTo(690), [file('docs/tuning.md', '赛道调参记录：逐次单变量改动、圈速结果与回退说明，含冰面与水膜两组对照实验的全部数据'), file('assets/track-9.json', '赛道 9 数据')]),
  zh('M05', 'mid-tail', 'no', { text: '整理 2026-10-08 的机读清单 news.json' }, proseTo(690), [file('reports/2026-10-08/daily.md', '2026-10-08 日报正文：12 条正式条目加 4 条监测，含来源可信度标签与跨日去重记录，机读清单尚未生成'), file('reports/2026-10-08/notes.md', '备注')]),
  en('M06', 'mid-tail', 'no', { text: 'Add the migration checklist to docs/runbook-migration.md' }, proseTo(682, 'en'), [file('docs/runbook-draft.md', 'Draft outline of the migration runbook: headings only, the checklist section is still to be written by the owner'), file('docs/changelog.md', 'Changelog')]),
  // ---------------------------------------------------------------- eight deliverables (a list longer than a window); the item concerns the sixth, or none
  zh('K01', 'many-files', 'yes', { text: '把第 6 章的人物状态表导出成 xlsx' }, '这一轮的产出都在下面了。', Array.from({ length: 8 }, (_, index) => index === 5 ? file('设定集/第006章人物状态表.xlsx', '第 6 章人物状态表，14 人，含体力与警觉度逐段记录') : file(`正文/卷一/第00${index + 1}章.md`, `第 ${index + 1} 章正文，约 3000 字，已通过字数与红线词检查`))),
  zh('K02', 'many-files', 'no', { text: '把第 9 章的人物状态表导出成 xlsx' }, '这一轮的产出都在下面了。', Array.from({ length: 8 }, (_, index) => file(`正文/卷一/第00${index + 1}章.md`, `第 ${index + 1} 章正文，约 3000 字，已通过字数与红线词检查`))),
  // ---------------------------------------------------------------- long message whose own text settles or refutes the item
  zh('B01', 'long-body', 'yes', { text: '确认三条红线词的复核已经通过' }, newsBody({ count: 49, header: '# AI 日报 · 2026-10-08', insertAt: 24, insert: '### 复核\n红线词复核：3 条全部通过，没有命中。' }), [file('reports/2026-10-08/daily.md', '日报正文')]),
  zh('B02', 'long-body', 'no', { text: '确认三条红线词的复核已经通过' }, newsBody({ count: 49, header: '# AI 日报 · 2026-10-08', insertAt: 24, insert: '### 复核\n红线词复核：3 条中有 2 条未通过，待改后重查。' }), [file('reports/2026-10-08/daily.md', '日报正文')]),
];
export const distractors = language => DISTRACTORS[language];

/** Background-work handoffs as the evidence of an open item (`--handoff` mode): the worker's last line, with and without its marker. */
export const HANDOFF_CASES = [
  { id: 'H01', expect: 'yes', language: 'zh', item: '把 2026-10-08 的 AI 日报放到 reports/2026-10-08/ 目录', handoff: '日报已写入 reports/2026-10-08/daily.md，校验 12/12 通过。' },
  { id: 'H02', expect: 'yes', language: 'zh', item: '写一个按日期范围导出 CSV 的脚本', handoff: 'scripts/export_csv.py 已完成，支持 --from/--to，已自测通过。' },
  { id: 'H03', expect: 'yes', language: 'en', item: 'Write the release notes for v2.3 into docs/', handoff: 'docs/release-notes-2.3.md is written: 14 changes, reviewed against the tag list.' },
  { id: 'H04', expect: 'yes', language: 'zh', item: '建立跨日去重索引并落盘到 data/index/', handoff: 'data/index/dedupe.json 已生成，共 412 个键，抽样 20 条核对一致。' },
  { id: 'H05', expect: 'yes', language: 'zh', item: '修复支付回调的重复扣款', handoff: '回调幂等已实现并合入，重放 100 次回调只扣一次，测试通过。' },
  { id: 'H06', expect: 'no', language: 'zh', item: '给第 12 章写完整初稿并存到 正文/卷一/', handoff: '第 12 章的大纲和人物状态已出，正文尚未开始，等你确认方向。' },
  { id: 'H07', expect: 'no', language: 'zh', item: '产出本周周报 PDF', handoff: '周报的数据已汇总成 CSV，排版和导出 PDF 还没做。' },
  { id: 'H08', expect: 'no', language: 'en', item: 'Export the dashboard screenshots for the audit', handoff: 'The screenshot script is written but not run yet; it needs the staging login.' },
  { id: 'H09', expect: 'no', language: 'zh', item: '修复支付回调的重复扣款', handoff: '定位到原因：回调没做幂等。方案已写好，代码还没改。' },
  { id: 'H10', expect: 'no', language: 'zh', item: '准备一份竞品价格对比表（xlsx）', handoff: '只找到 2 家的价格，其余 3 家官网需要登录，已停下等你给账号。' },
];
