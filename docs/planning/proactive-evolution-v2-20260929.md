# 主动沟通与自进化 v2 方案（2026-09-29，已确认，开发中）

依据：两份只读研究（生产数据 + Headlong / mu kyrn-judge / RRSI / ASPIRE / Pi / DeepSeek Harness 源码），证据行号见研究报告摘要（本文 §6）。

## 1. 诊断：为什么“不够智能”

两套系统的共同根因：**原始事件与行动之间没有一层持久的“理解”**。每次唤醒都从一大段快照重新推断，学到的东西无处沉淀；进化则试图把一切都变成昂贵的整包实验。

### 主动沟通（生产数据）
- **几乎停摆**：两个项目在被判为 `recurring / event_only` 后，每天只剩 ≤3 次判断、0 条非定时主动分享；唯一输出是定时交付。
- **P3 从未真正运行**：生产中收件箱为空、0 条交接行——写作规范、分级触达、反馈闭环都没产出过一次投递。
- **定时交付绕过全部质量关**：直接拼接“标题 + 工作结果摘要”，不经写作规范、去重与送达判断——而你两次抱怨“啰嗦”“不要写交付物详单”正是针对它。
- **消息质量**：历史 37 条主动消息中位 600+ 字；22/28 引用文件名、11/28 含哈希；13 条以“补一条…”开头；曾连续 12 条无人回复（8 条在凌晨）；同一阻塞 18 分钟内换说法发了 3 次。
- **没有记忆和议程**：没有目标/待办/等待用户的事项，模型只能把“仍待裁决①…⑨”写进定时任务说明里当笔记本；初始化时的 7 个开放问题至今未更新。
- **承诺跟进慢**：用户给出决定后约 7 小时才确认。
- **反馈不改变行为**：你说“你应该自己决策，不需要问我”后仍在提问；反应标签只写入 JEV 记账。
- **贵且不稳**：每次判断约 54k token、后台判断缓存命中为 0、约 13% 判断输出无效。

### 自进化（生产数据）
- **从未让 Agent 变强**：3 个项目共 37 个非基线版本、约 1140 万 token，**0 个进化候选通过**；项目提示词与技能大小与第一天相同。
- **信号漏检**：检测纠正的正则在两个项目里命中 0 次，而你给过约 20 条明确批评（“场景仍然单一”“都是一个平面”“报告啰嗦”）。
- **评测集不是你的真实工作**：游戏项目的 5 个评测用例是“请设计核心玩法”这类问答，从不构建、运行或查看你真正在做的 three.js 游戏；针对你视觉抱怨的候选只能在无关问答上评分（0.78→0.74 被判退步）。
- **学习全部失效**：111 次学习复盘 100% 被作废（切换模型、授权、装技能都会改变作用域哈希），09-26 之后再未运行。
- **单位太大**：每次都整包重写基因组（单次 10–70 万 token），9/16 失败来自作者输出格式；没有“记一条经验”这样便宜的学习方式。
- **你看不见也掌控不了**：你说“优化任务提示迭代版本”没有触发任何学习。

## 2. 核心设计：项目心智层（Project Mind）

新增一层前台、后台、进化共享的持久理解，全部可在界面查看、编辑、删除：

| 类别 | 内容 | 来源 | 用途 |
|---|---|---|---|
| **经验 lessons** | 偏好 / 约束 / 易错点 / 成功习惯，带出处、作用范围、使用次数、过期与被推翻状态 | 纠正、明确偏好、失败复盘、被认可的交付 | 注入前台与后台上下文尾部（不破坏缓存前缀） |
| **议程 agenda** | 意图 / 待办 / 等待用户 / 未闭环 / 想法，带 `until` | 后台 `goals` 动作、前台对话 | 后台每次唤醒的主线；取代“把笔记写进定时任务” |
| **承诺 commitments** | 你提出但尚未完成的请求、Agent 说过“我会…”的事，超 4 小时标记逾期 | JEV 在每条用户消息上判断 | 唤醒时最高优先；分享/工作必须声明 `resolves` |
| **已告知 findings** | 已对你说过的结论（主题键 + 证据哈希） | 每次投递 | 去重：只有新主题或证据实质变化才可再说 |
| **用户画像 notes** | 只记事实与明确偏好，不把一次事件泛化成规则 | 对话后低成本更新 | 措辞、时机、打扰程度 |
| **技能 skills** | 从成功轨迹提炼的做法（何时用、步骤、坑、验证命令），`experimental → active` | 被认可的任务 | 按描述按需加载，用后计次、无效则裁剪 |

