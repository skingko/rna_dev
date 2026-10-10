// Labelled cases for the two D1 judgment points (docs/research/jev-rule-use-probe-20261005.md), used by rule-use-probe.mjs.
//   EXPOSE_*: a user message and the rulebook a turn.route request carries (lessons L<n>, working rules M<n>): which rules does
//             the message call for? `yes`: the rule's instruction would clearly come into play; `no`: clearly not; every other rule
//             is `maybe` and is not scored (a labelled set holds only what a careful reader would call plain).
//   USE_*:    one finished turn as its digest (request, first and last steps, written paths, end of the reply) and the rules that
//             were in its context: what did the turn do about each? `expect` lists the readings that are right (any one of them);
//             `null` is not scored. followed / went_against / not_relevant_here / unclear.
// The rules are the live novel project's own lessons and skill rules (read from a copy of live state, text unchanged apart from
// clipping) plus a few of the kind a coding project has, and a few invented standing rules for the cases the live ones lack
// (a prohibition, a rule about the written text itself).

const FAMILIES = {
  novel: {
    lessons: [
      '每日更新小说内容，目标每日约 1 万字。',
      '写作前先用已修复的搜索接口查证原著（斩神）的整体风格，再参照该风格重构或撰写章节，避免文笔细节功力不足的问题。',
      '收到重写反馈时不要只做最小化修复，应整体审视风格与写作手法，主动进行大量重写，而非仅修补局部问题。',
      '写作时用词要“俗”、自然口语化，避免刻板生硬的表达；遇到诡异等冲突场景要写出人物惊恐慌乱的情绪起伏，避免整体平淡，并多读参考章节后再重写。',
      '行文避免数字化的生硬表达（如“四个字”“睡过三觉”）和“是青的”式判断句，多用口语化、带俏皮感的自然句式，保持活人感。',
      '避免无信息量的修辞赘句（如「不是疼，是烧」「疼。活着的那种疼」）和生硬的「像……」式比喻；比喻可改为反问或删掉，直白叙述更好。',
      '续写时不得直接复用原著（斩神）的专有名词如组织名「守夜人」，必须自创或明确区分设定口径。',
      '参考同类小说时至少通读 30 章以上，深入理解其剧情合理性与推进节奏后再用于参考写作。',
      '写新章节前先核对前文细节，避免引用未铺垫的情节（如角色吃糖、习惯动作），确保每个呼应点都有前文伏笔。',
      '撰写小说简介时，先搜索同类爆火小说的简介作为参照，按其爆款模式优化，而非仅凭自定标准。',
      '第一章要凸显核心吸引点以抓住读者，之后每2-3章再现一部分这些吸引元素，保持吸引力持续在线。',
      '续写与改稿时持续按第1章v5.2模板的复核闭环逐章推进，直至改完全部现有13章后再继续新章节。',
    ],
    methods: [
      { title: '先查原著风格', when: '撰写或重写小说章节时', text: '- 在撰写、重构或重写任何章节之前，先用已修复的搜索接口检索原著（斩神）的相关章节或风格资料。\n- 依据检索结果总结原著的叙事语感、句式节奏与人物表现方式，再照此风格撰写。\n- 完成后对照总结出的风格要点自查一遍，确认文笔细节与原著风格一致，再交付。' },
      { title: '情绪起伏与口语化', when: '撰写或重写小说章节（尤其含紧张冲突场景）时', text: '- 撰写或重写章节遇到诡异、冲突等紧张场景时，必须写出人物惊恐慌乱的情绪起伏（生理反应、动作失控、心理波动），避免整体平淡。\n- 用词要“俗”、自然口语化，避免刻板生硬的表达。\n- 动笔前先通读相关参考章节，充分吸收其语感与节奏后再重写，而非直接下笔。\n- 完成后通读一遍，检查紧张场景是否情绪充分、用词是否自然，不足则重写。' },
      { title: '去修辞赘句', when: '撰写、续写或重写小说正文时', text: '- 写完或改写正文后检查：删除「不是疼，是烧」「疼。活着的那种疼」这类不增加信息、只堆情绪的修辞赘句。\n- 生硬的「像……」式比喻优先删除，或改为反问；拿不准就直接删掉，改用直白叙述。\n- 自查方法：逐段找比喻和重复强调句，问「这句删掉信息有没有损失」，没有损失就删。' },
      { title: '数字改写看语境', when: '修改或润色正文中的数字与量化表达时', text: '- 修改数字化表达时先判断语境：仅调整生硬、刻意的量化描述（如“看了两秒”），人物名字中的数字以及自然口语中的数字表达保留不改。\n- 完成正文修改后，逐处复查被改动的数字表达，确认没有误改人名或口语化数字。' },
      { title: '角色标签鲜明化', when: '撰写或重写小说章节时', text: '- 给每个主要角色建立固定标签（外貌、口头禅、性格棱角），写作中反复凸显这些特征，避免角色面目模糊。\n- 对话与人物描写参考灵境的写法，加重情感与荷尔蒙张力，刺激读者情绪。\n- 完稿前自查：每个出场角色是否至少有一次标签特征凸显？' },
      { title: '吸引点周期再现', when: '撰写或续写小说章节时', text: '- 第1章需集中凸显作品的核心吸引点（如金手指、悬念、爽点），用于抓住读者。\n- 之后每隔2-3章，让这些核心吸引元素以新情节或新形式再现一次，避免吸引力断档。\n- 完成每章后检查：本章或最近2章内是否再现了至少一个核心吸引点；若没有，在后续1章内补入。' },
      { title: '节拍结构逐段仿', when: '撰写或重写含娱乐层情节的章节时', text: '写每章前，先精读《灵境行者》对应章节，把其节奏与娱乐层结构拆成具体清单（爽点分布、钩子密度、章末钩子类型等）写入工作笔记。\n- 适用：所有正文写作与重写，涉及娱乐层情节时尤其必须；逐段模仿清单中的节奏设计，不得自行发挥。\n- 交稿前逐项对照清单勾验，未达项当场改写，不在回复中只列对照表声称已对齐。' },
      { title: '简介先调研爆款', when: '撰写或优化作品简介类文案时', text: '- 撰写或修改作品简介（书籍介绍、宣发文案）前，先用搜索接口查找同类型高热度网文的简介，至少参考 3 条。\n- 拆解这些简介的共性：开头钩子、悬念设置、爽点前置、语言节奏，再据此起草。\n- 交付前自查：简介是否具备爆款同类的钩子结构与辨识度，不能只是平铺设定；不满足则重写后再交。' },
    ],
  },
  code: {
    lessons: [
      'Run the test suite before telling the user a change is done.',
      'Use tabs for indentation in this repository, never spaces.',
      'Prefer pnpm over npm for installing packages.',
      'Never commit directly to main; open a branch.',
      'Write commit messages in the imperative mood, under 72 characters.',
      'Keep answers short: no more than three sentences unless the user asks for detail.',
    ],
    methods: [
      { title: 'Check migrations', when: 'adding or changing a database model', text: '- Whenever a model changes, generate a migration and run it against the test database before finishing.\n- Mention any destructive column drop to the user.' },
      { title: 'Run linter', when: 'editing TypeScript source files', text: '- After editing .ts files run `pnpm lint` and fix what it reports before finishing.' },
      { title: 'Release notes', when: 'preparing a release', text: '- Update CHANGELOG.md with one line per user-visible change before tagging.' },
    ],
  },
};

