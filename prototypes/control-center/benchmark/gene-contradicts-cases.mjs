// The labelled cases of the C4 reversal probes (gene-contradicts-probe.mjs: a new word of the user's among the rules in force;
// lesson-contradicts-probe.mjs: the same words among lessons). Shared so both measure the same pairs.
// Label per case: `contradicts`: rule titles the new word reverses (must flag); `arguable`: not scored; every other rule must not flag.
// `kind`: reversal | exception | tighten | repeat | detail | replace | unrelated (what the case is about, for the table).
export const NOVEL = 'd4ed6510-cbfd-4f66-91f8-bed576abd851', RESEARCH = '2ba45503-236b-4b34-897b-7fd9fb953078', DEV = 'dev';
export const ENGLISH = [
  { title: 'Test first', summary: 'Write a failing unit test before changing any code.' },
  { title: 'Reply in English', summary: 'Answer the user in English.' },
  { title: 'Short commit messages', summary: 'Keep commit messages under 72 characters.' },
  { title: 'Ask before adding dependencies', summary: 'Never add a new dependency without asking the user first.' },
  { title: 'Tabs for indentation', summary: 'Indent code with tabs, never spaces.' },
  { title: 'Lint before finishing', summary: 'Run the linter and fix its findings before finishing a task.' },
].map(row => ({ ...row, layer: 'skill', body: row.summary }));
export const SET = [
  // ---- the novel project (live rules R0–R12)
  { project: NOVEL, kind: 'reversal', text: '不用再先查原著风格了，直接按设定写就行，别每次都去搜索。', contradicts: ['先查原著风格'] },
  { project: NOVEL, kind: 'reversal', text: '文风别太口语，不要“俗”，用正式一点的书面文笔。', contradicts: ['情绪起伏与口语化'], arguable: ['生硬表达检查'] },
  { project: NOVEL, kind: 'reversal', text: '每章写完直接交，不用再对照参考作品逐句复核了。', contradicts: ['防后期漂移', '节拍结构逐段仿'], arguable: ['角色标签鲜明化'] },
  { project: NOVEL, kind: 'reversal', text: '角色别再贴固定标签了，写自然一点，不要反复凸显特征。', contradicts: ['角色标签鲜明化'] },
  { project: NOVEL, kind: 'reversal', text: '简介不用去搜什么爆款了，自己写就行。', contradicts: ['简介先调研爆款'] },
  { project: NOVEL, kind: 'reversal', text: '第一章不用特意凸显吸引点，后面也别刻意每隔几章再现，顺其自然。', contradicts: ['吸引点周期再现'] },
  { project: NOVEL, kind: 'reversal', text: '不要再删那些修辞比喻了，「不是疼，是烧」这种句子我喜欢，保留。', contradicts: ['去修辞赘句'] },
  { project: NOVEL, kind: 'reversal', text: '「守夜人」这个名字可以直接用，不用换了。', contradicts: ['「守夜人」字样检查'] },
  { project: NOVEL, kind: 'reversal', text: '不用每写满一百章就做总结了，太费事，取消。', contradicts: ['百章总结检查'] },
  { project: NOVEL, kind: 'reversal', text: '数字化的表达一律改成汉字，包括人名里的数字，不要再区分语境。', contradicts: ['数字改写看语境'], arguable: ['生硬表达检查'] },
  { project: NOVEL, kind: 'reversal', text: '紧张场景别写太夸张的惊恐反应，克制一点，平淡叙述反而更好。', contradicts: ['情绪起伏与口语化'] },
  { project: NOVEL, kind: 'reversal', text: '参考作品不用通读那么多章，抽样看几章就行。', contradicts: ['防后期漂移'] },
  { project: NOVEL, kind: 'reversal', text: '不要照着参考作品逐段模仿节奏，按你自己的想法发挥。', contradicts: ['节拍结构逐段仿'], arguable: ['防后期漂移'] },
  // exceptions, tightenings, repeats, details: nothing is reversed
  { project: NOVEL, kind: 'exception', text: '「守夜人」不能直接用，但引用原著设定集里对它的说明时可以。', exceptionOf: ['「守夜人」字样检查'] },
  { project: NOVEL, kind: 'exception', text: '整体还是口语化，但对话以外的叙述可以稍微书面一点。', arguable: ['情绪起伏与口语化'], exceptionOf: ['情绪起伏与口语化'] },
  { project: NOVEL, kind: 'exception', text: '查证原著风格这件事，只在重写旧章节时做，新章节不用。', exceptionOf: ['先查原著风格'] },
  { project: NOVEL, kind: 'exception', text: '设定集和大纲文件不用做生硬表达检查，只管正文章节。', exceptionOf: ['生硬表达检查'] },
  { project: NOVEL, kind: 'exception', text: '续写旧作的简介沿用原来的，不用再去搜爆款参考。', exceptionOf: ['简介先调研爆款'] },
  { project: NOVEL, kind: 'detail', text: '呼应伏笔除了登记在伏笔登记表里，还要在大纲里标一下。' },
  { project: NOVEL, kind: 'detail', text: '除了「守夜人」，《斩神》里其他组织名也不能直接用。' },
  { project: NOVEL, kind: 'tighten', text: '简介至少参考 5 条同类简介，而不是 3 条。' },
  { project: NOVEL, kind: 'tighten', text: '吸引点每隔 2 章就再现一次。' },
  { project: NOVEL, kind: 'repeat', text: '再强调一遍：写新章之前一定要先通读参考作品。', arguable: ['防后期漂移'] },
  { project: NOVEL, kind: 'repeat', text: '用词要俗一点，口语化，别太刻板。' },
  { project: NOVEL, kind: 'unrelated', text: '每章字数不少于 3500 字。' },
  { project: NOVEL, kind: 'unrelated', text: '对话统一用「」，不要用英文引号。' },
  { project: NOVEL, kind: 'unrelated', text: '战斗场面要写清楚双方的站位和招式先后。' },
  // ---- the research project (live rules R0–R4)
  { project: RESEARCH, kind: 'reversal', text: '日报最后还是列一下交付物清单吧，我想看到每份文件。', contradicts: ['交付物详单检查'] },
  { project: RESEARCH, kind: 'reversal', text: '时间都用 UTC 标，不要再换算成北京时间了。', contradicts: ['北京时间基准检查'] },
  { project: RESEARCH, kind: 'reversal', text: '盈利分析写个大概方向就行，不用每条都带落地假设和指标。', contradicts: ['建议可执行性检查'] },
  { project: RESEARCH, kind: 'reversal', text: '不要再用【新】【更新】标记了，直接写新闻就行。', contradicts: ['简报去重与更新标记'] },
  { project: RESEARCH, kind: 'reversal', text: '安全公告每个等级都要报，别只报最严重的。', contradicts: ['安全报告筛选'] },
  { project: RESEARCH, kind: 'reversal', text: '冷门项目的安全公告也收录进来。', contradicts: ['安全报告筛选'] },
  { project: RESEARCH, kind: 'detail', text: '安全公告除了威胁等级，还要写明受影响的版本范围。' },
  { project: RESEARCH, kind: 'exception', text: '北京时间之外，涉及海外发布会时再附一列 UTC 时间。', arguable: ['北京时间基准检查'], exceptionOf: ['北京时间基准检查'] },
  { project: RESEARCH, kind: 'exception', text: '周末的日报可以不做新旧标记和去重，只列新闻。', exceptionOf: ['简报去重与更新标记'] },
  { project: RESEARCH, kind: 'exception', text: '盈利分析里纯趋势观察类的条目不用带指标。', exceptionOf: ['建议可执行性检查'] },
  { project: RESEARCH, kind: 'unrelated', text: '每条新闻后面都要附上原文链接。' },
  { project: RESEARCH, kind: 'unrelated', text: '日报用中文写，标题不超过 20 个字。' },
  // ---- a small English project
  { project: DEV, kind: 'reversal', text: "Don't write tests first any more; write them after the code works.", contradicts: ['Test first'] },
  { project: DEV, kind: 'reversal', text: 'From now on reply in Chinese.', contradicts: ['Reply in English'] },
  { project: DEV, kind: 'reversal', text: 'Use two spaces for indentation, not tabs.', contradicts: ['Tabs for indentation'] },
  { project: DEV, kind: 'reversal', text: 'You can add dependencies whenever they help; no need to ask me first.', contradicts: ['Ask before adding dependencies'] },
  { project: DEV, kind: 'reversal', text: 'Skip the linter, it is too slow.', contradicts: ['Lint before finishing'] },
  { project: DEV, kind: 'detail', text: 'Commit messages should start with a verb in the imperative mood.' },
  { project: DEV, kind: 'tighten', text: 'Run the linter and the type checker before finishing.' },
  { project: DEV, kind: 'tighten', text: 'Keep commit messages under 50 characters.' },
  { project: DEV, kind: 'repeat', text: 'Write the failing test first, also for bug fixes.' },
  { project: DEV, kind: 'exception', text: 'In Python files use four spaces, not tabs.', exceptionOf: ['Tabs for indentation'] },
  { project: DEV, kind: 'exception', text: 'No need to ask before adding a dev-only dependency.', exceptionOf: ['Ask before adding dependencies'] },
  { project: DEV, kind: 'exception', text: 'For throwaway scripts, writing the tests afterwards is fine.', exceptionOf: ['Test first'] },
  { project: DEV, kind: 'exception', text: 'YAML files should use spaces for indentation.', exceptionOf: ['Tabs for indentation'] },
  { project: DEV, kind: 'exception', text: 'When the user writes in Chinese, reply in Chinese.', exceptionOf: ['Reply in English'] },
  { project: DEV, kind: 'exception', text: 'Skip the linter for generated files.', exceptionOf: ['Lint before finishing'] },
  { project: DEV, kind: 'exception', text: 'Tests may come after the code for quick prototypes.', exceptionOf: ['Test first'] },
  // a replacement of a number or a loosening: both can be followed together, the older number simply stops being the user's word
  { project: DEV, kind: 'replace', text: 'Commit messages can be up to 100 characters now.', arguable: ['Short commit messages'] },
  { project: NOVEL, kind: 'replace', text: '百章总结改成每两百章做一次。', arguable: ['百章总结检查'] },
  { project: DEV, kind: 'unrelated', text: 'Explain your reasoning briefly after each change.' },
];