JEV 负责所有“是/否/选哪个”的快速判断（约 0.4 秒、价格约为主模型的千分之一）；主模型只做真正的工作与写作。

## 3. 主动沟通 v2（参考 Headlong / mu）

1. **每条用户消息的信号捕获（JEV，约 0.4s，并入现有 `turn.route` 扇出）**：`是纠正吗 / 是长期偏好吗 / 是认可吗 / 有待完成的请求吗 / 要停止或改向后台吗` → 写入经验与承诺。修复“正则 0 命中”和“说了不问仍然问”。
2. **后台心智 = 路由 + 执行**：
   - 路由：JEV 原子问题 + 约 80 行 Headlong 式菜单提示，每次唤醒只做一件事：`act / share / think / learn / recall / goals / idle`；稳定前缀在前、动态尾部（承诺、议程、经验指针、24h 已发、交接行）在后，让后台判断也能命中缓存。
   - 执行：只有决定行动时才调用完整合约与工具。
   - 目标：单次唤醒成本降 5–10 倍，从而负担得起更频繁的“想一想”。
3. **承诺优先**：待完成请求排在最前，逾期必须推进或写明原因。
4. **唤醒前回忆**：从 OpenViking 与经验库取 3 条相关记忆指针（轮换，避免重复）。
5. **叙述者统一出口**（2026-09-29 按用户要求改为 Pi/Harness 方式）：面向你的文字就是 Agent 自己写的最终回复（后台分享的内容、定时任务工作者的最终回复），宿主不改写、不截断、不按文件名/表格/开头词做任何规则处理；交付的文件由 Agent 用 `project_present` 明确声明（通常 1–2 个，带一句说明），界面显示为交付卡片。宿主只做确定性的安全处理（密钥脱敏、规范化后完全相同的重复不再发）。质量与价值全部由内置的 JEV 判断：`message.check`（写作规范，按项目类型判断哪些路径/标识对你有用；有问题时 Agent 自己改一次）与 `message.value`（新信息还是已说过（含换说法）、延续哪个话题、此刻是否相关、是否紧急、是否需要你决定）；判断为“已说过”直接丢弃。判断后端依次为 TypeSafe JEV → 已配置的快速模型（同一模板，门槛 +0.1）→ 都没有时只按节奏送达，不用任何正则。不区分新闻/报告类：按项目任务类型（研究、编程、创作、设计、分析、写作、周期、数据）和定时任务/用户声明的交付物判断。
6. **自适应节奏与话题连续性**：不设固定条数，按项目情况动态调整；每条消息挂在话题上并承接上文（详见 §3.1）。
7. **有节制的好奇心**：每日预算内的 `think/explore`（提出一个具体想法写入议程，必须是新角度）；`event_only` 作为底线而非彻底停止——议程还有未闭环项时继续思考；每 K 次安静唤醒提示一次“有新东西就分享”，避免越学越沉默。
8. **从反应中学习**：忽略率与关闭率按项目调整默认送达档位与冷却（界面可见、可改）。

## 4. 自进化 v2：三层学习（参考 RRSI / ASPIRE / Headlong / Pi）

| 层 | 频率与成本 | 做什么 |
|---|---|---|
| **① 在线经验** | 每次纠正，数秒、约 2–5k token | 写入经验，下一轮即生效；与已有经验去重，被推翻自动失效 |
| **② 技能与复盘** | 每个被认可的任务 / 每次失败，约 1–2 万 token | 成功轨迹提炼为实验性技能（Voyager 式）；失败或同一话题 ≥2 次纠正时做短复盘（原因、下次怎么做、该加的检查）写成经验；同类失败 ≥3 次才升级到第③层；技能用“有/无”回放对照测提升（Pi docs-lift 式），K 次有效使用后转正 |
| **③ 离线基因组进化** | 每周或证据累计后 | RRSI 分析员读取真实回放轨迹（失败模式 / 能力缺口 / 成功习惯）；提案改为按组件的小补丁（附触发条件、预期影响、回溯核对、风险），并记录预测命中率；评测用**真实回放胶囊** |

