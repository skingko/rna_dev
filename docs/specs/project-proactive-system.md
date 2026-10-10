# 以项目为中心的持续主动 Agent

版本：v0.3 · 2026-09-24。目标产品规格；与当前原型的实现边界见第 12 节。本规格修正“先建 Goal 才有自主性”的旧设计：持续理解项目、主动工作和适时沟通是平台常态，Goal 是其中一种可选的明确承诺。

## 1. 产品主轴

用户进入一个项目，AI 已知道该项目的代码、当前问题、近期交流、尚未兑现的承诺、可用能力、偏好及资源上限。用户可以自然交谈、提问、讨论取舍，AI 也可以在获得有意义的新证据时主动加入对话：发现重复故障后调查，看到前提变化后修正计划，兑现先前承诺，或报告自主研制的更好版本。用户不需要逐次下达“分析”“学习”“评测”“通知我”的命令。

“持续”指持久身份、项目状态、事件感知及可再次进入决策的能力，不要求模型不停生成 token。事件触发一次思考机会，模型决定做什么；发现没有必要时等待。后台沉默、对话活跃、多个可中断动作可以同时成立。产品不把模型的内部推理全文当作聊天内容，也不虚构人类的情感和意识。

典型一段协作：用户谈到最近发布较慢；AI 根据当前项目证据发现测试重试的共同原因，在隔离分支复现；用户途中插入“先看登录错误”；AI 及时回应并调整当前优先级，原调查保留为关注项；其后进化通道产出新测试选择策略，经独立评测后，AI 在同一项目的相关会话说明改进证据，并提供“试用新版 / 查看比较 / 暂不提醒”。这条故事可以分支、暂停、失败或完全不产生候选，不是预先编排的七步动画。

## 2. 上游已有能力与 Rna Agent 新增能力

| 能力 | 源码核实 | Rna Agent 采用方式 |
|---|---|---|
| 没有用户命令也能决定行动 | Headlong 每次 wake 读近期轨迹与路由信息，选择 act/share/think/learn/recall/goals/values/idle；goals 本身只是选项之一 | 项目意识提供稳定身份与最新证据；Goal 不作为 Initiative 的启动条件 |
| 主动说有用的话，也选择沉默 | Headlong share 面向具体接收者，只分享新信息；idle 明确允许无事可做；responder 也可 no_reply | 项目内自然对话、内容去重、合适时机投递、安静时段与用户反馈 |
| 即时对话与长任务并行 | Headlong 独立 responder，无法立即完成的请求通过 defer/action 形成承诺，再由 monolith follow-up | Responder 与 Initiative 独立调度；承诺、消息归属和投递回执持久化 |
| 运行中插话/排队/停止 | DSH composer、pending submissions、queue/steer、Stop 与过程投影已有实现 | 继承交互语义，同时为多后台 lane 增加明确 targetRunId 和优先级 |
| 经验积累 | Headlong learn 调用 mem add；OpenViking 另有经验/技能处理 | 记忆与经过评测的行为版本分别存储，不能把一次记忆写入当成能力提高 |
| 项目级三个 lane、独立评测、项目版本试用与回滚 | 不是 Headlong 已提供的完整机制 | Rna Agent 新增控制平面、数据域、发布指针和通知协议 |