// Indexes are positions in the family's lessons / methods (the ids L<n>, M<n> of the rulebook).
export const EXPOSE_CASES = [
  // ---- novel
  { family: 'novel', id: 'continue-chapter', message: '继续写第 13 章', yes: ['L1', 'L3', 'L4', 'L5', 'L6', 'L8', 'M0', 'M1', 'M2', 'M4', 'M6'], no: ['L2', 'L9', 'M3', 'M7'] },
  { family: 'novel', id: 'write-blurb', message: '帮我给这本书写一个简介', yes: ['L9', 'M7'], no: ['L2', 'L8', 'L11', 'M3', 'M6'] },
  { family: 'novel', id: 'numerals-to-han', message: '把第三章里的阿拉伯数字都改成汉字', yes: ['L4', 'M3'], no: ['L9', 'L10', 'M5', 'M7', 'L2'] },
  { family: 'novel', id: 'word-count', message: '第 5 章现在多少字？', yes: [], no: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] },
  { family: 'novel', id: 'title-clash', message: '帮我查一下《神烬》这个书名有没有重名', yes: [], no: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8', 'L9', 'L10', 'L11', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] },
  { family: 'novel', id: 'rewrite-flat', message: '第 7 章写得太平淡了，重写一遍', yes: ['L2', 'L3', 'L1', 'M0', 'M1'], no: ['L9', 'M7', 'M3'] },
  { family: 'novel', id: 'progress-summary', message: '总结一下目前的写作进度', yes: [], no: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L9', 'M0', 'M1', 'M2', 'M3', 'M4', 'M6', 'M7'] },
  { family: 'novel', id: 'batch-chapters', message: '一口气把第 14 到 18 章都写完', yes: ['L1', 'L3', 'L4', 'L5', 'L6', 'L8', 'M0', 'M1', 'M2', 'M4', 'M6'], no: ['L9', 'M7', 'L2', 'M3'] },
  { family: 'novel', id: 'weekly-plan', message: '把这周的更新计划列一下', yes: ['L0'], no: ['L2', 'L3', 'L4', 'L5', 'L6', 'L9', 'M0', 'M1', 'M2', 'M3', 'M4', 'M6', 'M7'] },
  { family: 'novel', id: 'deploy', message: '部署好了吗？', yes: [], no: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] },
  { family: 'novel', id: 'consistency-check', message: '检查一下第 10 章有没有前后矛盾的地方', yes: [], no: ['L9', 'M7', 'L2', 'M3', 'L5', 'M2', 'M1', 'L3'] },
  { family: 'novel', id: 'blurb-hook', message: '把简介里的钩子改得更吸引人一点', yes: ['L9', 'M7'], no: ['L2', 'L6', 'L8', 'L11', 'M3', 'M6', 'M2'] },
  { family: 'novel', id: 'reference-rhythm', message: '参考一下《灵境行者》前 50 章，告诉我它的节奏有什么特点', yes: ['L7'], no: ['L9', 'M7', 'L2', 'L5', 'L6', 'M3', 'M2', 'L4'] },
  { family: 'novel', id: 'guard-name-why', message: '你为什么在第 9 章里用了「守夜人」这个组织名？', yes: ['L6'], no: ['L9', 'M7', 'M3', 'L10', 'M5', 'L0'] },
  { family: 'novel', id: 'unsupported-callback', message: '第 2 章里主角吃糖那一段前面没有铺垫，帮我改一下', yes: ['L8'], no: ['L9', 'M7', 'L0', 'L10'] },
  { family: 'novel', id: 'approval', message: '好的，就这样', yes: [], no: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] },
  { family: 'novel', id: 'blurry-characters', message: '这几章里的人物都有点面目模糊，加强一下', yes: ['M4'], no: ['L9', 'M7', 'L6', 'M3'] },
  // ---- code
  { family: 'code', id: 'add-helper', message: 'Add a helper function that slugifies titles in src/utils.ts', yes: ['L0', 'L1', 'M1'], no: ['L2', 'L4', 'M0', 'M2'] },
  { family: 'code', id: 'install-lodash', message: 'Install lodash', yes: ['L2'], no: ['L1', 'L4', 'M0', 'M1', 'M2'] },
  { family: 'code', id: 'commit', message: 'Commit these changes', yes: ['L3', 'L4'], no: ['L1', 'L2', 'M0', 'M1', 'M2'] },
  { family: 'code', id: 'add-column', message: 'Add a `published` column to the Post model', yes: ['M0'], no: ['L2', 'L4', 'M2'] },
  { family: 'code', id: 'cut-release', message: 'Cut the 2.4 release', yes: ['M2'], no: ['M0', 'M1', 'L1'] },
  { family: 'code', id: 'rename-variable', message: 'Rename the variable on line 40 of utils.ts to something clearer', yes: ['M1'], no: ['M0', 'M2', 'L2', 'L4'] },
  { family: 'code', id: 'thanks', message: 'Thanks, looks good', yes: [], no: ['L0', 'L1', 'L2', 'L3', 'L4', 'M0', 'M1', 'M2'] },
  { family: 'code', id: 'explain-middleware', message: 'What does the retry middleware do?', yes: [], no: ['L1', 'L2', 'L3', 'L4', 'M0', 'M1', 'M2'] },
];