**真实回放胶囊**：每轮开始用 git 快照工作区，保存输入、之前的对话尾部和你随后的反应；检查项由你的反应派生（JEV/主模型提炼“落点可见”“物体不再浮空”等），加上确定性检查（构建通过、预览可渲染、视觉模型看截图）。自动进入对应任务类型的评测集，每类 20–40 例，保留 25% 做泛化检验；k=2 重复并校准噪声带，用“下限 + 成本”规则选择，取代固定 0.08 提升门槛。

**修复脆弱性**：切换模型、授权、装技能、升级只给证据打标注，不再作废；只有删除会话这类隐私撤回才作废。界面显示“学习暂停：原因”。

**你可以直接引导**：“以后……”“优化 X”经 JEV 路由到经验或实验；每个任务类型的模糊目标先转成你确认过的可检验标准（ASPIRE 的目标操作化）；每条消息可 👍/👎。

## 5. 如何证明“变聪明了”

- **主动沟通**：有用分享率（回复 + 采纳）、忽略/关闭率、最长未回复串、夜间或离开时发送占比、承诺解决时长 p50/p90 与逾期数、“错误沉默”（你问进展时其实有未分享发现）、重复率、议程陈旧度、每次唤醒 token/延迟/无效率/缓存命中。
- **自进化**：每轮纠正次数、重复纠正率（同一抱怨再现）、首次交付接受率、重试/中止率、工具失败率、每个被接受交付的 token 与时间、经验命中率（经验在上下文中且之后没被纠正）、留出回放集通过率（每周对当前版本重跑）。
- **回放评测集**：用生产数据建基准——495 次判断及其快照、37 条主动消息与之后的你的回复、“权限困惑”“凌晨 12 条”“7 小时未确认”“啰嗦/交付物详单”等真实片段；新旧对照打分，JEV 关 / 影子 / 开启三档对比。

## 6. 分期

| 阶段 | 内容 | 预计 |
|---|---|---|
| **Q1 立竿见影** | 心智层存储与界面（Rna 学到的）；每条消息 JEV 信号捕获 → 经验与承诺；定时交付经叙述者重写；在场感知与未回复上限；学习作用域修复；👍/👎；指标与回放评测集基线 | 约 1–1.5 周 |
| **Q2 心智循环** | 后台路由 + 一次一件事菜单 + 唤醒前回忆 + 好奇心预算 + 已告知账本；技能提炼 + 失败复盘 + 技能有/无对照 | 约 1.5 周 |
| **Q3 真实进化** | 真实回放胶囊（git 快照 + 反应派生检查 + 构建/视觉检查）；RRSI 分析员与补丁式提案 + 预测记分；噪声校准与下限+成本选择 | 约 2 周 |

## 7. 已确认的决策（2026-09-29）

1. 经验自动生效，界面可见、可撤销，被推翻自动失效。
2. **主动消息不设固定条数上限**：参考 Headlong，按项目具体情况动态调整频率；消息必须有连续性和相关性，避免频繁发送无用或无意义的消息（见 §3.1）。
3. 回放胶囊在本地保存工作区 git 快照（只存差异，单项目上限约 2GB，自动淘汰旧快照，不上传）。
4. 技能在 K 次有效使用后自动转正并通知用户；系统提示词等基因组改动仍需用户手动试用/采用。
5. 每条助手消息提供 👍/👎。

## 3.1 自适应节奏与话题连续性（取代“在场感知与未回复上限”一节中的固定限制）

**节奏（pacing）是信号驱动的，不是计数器**，参考 Headlong 的做法：真实工作重置节奏、仅思考的唤醒退避、失败立即降档、待完成请求优先于一切。

- 每个项目维护 `pacing` 状态，由以下信号实时计算（均在代码里计算，数值进入 JEV 前先分桶）：
  - 用户投入度：近期回复/采纳率、从消息到回复的时间、最近一次在场时间与活跃时段；
  - 项目阶段：近期用户活动、未闭环议程与承诺数量、新证据出现速度、是否处于等待外部结果（如等待试玩反馈）；
  - 近期消息价值：被回复/采纳/忽略/关闭的比例；
  - 未回复链：连续未被回应的主动消息越多，下一条需要的“价值门槛”越高；用户一旦回应即恢复。