Headlong 的主决策菜单及对话分工见 [monolith prompt](https://github.com/laude-institute/headlong/blob/ca0b4017f7bda7b8566c59e75a9683f635534356/thinkers/monolith/prompt.md#L5-L22)；它的 responder 明确区分 reply/defer/no_reply，见 [responder 提示构建](https://github.com/laude-institute/headlong/blob/ca0b4017f7bda7b8566c59e75a9683f635534356/thinkers/responder/step#L442-L515)。旧上游 design 文档可能滞后于当前实现，本规格以固定提交的可执行代码和 prompt 为准。

DSH 的 [提交策略](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-conversation/src/client/input/submission-policy.ts#L18) 与 [输入按钮状态](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx#L295) 支撑运行中协作；项目级主动调度不是单靠复制这些组件即可得到。更多源码结论见 Headlong 审计 和 DSH 交互审计。

## 3. 项目是持久主体

```text
Project
  ├─ workspaces / repositories / allowed resources
  ├─ awareness: observations, evidence, concerns, commitments, preferences
  ├─ sessions → turns → messages / tool activities / artifacts
  ├─ decisions → runs / waits / shares / evolution campaigns
  ├─ capabilities + active / trial / candidate versions
  └─ budget / autonomy policy / notification policy / audit
```

Project 是产品工作单元，Workspace 是可访问的目录/仓库环境；一个项目可以有多个会话和工作区快照，不能用目录字符串当全部项目状态。Session 是交流空间，关闭会话不删除项目关注事项；Run 是一次执行，结束后项目仍可观察和行动。Goal 是用户或 AI 提出的明确目标，增加验收标准但不创建或赋予自主能力。AI 提出 Goal 时标明推断，不把它伪装成用户已承诺的需求。

| 对象 | 必须包含的事实 | 如何更新 |
|---|---|---|
| Observation | 来源、发生时间、采集时间、项目与资源版本、证据引用 | 不可变记录；重复源事件幂等 |
| Evidence | 原始输出/测试/变更/用户话语引用、hash、可见范围、有效期 | 内容变化后失效或新增，保留历史 |
| Concern | 关注什么、为何相关、证据、置信依据、优先级、依赖、停止条件 | 模型可提出/重排/关闭；用户修正优先 |
| Commitment | 说过要做什么、对谁、关联消息、截止/等待条件、负责人、完成证据 | 先持久化再向用户承诺，完成必须有交付回执 |
| Preference | 用户偏好、原始语句、作用域、有效期 | 显式更正覆盖旧偏好，推断只作可撤销假设 |
| ProjectSnapshot | stateVersion、近期变化、活跃关注项、承诺、资源版本、发布状态 | 由事实投影生成；不是将所有聊天全文塞入每次 prompt |

事实、推断、意图分开。用户说“这个实验先不用了”会关闭对应 concern、取消未开始的动作、撤销候选通知；不能因为旧摘要写了“长期目标”继续推进。跨项目经验默认隔离，显式共享的通用技能也必须剥离项目私密材料。

## 4. 三条协作通道

| Lane | 职责 | 对话表现 | 约束 |
|---|---|---|---|
| Responder | 及时理解新消息；直接回答、澄清、接收修正、委派工作 | 正常助手回应；长任务有明确交接，不空口承诺 | 高优先级，保留独立响应预算；不等待背景模型调用完成 |
| Initiative | 综合项目状态，自主选择行动、分享、反思、召回、整理关注项或等待 | 只在有新内容或需要决策时进入会话，其余工作低噪声显示 | 项目政策内行动；每步可重新排序与被中断 |
| Evolution | 从项目证据发现行为缺口，生成版本、构建、评测、管理试用与回退 | 关键结果经统一发布通道形成自然消息和版本卡 | 独立候选目录/预算/评测器；无权改写正式控制器 |

Lane 是职责与调度边界，不必等于三个永久付费模型循环。正式实现可为不同 lane 使用独立 Pi session，并共享经过授权的 ProjectSnapshot；每个 Pi session 保持单 owner。Responder 不直接改另一个 session 的模型历史，而是投递带目标与前提的控制事件。前台会话的统一消息编排器将多 lane 输出按因果关系呈现；不会让三个 agent 同时重复回答用户。

用户消息、撤销/急停、权限变化优先于主动探索；明确承诺优先于没有时限的机会；进化使用剩余资源和独立额度。优先级只影响准入和下个安全边界，不能假设已经发出的远程请求能立刻撤回。共享工作树写入受资源租约控制；进化始终使用隔离 worktree/快照。

## 5. 项目感知与模型决策

事件来源包括用户交流、文件/仓库变化、构建/测试/工具结果、依赖解除、承诺到期、评测完成、用户接受/撤销修改、版本试用结果，以及有实际检查理由的时间提醒。文件 watcher 的一百条变化先合并为有意义的 diff；轻量筛选负责去重、冷却、scope 和费用准入，不把“看到了哪个关键词”当作完整智能决策。

```text
持久事件 → 去重/合并 → 更新项目事实与版本
           → 唤醒候选（证据、原因、有效期）
           → 预算/策略准入 → 装配项目快照 → DecisionAdapter
           → 校验前提仍有效 → act / share / reflect / learn / recall / wait
           → 动作证据、承诺、通知回执 → 项目状态
```

每次决策是可审查的短理由与结构化意图，不存储或显示私有推理全文。正式 `DecisionAdapter` 由模型根据快照自主选择，规则只守住权限/资源约束。可运行原型允许确定性 adapter 验证状态和交互，但须标为模拟，并用不同事件组合测试分支，不能声称“模型自行判断”。

```ts
// Rna Agent 目标接口；不冒充 Pi/Headlong 已有类型
interface InitiativeDecision {
  id: string;
  projectId: string;
  snapshotVersion: number;
  triggerEventIds: string[];
  evidenceIds: string[];
  concernId?: string;
  goalId?: string;                 // 可选；无 Goal 仍可决策
  choice: 'act' | 'share' | 'reflect' | 'learn' | 'recall' | 'wait';
  reasonSummary: string;
  expectedBenefit?: string;
  proposedAction?: {kind: string; args: unknown; resourceVersions: Record<string, string>};
  communication?: {sessionId: string; replyTo?: string; noveltyKey: string};
  reconsiderOn?: {eventKinds: string[]; notBefore?: string; expiresAt: string};
  budgetReservationId?: string;
  decisionSource: 'model' | 'simulation';
}
```

`wait` 是成功的判断结果：记录为什么暂不行动、哪些变化值得再看，普通对话不出现“本轮选择 idle”噪声。无变化时退避，无预算时停在等待；既不要求永久轮询 LLM，也不因一次等待将主动性永久关闭。重复 think 但没有新证据不得重置活跃奖励，参考 Headlong 对 visible work 与 thought 的区分。[工作探测逻辑](https://github.com/laude-institute/headlong/blob/ca0b4017f7bda7b8566c59e75a9683f635534356/thinkers/monolith/step#L348-L378)

## 6. 主动交流和打断是一条对话

主界面为“项目选择 → 项目会话 → 常驻输入”。项目页提供项目摘要、近期改变、待兑现承诺、工作区和版本入口，但进入项目后可以直接聊，不经过任务表单。主动消息使用普通助手排版，带轻量“主动发现 / 版本可试用”来源；触发证据和运行细节按需展开。用户不必进入“自主能力演示”页面才感受到主动性。

| 对话发生的事情 | 系统行为 |
|---|---|
| 后台工作期间用户问一个问题 | Responder 优先回答；背景动作不必取消；当前工作仍可查 |
| 用户明确改变当前动作方向 | steer 指向 targetRunId，展示待接收与已生效；下个安全边界检查最新项目版本 |
| 用户只是补充一个后续要求 | follow-up 持久排队，当前轮/动作结束后处理 |
| 用户说“先别做这个” | 解析到明确 concern/run；停止对应工作，保留未消费输入；不默认停掉全项目 |
| 用户说“这个项目先安静一下” | 更新项目主动政策/提醒政策；清楚区分停止工作与只暂停打扰 |
| 主动结果与当前话题直接相关 | 在原会话插入简短消息，保留 replyTo/concern/candidate 归属 |
| 与当前话题无关或用户在专注输入 | 写项目收件箱，适当时机合并投递；不抢焦点、不覆盖草稿、不自动滚离历史 |
| 用户点“暂不提醒” | 存 notification disposition/cooldown；同一候选不重复提醒，实质证据变化才能重新判断 |
| 用户拒绝某个方向 | 将拒绝作为范围/偏好更新；解释必要影响后收敛，不换说法反复推动 |

操作者必须区分“停止这次动作”“暂停项目主动工作”“暂停进化”“暂缓提醒”和“全局急停”。这些控制不是同一个布尔值。关闭窗口后由 daemon 保持事实与授权状态；系统不能将浏览器关闭当成允许扩大外发范围。

所有可见消息有唯一 `messageId`、`projectId`、`sessionId`、`origin`（user/responder/initiative/evolution）、可选 `replyTo/runId/decisionId/candidateId`、内容与创建版本。后台行动不会插入虚假的 user 消息来启动工作。多 lane 对同一触发的发言需领取回复归属与 outbox key；刷新/重试仅补送缺失回执，不产生重复话语。

正常对话优先自然语言：“我发现最近三次失败都来自同一个测试准备步骤，已在隔离分支复现。”证据卡再说明具体输出。只有用户需要时才解释 lane、wake 或调度器；可观测性不等于把运行机械过程倾倒给用户。

## 7. 让后台真正可打断

1. 新消息先持久化；Responder 获取最新项目版本并确认其语义，提交 `reconsider/steer/cancel/update_preference` 之一。
2. Initiative/Evolution 在新工具准入、候选冻结、评测提交和消息发送前重新验证 snapshotVersion、资源版本与政策版本。
3. 若相关前提变化，旧决策变为 superseded；重新判断、缩小动作或等待。旧模型迟到输出保留为证据但不能继续发布。
4. 已开始的可取消工具接收 AbortSignal；不可撤回副作用保持 unknown_effect 并核对。取消确认由执行层给出，UI 不能乐观显示“已全部停止”。
5. 持久队列中的用户文字完整保留；停止时可取回草稿。未完成承诺保留状态及原因，不能随 run 一并消失。
6. 本次打断不清空项目记忆、研究证据或候选版本；恢复时重新校验环境，不从过时程序计数器盲续跑。

多 lane 同时改变同一个项目使用事务、expectedVersion 和资源锁。项目状态版本可使消息与提案失效，但必须按相关字段判断，不能因为无关会话新增一个字符就废弃全部背景计算。用户撤销授权是硬失效，不受相关性优化影响。

## 8. 完全自主的项目进化

自主的是完整研究链：发现项目能力缺口 → 自定可证伪假设 → 生成候选版本 → 构建/评测 → 拒绝或保存有效候选 → 选择适当时机告诉用户 → 持续跟踪试用。用户无需按阶段点击“开始进化”“开始评测”“生成报告”。任务成功本身、失败趋势、用户反复纠正、环境变更都可以触发学习机会；无证据与低价值时不制造版本。

项目版本是不可变 manifest：关联项目、父版本、Pi 核心兼容版本、skills/workflows/tool adapters/retrieval/prompt 的 hash、数据/评测版本、成本和适用任务族。一个项目产出的 candidate 不自动改所有项目的共享技能，也不自动升级 Pi/Rna Agent 核心或权限/评测基础设施。

`activeVersion` 是后续默认使用的稳定版本，`trialVersion` 是该项目/指定会话的可撤销试用，`candidateVersions` 是隔离实验。创建 Run 时固定完整 manifest；正在执行的 Run 不因试用按钮或发布事件热换代码。项目应用代码补丁与 Agent 行为配置是两个发布维度，不能混用“新版本”；版本卡需写明改的是项目代码还是该项目的 Agent 能力。

若候选证据不足，自动扩展允许的评测或保留实验状态；不能宣称更优秀。若独立评测显示达到预声明门槛，产生 `version.eligible`，由 Initiative 选择交流时机，在项目会话附版本比较及“试用新版”。**主动提醒不等于安装，独立评测通过不等于当前生产策略已切换。** 用户也可在项目政策中预先允许低风险版本自动试用/晋升，此时只在既有范围执行，并主动报告实际状态。

完整指标、隐藏集隔离、版本状态机、自动回退与通知协议见 [进化与评测规格](evolution-and-evaluation.md)。没有真实评测器时显示“模拟评测 / 待验证”，不把预置分数当成能力证据。

## 9. 缓存、预算和运行节奏

项目身份、工具声明和能力版本形成稳定前缀；当前事件、证据增量、关注事项与会话变化置于合适的消息尾部。三个 lane 可维护各自 Pi session affinity，共享结构化事实而不交叉写同一会话文件。更新 ProjectSnapshot 不等于每秒重建 system prompt。[Pi 复用与缓存规格](pi-integration-and-cache.md)

唯一的例外是到期的日程运行（`action.hostSchedule`）：它只声明自己能执行的工具（`surface: 'executable'`），不声明那些只为对齐前缀而存在、在后台本来只会返回 `tool_unavailable_for_purpose` 的用途专属工具（`agent_*`、`capability_*`、`ask_user`、`project_schedule*`、`request_project_permission` 等）。依据是实测而不是推测：177 个后台运行、5,339 次工具调用里没有一次调用过它们（`benchmark/surface-replay.mjs` 逐个 journal 断言每次调用的名字都在该运行自己的 `host-authorization.executableTools` 里），而它们占每个请求约 5K tokens；zcode 与 deepseek-harness 同样不向模型暴露不可执行的工具。系统提示逐字节不变；`host-authorization` 把这些名字列入 `notDeclaredHere`，并附固定英文规则句；模型若仍调用，SDK 返回 “Tool is not assigned to this session.” 回执，运行照常结束并交付。前台、决策启动的后台运行和子 agent 仍声明完整数组，同一项目共享一份前缀；精简数组不发布为项目的共享前缀（学习与 compaction-fork 探针读的是前台那份）。暂停后继续的运行沿用 job 记录里的 `surface`（缺省 `full`），所以同一次运行前后两段的前缀不变；环境变量 `RNA_SCHEDULED_SURFACE=full` 让此后开始的定时运行回到完整数组（回滚开关）。上线后观察前 20 个定时运行里“未分配”回执占其工具调用的比例：`surface-replay.mjs` 在该比例超过 0.5%（`--max-not-assigned` 可改）时判定失败，此时用回滚开关回到完整数组。

项目预算为根；按 Responder、Initiative、Evolution 分配子预算，Goal 可有更小预算但不是总账根节点。预算计入思考、失败、重试、摘要、评测、子 Agent、检索和 cache warmer。为直接交流保留响应额度，后台耗尽不应让用户无法询问状态或停止；本地停止和查看账本不依赖付费模型。

策略独立配置 `initiative.enabled`、`evolution.enabled`、可行动范围、研究额度、通信静默时间、并发和过期规则。项目建立时展示可理解的默认值，在范围内自动运行；不要求先建 Goal。无事件且无需复查时零模型调用；到期关注项可以自主唤醒，但必须记录为什么值得再看，不能用定时器制造“活着”的台词。

### 9.1 每种唤醒由哪个时钟负责

Headlong 只有一个时钟（调度器的 `wake_at`）；Rna 的后台决策有四个。修好其中一个，不代表另一个驱动的唤醒也停了。

| 时钟 | 位置 | 负责什么 | 不负责什么 |
|---|---|---|---|
| 节奏通道 | `project-rhythm.mjs`、SDK `resolveProjectRhythm` | 此刻**允许不允许**做新决策：`new_evidence`（证据键变化）、`review_due`（模型评估的复查间隔到了）、`conversation_live`、`assessment_required` | 不定时刻，只开关 |
| 地板阶梯 | `proactive-pacing.mjs` `wakeFloor` / `advanceWake` / `applyWorkOutcome` | 只管 `event_only` 项目、以及 recurring 项目两次 occurrence 之间，且有开放议程、待办请求或暂存消息时：按 `WAKE_LADDER`（10 分钟 … 8 小时，每级停 `WAKE_HOLD` 次）退避；只有行动的**可见结果**（§9.2）重置它，宿主接纳一个决定不重置 | 节奏通道已经打开的项目 |
| SDK 复查延迟 | 协调器 `nextReviewAt`（决策的 `nextReviewAfterMs` 加空闲退避） | 通道打开时**何时**真正决策；新证据（revision 变化）立即到期 | 通道关闭时的任何唤醒 |
| 门控延迟 | `DecisionService.deferralDelay`、门控 `retryAt`、`in_progress_covers` 持有 | JEV 判"不必唤醒"后同一情形推迟多久（1–5 分钟）；同一情形最多推迟两次，第三次交给主模型 | 新证据（新证据让推迟立即失效） |

另外三件事不是时钟：

- **前台租约**是证据边界：前台轮次运行期间决策等它自己的 conversation_result；逾期请求同样被租约扣住（B3），由轮次结束后的那次审视处理。
- **定时 occurrence** 按自己的到期时刻运行（`project-schedules.mjs`），不经过以上四个时钟。它的首请求只带一份任务文本（token 用量修复 T3）：规划状态里本日程的 `task` 在与本次 occurrence 消息逐字相同时换成固定英文占位；本次运行自己的回执和 pending job 不再重复；较早运行的回执只显示它任务的开头、结尾和“中间省略”标记：开头是当前任务的前缀、结尾是当前消息结尾时，这段摘录换成一句占位（保留 occurrence 行与交接）。占位只陈述摘录给出的两端与本请求逐字相同、中间当时就没有显示（project_history 可读原文），不声称两次任务相同：真实 run 里 7 处替换只有 1 处的整段任务确实相同，其余只在摘录没显示的中间部分不同。其余一律原样保留（聊天摘录、其他回执、更早运行的交接）。日程在运行中被改过则占位不再成立，下一次请求带完整新文本，运行照常走过期路径。运行把对话压缩过之后，它的 occurrence 消息已成摘要（摘要不抄规划状态），规划状态里本日程的 `task` 即带完整文本：那是任务原话唯一保留的地方。`benchmark/brief-inclusion.mjs` 在真实 run 上逐片段验证被去掉的内容都逐字在请求里（只有本次运行自己的 action id 和被去掉行的五个状态标签不是文本，检验逐项列出）。
- **暂存的问题**（F4）由用户回来释放（在场，或之后写过消息），按叙述记录发出（harness `agent.ts:213-232`）。行动上的 10 分钟后备重试只是兜底：记录还在时不叙述；记录不在时（回滚到 F4 之前的版本，或记录离开了话题）重新叙述，同一问题不会比每 10 分钟一次更频繁。

各时钟的规则（B3）：

- 地板阶梯：协调器此刻做不了决策时（执行槽被后台工作占满、未确认的执行或外部复查、失败或持久化退避、行动历史已满），到期的地板唤醒不触发、保持待发，空出后的第一次 pump 再触发（Headlong `bin/thinkers:875-895`）。没有得出决策的唤醒（空转、忙、受阻）什么都不记，不动档位、计数和 `quietWakes`（`monolith_backoff.md:173、261-265`）；已经触发却因预算不够请求而没决策的地板唤醒，只按当前档位的间隔重新武装计时。
- 档位：主模型的等待（`thought`）和 JEV 的推迟（`deferred`）都走完整阶梯，没有 `THOUGHT_CAP`（Headlong 的 thought 是廉价 tick，Rna 的是付费决策）；`quietWakes` 只计主模型的等待。
- 逾期请求（`commitment_overdue` 规则）：不在前台轮次期间绕过；请求提出 14 天后不再按规则追（Headlong `PENDING_MAX_AGE`）；主模型看到逾期请求仍选择等待时，它写下的理由就是拒绝理由，记在 `mind.pacing.overdueDeclined`，同一证据 revision 下不再绕过，新证据到来后恢复。门控的 JEV 判断仍能在 `openWork` 里看到所有逾期请求。
- 证据键只散列外部/实质证据：用户消息、完成的轮次、观察、完成的工作、日程、送达、失败。会话模式（计划模式开关）是运行时状态，不算证据（Headlong 把运行时变化记成下一次唤醒提示里的事实，不为它唤醒）；启动时把已消费的旧格式键迁移到新格式，升级本身不会被读成新证据。

### 9.2 行动结果与唤醒阶梯（C2）

主模型的一个决定被宿主接纳，只是一个承诺；用户或项目文件夹是否真的有了变化，是另一回事。Headlong 在 2026-08-24 的修订里只让**可见步骤**（动作、观察、合并、消息，比较运行前后最后一个可见步骤的 id 得出）重置退避（`monolith/step:357-373、582-586`）。Rna 把这条判断做成一个纯函数 `actionOutcome(project, actionId, now)`（`work-outcome.mjs`），从已有的记录派生，不是事件总线，也不是第二份真相。

**六个阶段**，名称固定、互不相同（harness `schedule.md`："dispatch means queued, not that a model answer succeeded or the user read it"），每个都是记录里的一个事实，不由上一个推断：

| 阶段 | 事实 |
|---|---|
| `decided` | 主模型选了这个行动（它的唤醒行；没有则取宿主接纳的时刻） |
| `admitted` | 宿主接纳：SDK 里有这条行动记录（重复或已被覆盖的决定不会被接纳） |
| `ran` | 它的处理程序跑过：后台运行开始、消息开始撰写 |
| `applied` | 它的改动到了项目文件夹：保留的改动集、保留的直接修正 |
| `delivered` | 有东西送到了用户：对话里的消息、收件箱条目、问题卡、带着它的摘要或欢迎回来、已建立的日程 |
| `reacted` | 用户回复、操作、忽略（窗口到期）、驳回或点赞 |

**五种结果**：`visible`（已应用或已送达）、`pending`（已接纳、未了结：排队、运行中、改动集在等应用、消息暂存等用户回来或等每日摘要）、`none`（了结了，但头脑之外什么都没发生：没人被告知的只读运行、被叙述者丢弃的消息、被其他运行覆盖的工作、被新证据取代的决定）、`undone`（用户把它的改动撤了）、`failed`（失败，且没有可见的东西；运行失败前已写下并保留的文件算可见，Headlong 先判可见）。

**读哪些记录**：SDK 行动（只给在世行动的状态）、后台任务（jobs）、改动集（`backgroundChanges`）、直接修正（`directFixes`）、收件箱条目和它们的反应、对话里主动送出的条目、话题里暂存的消息、用户的撤销（git 应用记录）。除了 SDK 行动，这些记录都比 SDK 的历史压缩活得久，所以行动离开 SDK 的 `maxHistory` 之后，迟到的撤销仍然找得到它的行。

**记到原行动上，不重复计数**：
- 欢迎回来：它带走的暂存行属于哪些行动，写在消息的 `initiative.actionIds` 和收件箱回执的 `creditedActionIds` 里；送达记给这些原行动，回执 `welcome-back:<id>` 自己不是行动，没有自己的结果。溢出到收件箱的话题本来就以原行动的 `actionId` 记账。
- 每日摘要：摘要合并的每条收件箱条目都带原行动的 id，摘要组成时（`digestedAt`）记为那一个行动的送达；摘要消息不是行动。
- 只读调查：之后一条消息引用了它的完成（`action:<id>:completed`，`communicationStatus` 用同一个链接）并送达，这次调查记为通过那条消息可见。

**只持久化迁移**：`<state>.rna/metrics/work-outcomes.jsonl`，一行一个 `{ actionId, from, to, at }`（外加 `projectId`、`kind`、`reason`）；一个动作只在它迁移到某个结果时发出一次，重启后重算视图、与最后一条持久化的 `to` 比较，不会重复发出；回到曾离开的结果（用户撤销了自己的撤销）允许，因为中间那个结果先记下了。"最后一条持久化的迁移"按发出顺序取（文件里的顺序），不按 `at` 取，并且迁移的 `at` 不早于它跟随的那一条：撤销被撤销后 `visible` 从旧改动集的应用时间算起，比它跟随的 `undone` 还早，若按 `at` 取，维护循环的每一轮（约 5 秒）都会再发一次 `undone → visible`（日志无限增长，阶梯被反复重置）。派生出的倒退（`visible` 退回 `pending`）是记录老化，不是新闻，不发出。没有自己时刻的结果（被取消或失败的 SDK 行动没有 `finishedAt`）记在行动被接纳的时刻，不是此刻：否则它们离开日志（31 天）后会被再次发出、第二次折进聚合，升级后第一次启动也会都盖上升级当天。迁移保留 31 天，更早的折进每日聚合 `outcomes-daily.json`（B7 的 `DailyRollup`，水位线保证恰好折一次），比日志留存还老的 SDK 行动不发出；聚合单元的键带 `from`（首次见到记 `new`）和 `neutral`，让报告数行动而不是数迁移。撤销在 7 天（`WORK_OUTCOME_HORIZON_MS`）内仍追踪：SDK 行动、任务、改动集、收件箱条目都没了，只剩 git 应用记录时，迟到的撤销也找得到（日志里跟着的行动）。已删除项目的行随项目一起删。

**不是行动的**：宿主自己的定时 occurrence（SDK 行动的 `hostSchedule`、任务的 `scheduleId` / `occurrenceKey`、收件箱条目的 `scheduled`、日程 occurrence 行的 `actionId` / `deliveryActionId`，任何一条记录说是，这个 id 就没有结果）是用户的日程在触发，不是项目心智做的决定：它们不进结果视图、不进"决定过的行动"的比率。

**中性取消**：用户停下的运行、宿主重启、范围变化、没留下原因的取消（`neutral`）结果是 `none`，但不说明这次唤醒该不该：不写标签，也不动阶梯（被中断的决定从来不算空唤醒，这里一样）。

**结果阶梯（选项 C）**：被接纳的决定在唤醒行上记为 `pending`（带 `actionId`），不重置阶梯；档位、计数、`quietWakes` 保持不变，计时按当前档位的间隔重新武装。行动的结果迁移时：`visible` → 档位 0、计数 0、`quietWakes` 0，并记 `wake.lastVisibleAt`；`none`、`undone` → 一个"想了但没做"（停 `WAKE_HOLD` 次再降档，主模型的等待计入 `quietWakes`）；`failed` → 立刻降一档；中性取消（`neutral` 的 `none`）什么都不动，一次范围变化取消十几个排队行动不是十几次空唤醒。`cacheWakeAllowed` 的"最近有真实工作"读 `wake.lastVisibleAt`（用户在场用的同一个 2 小时窗口），不再读 `lastOutcome === 'work'`。定时 occurrence 的结果不动这条阶梯：只有主模型某次唤醒决定的行动才有唤醒行。

**标签（PDL-7）**：唤醒行记下它来自哪几行判断（`gate: { ledgerId, deferred[] }`），行动的结果（和消息被回复、忽略等反应）写 `source: 'outcome'` 的标签，取代主模型自己的下一步产生的 self 标签（规则见 `stream-protocol-v2.md` §6 校准；`labelOutcome`）。`wait` 和未被接纳的决定没有结果，继续用 self 标签。结果之后又变（保留的改动被用户回退）会改写标签。

**唤醒行的层级（影子）**：每条唤醒行记 `tier`（`request` | `think`）和 `tierFacts`，由代码按事实算出（`wakeTier`）：本轮证据里有前台轮次的结果、用户消息指向主动条目（`capture.target`，由 JEV 或快速模型给出，正则兜底的猜测不算）、有未了结或逾期的用户请求、复查失败、一张主动卡被回答 → `request`；其余（地板、定时、到期复查、不欠请求的工作后唤醒）→ `think`（Headlong `monolith/step:425-441`，两个事实）。**只记录**：不路由、不降档、不换模型（更便宜的模型也是质量变化，要等你延后的 GLM 回放）；体验报告的 `wakes.byTier` 给出唤醒的构成。

**唤醒行搬到 sidecar**：`<state>.rna/metrics/wakes.jsonl`（日志根目录内，保留 31 天；B7 的 `wakes-daily.json` 仍按提交折进每日计数，这里不重复计数）。热状态的 `mind.pacing.wake.history` 只留最新 `WAKE_STATE_TAIL`（8）行，供显示、每日折叠和回滚。启动时把旧版本写在状态里的行搬进文件（先落盘，再裁剪状态），回滚到 0.68.0 再升级回来不丢行。写不进文件时（磁盘满）`WakeLog.append` 返回 false，状态里的行保持原样，不裁剪；下一次 `append` 写得进去时，先把内存里的全部行原子重写进文件（失败过的行也在里面），之后状态才裁到尾部。行里只有次数、代码和 id，不含提示或消息文本。

### 9.3 后台完成的复查（选项 B，影子；D2）

**今天的行为（未改）**：每个后台运行完成，门控都把下一次复查直接交给主模型（`bypass_delivery_just_completed`，`DecisionService.bypassSignal`；前台轮次期间改由门控判断）：一次付费决策，不管这个运行留下了什么待决定的事；定时 occurrence 的完成也一样。mu 把结束的后台任务路由成 `now | next_turn | drop`，没有判断时默认 `next_turn`，空闲时不唤醒（`notify-routing.ts:33-60`、`background.ts:108-121`）。

**D2 只做影子**：每个完成（门控第一次看到它时）算出它**会**走的路线，记进判断账本（`point: 'work.completion'`，每个运行一行，重启不重问），真实路线不变；`GET /api/v2/decision-kernel/completion`（`./rna judge completion`）事后把它与复查实际带来的结果对照。任何一次复查都不因它改变。

**路线的决定顺序**（`work-completion.mjs completionFacts`，代码事实先于判断，mu 的事实先于收尾消息，`goal-met.ts:7-17`）：

| 类别 | 条件 | 会走的路线 |
|---|---|---|
| `needs_review` | job 没有顺利结束（需要核对） | 复查 |
| `unreported` | 运行没有留下汇报（最后一步是没发出的工具调用，`job.unreported`） | 复查 |
| `schedule_occurrence` | 宿主自己的定时 occurrence（`hostSchedule`） | **不复查**（宿主自己送达） |
| `resolves_pending` | 动作声明了 `resolves`：欠用户一个交代 | 复查 |
| `no_handoff` | 工作者没有留下交接，没有可判断的内容 | 复查 |
| `judge` | 其余 | 完成模板（`reports_untold`、`names_next_step`、`evidence_relevant`，一次批量调用）；回退（没有判断、没有答案、预算上限）= 复查，与今天相同 |

失败的运行没有完成事件（`action_completed`），照旧走 `severe_failure` 旁路，待核对的行动走 `pending_review` 旁路：都不经过这里，也不会进入影子判断。

**不做的**：问 JEV“做完了吗 / 做对了吗”（mu 测过，收尾消息上的布尔太薄）；让判断读代码已知的事实（类别、改动集、真实路线都不进 state，只记在账本行的 `outcome` 里供报告用）；在影子期间省掉任何一次复查。

**账本行**：`outcome { actionId, class, change, changed, real, basis, route, reason, others? }`（`basis`：`judge`、`code_fact`、`fallback`、`budget`；`real`：真实路线的旁路信号或 `judged`；`others`：同一次复查还读了几条别的新证据，用户消息和另一次运行的完成都算，即除这次完成之外的每一条新证据；那样的完成结果不全是它的，报告把它们单列）。有明确预算上限时（`realTokenBudget`）判断不发，行记为 `basis: 'budget'`，不算有判断。只在 JEV（TypeSafe）后端上运行：没有 JEV key、只配了快速模型时（后端是 LLM 判断，阈值高 0.1、没测过，每次完成都要付一次观察费用）不发判断、不记录，连代码事实的行也不写。账本在 `<state>.rna/metrics/` 里，没有新的 sidecar；回滚到 0.68.0 不读这个文件，再升级回来行还在。

**对照怎么读**：标签只来自 C2 的结果记录（§9.2），读的是这次完成唤醒的那次复查自己接纳的行动（唤醒行的 `actionId`），不是“引用了它的行动”（主模型总是引用最新事件，工作链上每次运行都会被下一次引用）；“告诉了用户”也一样：一条只是引用了这次运行的消息，要么是读了它的那次复查自己的行动送达的，要么在下一次复查开始之前就到了用户手里，才算（几小时后另一次复查分享的、引用了好几次运行的消息不算）；复查了但什么都没接纳记为 `waited`，是主模型自己的选择，单列、不当作结果标签。运行的结束时间读行动、行动没了读 job，账本行自己的时间不能当替身（它写在读这次完成的复查开始之后）；两者都没了的运行无法对到某次复查（`attribution.unknown`），不进对照。同一次复查（同一条唤醒行）读了的几个完成互为 `mixed`，不进对照；复查本来就由别的原因强制进行的完成（`real` 是 `due_schedule`、`pending_review`、`unanswered_question`、`severe_failure`）单列为 `forced`，不计入任何比率和 token 数（省掉它们省不了任何东西）。`deferMissed`（本会被省掉的复查里实际有成果的占比）要在一个真实窗口里保持接近零，才谈得上打开；打开还需要三件事：记住每个运行的跳过（否则门控每次 pump 重问，两遍界限在第三次强制复查）、证据键不再把被跳过的完成算作新证据（`projectRhythmEvidenceKey` 现在散列每个完成的 job，节奏通道会一直开着）、用这些标签回答“是否保留两遍界限”。阈值与标注探针见 `docs/research/jev-work-completion-probe-20261005.md`。

## 10. 可靠性不变量

| 不变量 | 违反时处理 |
|---|---|
| 每次主动动作能追溯到项目证据/关注点，Goal 可为空 | 拒绝无法归因的动作，保留诊断 |
| 承诺先持久化，完成有证据与送达状态 | 未完成保持 open/blocked，不因答复一句话标完成 |
| 一条发现按接收者/项目/语义版本只通知一次 | outbox 幂等；发送失败可重试但不伪造已读 |
| 用户修正/权限撤销优先于旧决定 | 旧动作准入被拒，活动调用按取消能力核对 |
| 项目之间事件、证据、候选和发布指针隔离 | scope 校验失败即拒绝，不能使用全局默认项目补齐 |
| 候选只能在隔离区变化，评测与发布者独立 | 拒绝越权，候选失效，保留原因 |
| 停止一次工作不会悄悄关闭项目主动性 | 显示实际控制范围；恢复仍需政策与预算准入 |
| 模拟决策/工具/评测明确标识 | 数据级 simulated 字段 + UI 提示，不仅写在 README |

## 11. 验收场景

1. 新项目未建 Goal、用户未下发新命令，已有项目事件使模型选择调查并主动提供有用发现。
2. 同样事件已经处理、没有新证据时选择 wait，不重复运行或消息；沉默决策可在检查视图验证。
3. 后台调查期间用户自然提问，Responder 能回复；steer 改变后续动作，follow-up 保持排队，两者有不同回执。
4. 项目变更使既有假设无效，迟到结果不得覆盖新状态；拒绝的建议不会换话术再次发出。
5. 不点击进化按钮即可由项目证据产生候选，自动经过隔离评测；失败候选存档、不通知“升级成功”。
6. 更优候选在相关对话提醒一次，可看基线、样本量、质量/成本与局限；忽略提醒不改变 activeVersion。
7. 试用新版本只影响选定范围的新 Run，旧 Run 保持原 manifest；回退恢复后续路由并解释已发生副作用。
8. 两个项目同时开放，不串消息、草稿、记忆、版本与预算；跨窗口重启后可恢复承诺和未送达通知。
9. 暂停某 run、暂停进化、静音通知、暂停项目和全局急停分别验证；不以同一个按钮冒充全部语义。
10. 无模型时原型能验证上述事件/状态/交互分支，但始终报告模拟决策，不能把固定脚本验收写成模型自主能力已验证。

## 12. 实施顺序与当前边界

当前交互原型的价值是把项目、会话、事件、后台并行、打断、候选状态、提醒与试用投影做成可交互的闭环。它不证明真实 LLM 能稳定判断何时行动，不证明工具已修好项目，也不证明自进化有效；这些需要接入 Pi、真实证据和独立评测后验证。

开发优先级调整为：①Project/Session 域与事件账本；②Responder 与 Initiative 的真实 Pi session、非线性事件决策和可打断动作；③项目意识与消息归属/沉默策略；④Evolution 自动产候选及独立评测；⑤对话内试用/回退与版本观察。Skills/MCP/cache/权限仍是这些能力的底座，不能只实现后台 job 队列后把主动性留到后续。

MVP 可以限制同时支持的项目数、进化对象（先 skill/workflow）与评测任务族，不能删掉“无 Goal 也会自主判断”和“可在对话中被打断”这两个产品定义。更复杂的架构搜索、模型权重训练、跨项目自动传播另行研究。性能与成本目标仍需真实测试，不能复用旧演示中预设的成功率或运行次数。