// Rules for the use judgment: the live ones above plus invented standing rules (a prohibition, rules about the written text).
const USE_LESSONS = {
  num_han: { kind: 'preference', text: '数字一律用汉字（章节正文里不要出现阿拉伯数字）。' },
  quotes: { kind: 'preference', text: '对话一律用中文直角引号「」，不要用双引号。' },
  no_ch1: { kind: 'constraint', text: '不要改动第一章。' },
  no_delete: { kind: 'constraint', text: '未经允许不要删除任何文件。' },
  rhetoric: { kind: 'preference', text: FAMILIES.novel.lessons[5] },
  search_style: { kind: 'constraint', text: FAMILIES.novel.lessons[1] },
  no_guard_name: { kind: 'constraint', text: FAMILIES.novel.lessons[6] },
  check_prior: { kind: 'pitfall', text: FAMILIES.novel.lessons[8] },
  blurb: { kind: 'preference', text: FAMILIES.novel.lessons[9] },
  rewrite_whole: { kind: 'pitfall', text: FAMILIES.novel.lessons[2] },
};
const method = index => FAMILIES.novel.methods[index];
const USE_METHODS = { style: method(0), beats: method(6), blurb: method(7), num: method(3) };

const research = ['web_search 斩神 文风 叙事语感 -> ok', 'web_fetch 斩神 第 1 章 -> ok'];
export const USE_CASES = [
  { id: 'chapter-researched', request: '写第 13 章', firstSteps: ['project_read 设定/世界观.md -> ok', 'project_read 正文/第012章.md -> ok', ...research, 'project_write 笔记/第013章-节拍.md -> ok', 'project_write 正文/第013章.md -> ok'], wrote: '笔记/第013章-节拍.md, 正文/第013章.md', reply: '第十三章《夜雨》已写完，约三千字，保存在 正文/第013章.md，节拍表在 笔记/第013章-节拍.md。',
    items: { search_style: ['followed'], 'M:style': ['followed'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'], num_han: ['unclear'], quotes: ['unclear'], rhetoric: ['unclear'], 'M:num': ['not_relevant_here'] } },
  { id: 'chapter-unresearched', request: '写第 13 章', firstSteps: ['project_read 正文/第012章.md -> ok', 'project_write 正文/第013章.md -> ok'], wrote: '正文/第013章.md', reply: '第十三章《夜雨》已写完，约三千字，保存在 正文/第013章.md。',
    items: { search_style: ['went_against'], 'M:style': ['went_against'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'], 'M:num': ['not_relevant_here'] } },
  { id: 'text-complies', request: '写第 12 章的开头，300 字左右', firstSteps: [], wrote: '', reply: '第十二章 夜雨\n\n雨从傍晚下起，一直没停。顾昭撑着伞站在城门下，数了数换岗的兵卒，一共三个。\n「你来了。」守门的老兵头也没抬。\n「嗯。」顾昭应了一声，把路引递过去。两个人谁也没再说话，只有雨砸在伞面上，哒哒地响。',
    items: { num_han: ['followed'], quotes: ['followed'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'text-violates', request: '写第 11 章的开头，300 字左右', firstSteps: [], wrote: '', reply: '第11章 出城\n\n他在3点钟出门，走了5里路，才看见那座破庙。庙门口站着2个人，其中一个说："你来晚了。"他答："路上耽搁了。"',
    items: { num_han: ['went_against'], quotes: ['went_against'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'unrelated-question', request: '主角叫什么名字？', firstSteps: [], wrote: '', reply: '主角叫顾昭。',
    items: { num_han: ['not_relevant_here'], quotes: ['not_relevant_here'], rhetoric: ['not_relevant_here'], search_style: ['not_relevant_here'], blurb: ['not_relevant_here'], check_prior: ['not_relevant_here'], 'M:style': ['not_relevant_here'], 'M:beats': ['not_relevant_here'], 'M:blurb': ['not_relevant_here'], 'M:num': ['not_relevant_here'] } },
  { id: 'blurb-researched', request: '帮我给这本书写个简介', firstSteps: ['web_search 玄幻 爆款 简介 -> ok', 'web_search 都市异能 热门 简介 -> ok', 'web_fetch 同类 简介 -> ok', 'project_write 简介.md -> ok'], wrote: '简介.md', reply: '简介已写好，保存在 简介.md：先抛悬念，再点金手指，最后留钩子。',
    items: { blurb: ['followed'], 'M:blurb': ['followed'], search_style: ['not_relevant_here', 'unclear'], 'M:style': ['not_relevant_here', 'unclear'], 'M:beats': ['not_relevant_here'], num_han: ['not_relevant_here', 'unclear'] } },
  { id: 'blurb-unresearched', request: '帮我给这本书写个简介', firstSteps: ['project_read 设定/世界观.md -> ok', 'project_write 简介.md -> ok'], wrote: '简介.md', reply: '简介已写好，保存在 简介.md。',
    items: { blurb: ['went_against'], 'M:blurb': ['went_against'], 'M:beats': ['not_relevant_here'] } },
  { id: 'numerals-edit', request: '把第三章里的阿拉伯数字都改成汉字', firstSteps: ['project_grep 第三章 阿拉伯数字 -> ok', 'project_edit 正文/第003章.md -> ok', 'project_edit 正文/第003章.md -> ok', 'project_edit 正文/第003章.md -> ok'], wrote: '正文/第003章.md', reply: '已把第三章里的 12 处阿拉伯数字改成汉字；人名「刘三」里的数字没有改。',
    items: { num_han: ['followed'], 'M:num': ['followed'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'tidy-delete', request: '整理一下大纲', firstSteps: ['project_read 大纲.md -> ok', 'project_edit 大纲.md -> ok', 'command rm 大纲-旧备份.md -> ok'], wrote: '大纲.md', reply: '大纲已整理，合并了重复的两节，并删掉了旧备份文件。',
    items: { no_delete: ['went_against'], blurb: ['not_relevant_here'], num_han: ['not_relevant_here'], 'M:style': ['not_relevant_here'] } },
  { id: 'dialogue-edit-keeps-ch1', request: '把第三章的对话改得更口语化', firstSteps: ['project_read 正文/第003章.md -> ok', 'project_edit 正文/第003章.md -> ok', 'project_edit 正文/第003章.md -> ok'], wrote: '正文/第003章.md', reply: '第三章的对话已改得更口语化，共改了 12 处。其它章节没有动。',
    items: { no_ch1: ['followed', 'not_relevant_here', 'unclear'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'edits-ch1', request: '统一改一下各章的标题格式', firstSteps: ['project_edit 正文/第001章.md -> ok', 'project_edit 正文/第002章.md -> ok', 'project_edit 正文/第003章.md -> ok'], wrote: '正文/第001章.md, 正文/第002章.md, 正文/第003章.md', reply: '各章标题已统一成「第 N 章 标题」的格式。',
    items: { no_ch1: ['went_against'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'chapter-beats-first', request: '写第 14 章', firstSteps: ['web_search 灵境行者 第14章 节奏 -> ok', 'project_read 参考/灵境行者-第14章.md -> ok', 'project_write 笔记/第014章-节拍清单.md -> ok', 'project_write 正文/第014章.md -> ok'], wrote: '笔记/第014章-节拍清单.md, 正文/第014章.md', reply: '第十四章已写完，节拍清单在 笔记/第014章-节拍清单.md，正文在 正文/第014章.md。',
    items: { 'M:beats': ['followed'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'], 'M:num': ['not_relevant_here'] } },
  { id: 'chapter-no-beats', request: '写第 14 章', firstSteps: ['project_read 正文/第013章.md -> ok', 'project_write 正文/第014章.md -> ok'], wrote: '正文/第014章.md', reply: '第十四章已写完，保存在 正文/第014章.md。',
    items: { 'M:beats': ['went_against'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'], 'M:num': ['not_relevant_here'] } },
  // The prose is in the file the turn wrote and the reply only says it is done: judged from the start of what was written (turn-digest.mjs writtenExcerpts).
  { id: 'file-han-complies', request: '写第 12 章', firstSteps: ['project_read 正文/第011章.md -> ok', 'project_write 正文/第012章.md -> ok'], wrote: '正文/第012章.md', reply: '第十二章已写完，保存在 正文/第012章.md。',
    files: [{ path: '正文/第012章.md', text: '第十二章 夜雨\n\n雨从傍晚下起，一直没停。顾昭撑着伞站在城门下，数了数换岗的兵卒，一共三个。\n「你来了。」守门的老兵头也没抬。\n「嗯。」顾昭应了一声，把路引递过去。两个人谁也没再说话，只有雨砸在伞面上，哒哒地响。' }],
    items: { num_han: ['followed'], quotes: ['followed'], blurb: ['not_relevant_here'] } },
  { id: 'file-han-violates', request: '写第 12 章', firstSteps: ['project_read 正文/第011章.md -> ok', 'project_write 正文/第012章.md -> ok'], wrote: '正文/第012章.md', reply: '第十二章已写完，保存在 正文/第012章.md。',
    files: [{ path: '正文/第012章.md', text: '第12章 夜雨\n\n雨从傍晚下起，一直没停。顾昭撑着伞站在城门下，数了数换岗的兵卒，一共3个。\n"你来了。"守门的老兵头也没抬。\n"嗯。"顾昭应了一声，把路引递过去。2个人谁也没再说话，只有雨砸在伞面上，哒哒地响。' }],
    items: { num_han: ['went_against'], quotes: ['went_against'], blurb: ['not_relevant_here'] } },
  { id: 'file-fluff', request: '写第 12 章', firstSteps: ['project_read 正文/第011章.md -> ok', 'project_write 正文/第012章.md -> ok'], wrote: '正文/第012章.md', reply: '第十二章已写完，保存在 正文/第012章.md。',
    files: [{ path: '正文/第012章.md', text: '第十二章 夜雨\n\n雨从傍晚下起。不是冷，是刺骨。像一把钝刀，慢慢地割。顾昭站在城门下。疼。活着的那种疼。他想起了很多事，像潮水一样涌来。' }],
    items: { rhetoric: ['went_against'], blurb: ['not_relevant_here'] } },
  { id: 'file-clean', request: '写第 12 章', firstSteps: ['project_read 正文/第011章.md -> ok', 'project_write 正文/第012章.md -> ok'], wrote: '正文/第012章.md', reply: '第十二章已写完，保存在 正文/第012章.md。',
    files: [{ path: '正文/第012章.md', text: '第十二章 夜雨\n\n雨从傍晚下起。顾昭站在城门下，手指冻得发僵，嘴里骂了一句，把领口拉紧。守门的老兵瞟了他一眼，没吭声。' }],
    items: { rhetoric: ['followed', 'unclear'], blurb: ['not_relevant_here'] } },
  { id: 'rewrite-whole', request: '第 7 章太平淡了，重写', firstSteps: ['project_read 正文/第007章.md -> ok', 'project_write 正文/第007章.md -> ok'], wrote: '正文/第007章.md', reply: '第七章已整章重写：换了开场，重排了冲突的顺序，保存在 正文/第007章.md。',
    items: { rewrite_whole: ['followed'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
  { id: 'rewrite-patched', request: '第 7 章太平淡了，重写', firstSteps: ['project_read 正文/第007章.md -> ok', 'project_edit 正文/第007章.md -> ok', 'project_edit 正文/第007章.md -> ok'], wrote: '正文/第007章.md', reply: '第七章已改：修了开头两处和一个过渡段落，保存在 正文/第007章.md。',
    items: { rewrite_whole: ['went_against', 'unclear'], blurb: ['not_relevant_here'], 'M:blurb': ['not_relevant_here'] } },
];

// A rule about the form of the text ("数字一律用汉字"), judged from short replies (D1 review): the numeral text itself is the only
// evidence. `expect`: the reading that is right. Measured in the research doc §2.6: the judge reads any reply with numbers in it as
// going against the rule, whether they are written in Han characters or in digits.
export const FORM_LESSONS = { bare: '数字一律用汉字', body: USE_LESSONS.num_han.text };
export const FORM_CASES = [
  { id: 'han-opening', request: '写第 11 章的开头', reply: '第十一章 出城\n\n他在三点钟出门，走了五里路，才看见那座破庙。庙门口站着两个人。', expect: 'followed' },
  { id: 'han-one-line', request: '写第 11 章的开头', reply: '他在三点钟出门。', expect: 'followed' },
  { id: 'han-bare-request', request: '写一句话', reply: '庙门口站着两个人。', expect: 'followed' },
  { id: 'han-no-number', request: '写第 11 章的开头', reply: '第十一章 出城\n\n他早上出门，走了很远的路，才看见那座破庙。庙门口站着一个人。', expect: 'followed' },
  { id: 'han-long', request: '写第 12 章的开头，300 字左右', reply: USE_CASES_TEXT_COMPLIES(), expect: 'followed' },
  { id: 'digits-one-line', request: '写一句话', reply: '庙门口站着2个人。', expect: 'went_against' },
  { id: 'digits-opening', request: '写第 11 章的开头', reply: '第11章 出城\n\n他在3点钟出门，走了5里路，才看见那座破庙。庙门口站着2个人，其中一个说："你来晚了。"', expect: 'went_against' },
  { id: 'unrelated', request: '主角叫什么名字？', reply: '主角叫顾昭。', expect: 'not_relevant_here' },
];
function USE_CASES_TEXT_COMPLIES() { return USE_CASES.find(row => row.id === 'text-complies').reply; }

export const family = name => FAMILIES[name];
export const useLessons = USE_LESSONS;
export const useMethods = USE_METHODS;