- 每条候选消息在发出前由 JEV 原子判断（内置，无开关）：`带来新信息（相对已告知账本与话题里已说的内容，含换说法）`、`延续一个进行中的话题或回应一个承诺`（并选出延续的是哪个话题）、`此刻对用户相关（结合项目类型）`、`时间敏感`、`需要用户决定`、`已经说过`。“已经说过”直接丢弃；其余概率与 pacing 结合，得出：**立即对话内发送 / 留在话题里等你回来 / 收件箱 / 丢弃**。没有“每天最多 N 条”，也没有固定冷却；只有“价值是否超过当前门槛”。没有判断后端时价值视为中性，只由节奏（在场、夜间、未回复链、刚发未读、互动率）决定；宿主不再用任何文字规则估计价值。
- 夜间或用户离开时，默认把非时间敏感的内容留在话题里，等用户回来时合成一条“你不在时的进展”：按话题分组、原文照发（`initiative.topics` 结构化给界面），超过 5 个话题的放进收件箱。
- 防止越学越沉默：若长时间只有思考而没有分享、但已告知账本之外积累了有价值的发现，门槛会逐步降低（Headlong 的 share nudge）。

**话题（threads）保证连续性**：
- 每条主动消息必须挂在一个话题上：议程项、承诺、已告知账本中的主题，或明确声明“新话题”并说明为何值得开启。
- 同一话题的后续消息以“接上次……”的方式承接，只说新变化；话题解决时发一条简短的收尾（或直接关闭，不再打扰）。
- 界面按话题聚合主动消息，可展开查看历程；用户对话题的反应（回复、👍/👎、关闭）作用于整个话题的后续节奏。

## 8. 数据契约（Q1 并行开发依据）

`project.mind`（持久化在项目状态中，前台、后台、进化共享；所有条目带 `id`、`createdAt`、`updatedAt`、`source{kind, sessionId?, itemId?, turnId?}`）：

| 字段 | 结构 |
|---|---|
| `lessons[]` | `{kind: preference\|constraint\|pitfall\|success_habit, text, scope: project\|user, taskTypes?, evidence[], status: active\|superseded\|retired, supersededBy?, until?, uses: {recalled, applied, contradicted}}` |
| `agenda[]` | `{kind: intention\|todo\|awaiting_user\|open_loop\|idea, text, until?, status: open\|done\|dropped, threadId?, evidence[]}` |
| `commitments[]` | `{request, trigger: user_request\|agent_promise\|failed_turn, overdueAt, status: pending\|resolved\|dismissed, resolvedBy?, reason?}` |
| `findings[]` | `{topicKey, summary, firstSharedAt, lastSharedAt, lastEvidenceHash, threadId}` |
| `threads[]` | `{id, title, status: open\|resolved\|muted, messageItemIds[], lastMessageAt, reactions{replied, acted, dismissed, ignored, up, down}}` |
| `notes` | `{facts[], preferences[], updatedAt}`（只记事实与明确偏好） |
| `pacing` | `{threshold, unrepliedChain, engagement, lastPresenceAt, activeHours[], updatedAt}`（派生，可重算） |
| `health` | `{learning: running\|paused, reason?}` |

接口：
- `GET /api/v2/projects/:id/mind`（汇总）；`PATCH /api/v2/projects/:id/mind/{lessons|agenda|commitments|threads|notes}/:entryId`（编辑/撤销/关闭）；`DELETE` 同路径。
- `POST /api/v2/sessions/:id/items/:itemId/feedback` `{vote: up|down|null, comment?}`。
- `GET /api/v2/projects/:id/metrics?window=7d|30d`（§5 指标）。
- SSE：`index` 中 `ProjectSummary.counts` 增加 `lessons`、`openAgenda`、`pendingCommitments`、`overdueCommitments`；项目心智变化以 `project.mind` 事件推送摘要。

### 8.1 契约变更记录

- **2026-09-29 · K4（回放基准与指标）**：
  - `GET /api/v2/projects/:id/metrics?window=7d|30d|all` 由 `benchmark/metrics-route.mjs` 提供，挂在 `api-v2` 之后——若 K2 在 `api-v2.mjs` 自行实现该路由，K4 路由自动失效。响应为一个对象：`{ metrics: { <key>: { value, previous, series: [{ date, value, sample }], sample } }, proactive, learning, harness, owners, providers }`——`metrics` 供界面（K3）使用：`previous` 为上一个同长窗口，`series` 为逐日点，`sample` 为分母 n；已提供 `usefulShareRate`、`ignoreRate`、`dismissRate`、`longestUnrepliedChain`、`commitmentResolutionP50Ms/P90Ms`、`correctionsPerTurn`、`repeatCorrectionRate`、`firstAttemptAcceptance`、`lessonHitRate` 等（完整列表见 `METRIC_KEYS`）；其余字段为明细块。
  - 归属：K4 负责 `learning`（纠正/重复纠正/首次接受/重试/中止/工具失败/每个被接受交付的成本/经验命中率/进化候选）与 `harness`（数据覆盖与口径说明）；`proactive` 逻辑归 K2，K4 仅提供基线。K2 在 `prototypes/control-center/proactive-metrics.mjs` 导出 `computeProactiveMetrics(state, projectId, { window, now })`（可异步）后，路由以防御性动态导入合并：K2 的块替换 `proactive`，其 `metrics` 键值（或同名数值字段）覆盖 `metrics` 中对应的主动沟通键，K4 基线保留在 `proactiveBaseline`，`owners.proactive = 'k2'`。K2 不要另建同路径路由，以保证只有一个端点。
  - 程序接口：`computeProjectMetrics(state, projectId, window, { now, side, labels, proactiveProvider })`（`benchmark/metrics.mjs`）。存在 `project.mind.commitments` / `lessons` 时自动改用契约数据（承诺 p50/p90/逾期、经验命中率 = applied / (applied + contradicted)）。
  - 场景适配器：K1/K2 合入后在 `benchmark/adapters/` 提供 `mind.mjs`（`read(store, projectId)`）、`capture.mjs`（`captureUserMessage({ store, projectId, sessionId, itemId, jev })`）、`narrator.mjs`（`rewriteScheduled({ store, projectId, text, now })`）、`pacing.mjs`（`available()`），对应场景即从“跳过”转为运行。

- **2026-09-29 · K2（叙述者、自适应节奏、话题、已告知账本）**：
  - `threads[]`：`{id, title, kind: topic|agenda|commitment|schedule, ref?: {agendaId|commitmentId|scheduleId}, reason?, status: open|resolved|muted, messageItemIds[], messageSessions: {itemId: sessionId}, entryIds[], lastMessageAt, lastSummary, held[] {id, actionId, kind, text, value, reasons, finding, deliverables?, createdAt}, awaitingUser?, resolvedAt?, reactions{replied, acted, dismissed, ignored, up, down}, createdAt, updatedAt, source{kind:'narrator'}}`。挂接只用结构关系（定时任务、`resolves`、同一证据）或 JEV `continues_thread` 的选择，不做文字相似匹配。`muted` 永不投递；静音/关闭走 K1 的 `PATCH /mind/threads/:id {status}`。
  - `findings[]`：`{id, topicKey, summary（消息原文，≤600 字）, textHash（规范化文本哈希，用于完全重复）, firstSharedAt, lastSharedAt, lastEvidenceHash, evidenceIds[], threadId, shareCount, lastItemId?, createdAt, updatedAt, source}`。
  - `pacing`（派生）：`{version, threshold, factors[{name, delta}], unrepliedChain, engagement, replyLatencyMs, lastPresenceAt, activeHours[], away, night, updatedAt, decisions[≤40], wake{level, ticksAtLevel, quietWakes, lastAt, nextAt, lastOutcome, history[≤50 {at, outcome: work|thought|failed, floor, tokens, latencyMs}]}}`。
  - 条目字段：主动 assistant 条目 `initiative.threadId`、`initiative.narrated = {version: 2, value, threshold, valueSource: jev|pacing, outcome, reasons[], continuing, via: explicit|schedule|resolves|evidence|judge|new_topic, context{away, night, present, unrepliedChain}, revision?{codes[], revised}}`、`initiative.deliverables?: [{path, name, description}]`（来自 `project_present`）。已移除 v1 的 `strategy`、`condensed`、`details`、`file`、`lessonIds`。`initiative.kind = 'welcome_back'`：`topics: [{threadId, title, text, deliverables?}]`（显示顺序）、`threadIds[]`（同序）、`overflowCount`、`text`（旧客户端用，内容与 topics 相同）；`'thread_close'`：`threadId`。
  - 收件箱条目：`threadId`（回来后摘要为 `threadIds[]`）、`deliverables?`、`pacing`：统一为 `{at, actionId?, kind, threadId?, outcome: send|hold|inbox|drop, reasons[], value?, threshold?, factors?, valueSource?, context?}`。`reasons` 取值：`above_threshold`、`time_sensitive`、`below_threshold_band`、`below_threshold`、`away`、`night`、`already_reported`（JEV 判断已说过）、`exact_duplicate`（规范化文本完全相同）、`thread_muted`、`scheduled_deliverable`、`welcome_back`、`welcome_back_overflow`。
  - JEV（内置、始终开启，只要有判断后端）：`message.value` v2（六个原子 noul + 动态 choice `continues_thread`（`thread_0..4` + `none`），state 为 `message`、`threads[{id,title,recent,lastMessage}]`、`findings`、`openItems`、`user`、`project{title, kind, deliverable?}`）；`message.check` v2（`status_ping`、`repeats_recent`、`result_not_first`、`internal_reference`（按项目类型：用户需要打开/处理的路径不算违规）、有交付物时 `describes_instead_of_delivering`；state 增 `project`）。宿主不再有任何文字正则检查：`proactiveMessageViolations` 只剩规范化文本完全相同。
  - 判断设置（所有 JEV 决策点）：不再有用户开关。默认全部开启（被 `turn.route` 取代的 `chat.route`/`chat.preflight` 除外）；后端自动：TypeSafe 密钥 → 快速模型（`fastModel`，旧 `llmModel` 迁移为它）作 LLM 判断 → 都没有则不判断。旧设置页保存的 `mode`/`modes`/`backend` 在启动时迁移删除（`settingsVersion: 2`）。诊断覆盖：环境变量 `RNA_JEV_MODE`、`RNA_JEV_MODES="point=mode,…"`、`RNA_JEV_BACKEND`，或宿主/测试写入带 `diagnostic: true` 的配置。`GET /api/decision-kernel` 的 `points[]` 去掉 `optIn`、新增 `builtIn`；新增 `settings.editable = ['apiKey','fastModel','autoModel']`、`settings.judgeOrder`、`diagnosticOverride`。
  - 工具：后台工作新增 `project_present {files: [{path, description}] (1–5)}`（Harness `present` 的等价物）：只接受工作区内已存在的文件，记录在任务 `jobs[].presented`，投递时成为条目的 `initiative.deliverables`。
  - 定时任务：工作者的最终回复就是发给用户的消息（只去掉宿主要求的最后一行“交接：”）；工作提示给出通用写作规范、定时任务声明的交付物和 `project_present`。JEV `message.check` 带交付物判断；有违规时 Agent 用同一项目模型自改一次（`revision`），改后原样投递。已移除 `DELIVER:` 约定、按文件名读取 `daily.md`、表格/哈希/校验行清理、≤300/200 字截断、“补一条”开头处理、状态汇报正则、代码估计的价值概率。
  - 指标：`proactive-metrics.mjs` 的 `computeProactiveMetrics(state, projectId, { window, now })` 由 K4 的唯一 `GET …/metrics` 合并；K2 键：`usefulShareRate`、`ignoreRate`、`dismissRate`、`longestUnrepliedChain`、`awayOrNightShare`、`exactRepeatRate`、`commitmentResolutionP50Ms/P90Ms`、`overdueCommitments`、`falseSilence`、`falseSilenceRate`、`invalidWakeRate`、`tokensPerWake`、`latencyMsPerWake`、`proactiveDelivered`、`narratorHeld`、`narratorDropped`（换说法的重复率由 K4 的 `repeatRate` 提供）。
  - SDK：决策 schema 可选 `resolves[]`；`tick({ wakeFloor })`；取消原因 `already_reported`、`below_threshold`、`thread_muted`、`exact_duplicate`；导出 `normalizedMessageKey`、`stripHandoff`。控制器选项 `narratorProvider` 用于 Agent 的一次自改（服务端接真实供应商）。
  - 基准：`benchmark/adapters/narrator.mjs`、`pacing.mjs`；新增场景 `coding-nightly-build`、`design-deliverable`；场景用假 JEV（`fakeJev` 支持 `message.value`）。

## 9. 进度

- **K1（心智层后端 + 每条消息信号捕获 + 学习修复，2026-09-29）**：`project-mind.mjs`（§8 存储/校验/上限：经验 ≤200 生效、议程 ≤40 未完成、承诺 ≤50 待完成、笔记各 ≤40；copy-on-write 写入；迁移从 milestones/openQuestions/约束/对话偏好播种并标注出处）、`mind-routes.mjs`（GET/POST/PATCH/DELETE 心智条目，👍/👎 反馈）、SSE `project.mind` 与 `counts`；`turn.route` 同一请求追加 7 个捕获问题，回退为快速模型分类或正则启发式（异步、不阻塞轮次）；经验写入（快速模型，否则主模型小预算；BM25 近邻 + `mind.judge` 去重/自动取代；过期/被多次推翻自动退役）；承诺（待完成请求 +4h 逾期、助手“稍后我会…”、失败/中止轮次；由后续轮次、`resolves`、`mind.judge` 或用户关闭）；前台/后台尾部注入与 `uses.recalled/applied/contradicted` 计数；用户笔记批量更新（只记事实与明确偏好）；G9 学习作用域 v3（漂移只标注、隐私才作废，`mind.health.learning` 显示暂停原因）；进化信号改用捕获结果（正则降为弱回退）。契约见 `docs/specs/stream-protocol-v2.md` 变更记录 K1。
- **K2（叙述者 / 自适应节奏 / 话题 / 已告知账本，2026-09-29；同日按用户要求改为 Pi/Harness 方式）**：
  - 叙述者 `proactive-narrator.mjs`：消息就是 Agent 自己写的文字，原样投递；文件由 `project_present` 声明为交付卡片。宿主只做密钥脱敏与规范化后完全相同的重复拦截；质量（`message.check`，违规时 Agent 自改一次）与价值/已说过/话题（`message.value`）全部由内置 JEV 判断，已说过直接丢弃。没有判断后端时只按节奏送达。已删除所有文字规则（相似度、开头词、表格/哈希/校验行清理、截断、按约定读取文件、状态汇报正则、代码估计概率）。
  - 节奏 `proactive-pacing.mjs`：无条数上限或固定冷却；门槛 = 0.45 + 未回复链（第 2 条起每条 +0.07，封顶 +0.35，回应即清零）+ 刚发未读（对话不活跃时 30 分钟内 +0.1、2 小时内 +0.05）+ 互动率/回复延迟 + 项目阶段 + 近期低价值 − 防沉默衰减 + 话题反应。离开/夜间只放行 JEV 判断为紧急的内容，其余留在话题里，回来后以结构化 `topics` 的一条消息送达。
  - 唤醒：Headlong 式阶梯；`event_only` 在有未闭环议程/承诺/暂存消息时作为底线；J2 缓存对齐提前唤醒作为节奏输入。
  - 判断设置：所有 JEV 决策点内置默认开启，无用户开关（见 §8.1）。
  - 场景基准 9/9 通过（新增编程项目夜间构建、设计项目交付文件两个场景）。
  - 与 K1 的衔接：`resolves[]` 在行动完成/投递后才结算；话题反应读 `item.feedback.vote`；话题挂到议程时回写 `agenda[].threadId`。
- **K1 补充（议程核对，2026-09-29）**：迁移播种的旧开放问题/里程碑按对话证据自动核对（仅判断：TypeSafe → 快速模型 → 无，无判断不改动）；BM25 取证 + `answered/superseded/needs_user_input_now`；迁移后自动一次、之后有新证据才重核；`POST …/mind/reconcile`（dry-run）与 `rna mind reconcile`；侧栏只显示真正阻塞的“等你回应”。
