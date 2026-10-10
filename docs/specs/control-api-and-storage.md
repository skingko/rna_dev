# 控制平面、接口与存储规格

这是正式产品的目标接口，领域主轴为Project上的持续主动协作。项目意识、三lane与沉默/沟通规则见 [项目主动系统](project-proactive-system.md)，项目候选、试用和回滚见 [进化规格](evolution-and-evaluation.md)。交互原型使用较小的 `/api/*` 演示接口，见第10节与 [原型README](../../prototypes/control-center/README.md)；不能用原型测试结果证明以下恢复、认证或预算语义已经实现。

## 1. 领域对象

| 对象 | 关键字段 | 规则 |
|---|---|---|
| Project | id, name, workspaceIds, awarenessVersion, initiativePolicy, evolutionPolicy, activeReleaseHash, trialReleaseHash? | 持久协作主体；Goal为空仍可理解项目、主动行动或沟通 |
| Observation | id, projectId, sourceId, occurredAt, resourceVersions, evidenceIds | 来源事件去重，事实与模型推断分开 |
| Concern | id, projectId, hypothesis, evidenceIds, priority, state, reconsiderOn | 模型自主提出/更新的关注点；用户修正可使其失效 |
| Commitment | id, projectId, sessionId, replyTo, promise, status, evidenceIds, deliveryId? | 承诺先持久化再发言；完成须有证据与送达状态 |
| Decision | id, projectId, lane, snapshotVersion, choice, reasonSummary, evidenceIds, goalId? | act/share/reflect/learn/recall/wait；简短可审查理由，不公开内部推理全文 |
| Workspace | id, projectId, canonicalRoot, principalId, policyVersion | 真实路径规范化；符号链接不允许绕过目录约束 |
| Session | id, projectId, workspaceId, title, activeTurnId, settingsVersion, version | 持续对话的身份；一次轮次完成或停止不结束会话 |
| Turn | id, sessionId, runId?, triggerId, state, manifestHash, startedAt, endedAt | 从输入或受权唤醒开始的一轮执行；固定本轮能力与模式快照 |
| ConversationItem | id, projectId, sessionId, turnId?, origin, replyTo?, decisionId?, kind, contentRef, sourceEventIds, version | 前台与主动助手消息的统一投影；主动消息可以没有用户Turn |
| InputEnvelope | id, projectId, sessionId, targetRunId?, commandId, delivery, state, payloadRef, acceptedSeq, consumedSeq? | 区分已持久接收、排队与已被执行器消费；取回不删除审计记录 |
| Goal | id, projectId, text, acceptance, scope, autonomy, expiresAt | 可选的明确目标，不是自主能力启动条件；修订不增加权限 |
| Run | id, projectId, decisionId?, goalId?, lane, sessionId?, turnId?, state, version, manifestHash | 创建时固定项目能力版本；背景Run不必占用户Turn |
| Step | id, runId, attempt, inputHash, status | 重试新增attempt，不覆盖旧证据 |
| ToolIntent | id, operationId, toolVersion, argsHash, resourceRevision, idempotency | 执行前持久化；检查文件/API前置版本，外部结果可为unknown |
| Lease | runId, owner, fence, expiresAt | broker校验最新fence，拒绝旧worker |
| BudgetAccount | id, parentId, limit, reserved, settled, currency | 使用整数微货币单位；不足不发起 |
| Approval | id, policyVersion, argsHash, scope, expiresAt, decision | 批准只对具体内容/范围有效 |
| Event | id, seq, aggregateId, aggregateVersion, type, time, causationId, payload | schema版本化；seq为存储流位置，aggregateVersion用于对象版本 |
| Artifact | id, sha256, mediaType, byteSize, storageRef, scope | 路径不直接当公开下载地址 |
| Candidate | id, projectId, releaseSurface, parentHash, contentHash, state, campaignId | 冻结后不可修改，修改生成新版本 |
| Release | hash, projectId, releaseSurface, capabilityVersions, evaluatorReportId, parentHash | 不可变项目manifest；active/trial独立指针，活动Run不热换 |
| Notification | id, projectId, recipient, sessionId, noveltyKey, evidenceRevision, versionHash?, state | 内容归属和送达幂等；通知不等于试用/安装 |

### 1.1 持续会话、轮次与自主运行

`Project → Session → Turn` 是交流层级，`Project → Observation/Concern → Decision → Run/Message/Wait` 是主动控制层级。项目在会话结束后仍保留事实、关注点、承诺和版本。Session承载持续对话、计划、队列和产物；Run是受预算、权限及恢复约束的执行单元，Goal只是可选的跨轮意图和验收。无需先创建Goal，项目事件也能触发模型选择调查、学习、主动交流或沉默。

Responder、Initiative、Evolution使用可独立调度的执行通道与Pi session owner，共享授权的项目事实。前台输入不等待背景Run结束；控制事件带targetRunId，过时决策在动作/消息准入前重新校验。统一消息发布器记录origin、replyTo和证据，后台发言不伪造user消息，也不重复回答同一触发。

会话中的工具卡属于 `ConversationItem` 投影，参数、输出和当前状态来自工具意图与结算事件；产物卡仅引用已提交的 `Artifact`。用户看到简明对话，展开后应能核对同一份执行证据。完整轨迹、可供模型读取的当前上下文、长期记忆是不同数据层；压缩上下文不能删除原始会话历史或伪造新的工具结果。

默认模式、模型和能力选择保存在会话设置中，启动新轮时形成不可变快照；运行中变更显示其生效边界，不能默默改写已发请求。停止当前轮后仍能继续同一会话；暂停项目主动性、暂停进化、静音提醒、取消Goal、删除会话历史和释放句柄分别建模。

## 2. RunKernel适配层

```ts
// 产品建议接口，不是Pi包的API声明
interface RunKernel {
  open(spec: RunSpec): Promise<RunHandle>;
  attach(runId: string): Promise<RunHandle>;
}
interface RunHandle {
  submit(command: { commandId: string; text: string; mode: 'message' | 'steer' | 'followup'; projectVersion?: number; targetRunId?: string }): Promise<void>;
  requestPause(): Promise<void>;
  cancel(reason: string): Promise<void>;
  observe(cursor?: string): AsyncIterable<KernelEvent>;
  checkpoint(): Promise<{
    sessionRef: string;
    lastCommittedSeq: number; // 产品事件库已提交边界
    piEntryId: string | null;
    transcriptDigest: string;
    pendingEffectIds: string[];
  }>;
  close(): Promise<void>; // 释放句柄；不等价于删除任务
}
```

将Pi事件映射为产品事件，但保留原始Pi会话引用。`checkpoint()`只能报告已经持久化的边界；不能通过“serialize当前内存”伪造供应商尚未完成请求的可恢复性。Pi内部取消语义、预热、压缩钩子按固定版本适配并测试。

当前 `AgentSession.subscribe` 是同步void回调，不等待listener返回的Promise；公开 `message_end` 先于对应 `appendMessage`。bridge须不抛异常地拷贝/入队，另行flush产品事件，并核对Pi记录后才能发布checkpoint。对副作用的持久准入使用可await的tool broker，不依赖事件旁观；初始输入也先进入产品账本，以覆盖首次assistant前Pi延迟flush的窗口。

## 3. 命令API

正式公共API用 `/v1`；客户端握手读serverVersion、schemaVersion、capabilities和最大payload。所有写命令有 `commandId`，去重键为principal+commandId；同id不同body返回409。服务端先校验权限和expectedVersion，再原子写入命令结果与状态事件。

| Method / Path | 内容 | 结果 |
|---|---|---|
| POST /v1/projects | name、workspaceIds、主动/进化/提醒政策、预算、commandId | projectId、version；不要求Goal |
| GET /v1/projects/:id | 项目事实摘要、关注项、承诺与版本指针 | 授权投影、version、cursor |
| POST /v1/projects/:id/observations | sourceEventId、kind、证据、资源版本 | accepted/duplicate；异步自主判断，不保证每次行动 |
| POST /v1/projects/:id/commands | update-focus/pause-initiative/resume-initiative/pause-evolution/mute-notifications、expectedVersion | 准入结果、作用范围、失效决策 |
| POST /v1/projects/:id/presence | sessionId、typing/visible、短期TTL | 瞬时注意力提示；不是用户授权 |
| GET /v1/projects/:id/decisions | 分页、证据引用、choice、reasonSummary | 包括wait和superseded，不输出私有推理全文 |
| GET /v1/projects/:id/versions | 候选、报告、active/trial指针 | 项目版本投影 |
| POST /v1/projects/:id/versions/:hash/commands | trial/adopt/rollback、scope、expectedVersion、commandId | 门禁、生效边界；只影响对应项目后续Run |
| POST /v1/projects/:id/notifications/:id/disposition | read/later/dismiss、commandId | 通知偏好，不隐式安装版本 |
| POST /v1/sessions | projectId、workspaceId、title、初始设置、commandId | sessionId、version；不自动开始模型请求 |
| GET /v1/sessions?project=&workspace=&cursor= | 分页、项目/工作区与归档筛选 | 会话列表投影 |
| GET /v1/sessions/:id | 会话、轮次、输入队列与产物引用 | version、cursor；大轨迹和产物分页读取 |
| POST /v1/sessions/:id/inputs | commandId、expectedVersion、delivery、文本与已上传附件引用 | accepted/duplicate、inputId、queued；不等同于已消费 |
| POST /v1/sessions/:id/commands | pause/resume/stop-turn/compact/update-settings、expectedVersion | accepted/duplicate/rejected、生效边界 |
| POST /v1/sessions/:id/inputs/:inputId/withdraw | commandId、expectedVersion | 取回未消费消息；已消费返回冲突及消费边界 |
| POST /v1/goals | projectId、可选明确目标、验收、scope、子预算 | goalId、version |
| POST /v1/runs | projectId、decisionId?、goalId?、lane、输入、manifest、commandId | 202 + runId，不等待LLM |
| GET /v1/runs?state=&workspace= | 分页、游标 | 状态投影 |
| GET /v1/runs/:id | 任务快照 | version、cursor、sessionRef |
| POST /v1/runs/:id/commands | pause/resume/cancel/steer、expectedVersion | accepted/duplicate/rejected |
| GET /v1/events?after=&workspace= | SSE，按授权范围过滤 | durable序号；心跳与流增量另标 |
| GET /v1/runs/:id/artifacts | 授权产物列表 | 摘要、hash、可用操作 |
| POST /v1/approvals/:id/decision | allow/deny、contentHash | 审批事件及有效范围 |
| POST /v1/budgets/:id/limit | 新limit、expectedVersion | 不可低于已承诺余额而伪造退款 |
| GET /v1/capabilities | tools/skills/MCP/plugin注册表 | 安装/启用/健康状态 |
| POST /v1/capabilities/install | 来源、固定版本、digest | 异步安装job；默认不执行生命周期脚本 |
| POST /v1/campaigns | projectId、triggerDecisionId、能力假设、冻结契约 | campaignId；通常由Evolution自主创建，人工调用非前提 |
| POST /v1/candidates/:id/evaluate | dataVersion、预算 | evalJobId |
| POST /v1/releases/promote | projectId、candidateHash、evalReportHash、采用政策 | gate结果、releaseHash；评测完成/通知不能单独授权晋级 |
| POST /v1/releases/rollback | projectId、releaseHash、reason | 回退事件 |
| POST /v1/emergency-stop | scope、reason | 控制面立即冻结；逐worker状态 |
| GET /v1/health | daemon / provider / context / worker | 不返回密钥 |

错误包含 `code, message, retryable, requestId, details`；401/403区分认证与授权，409冲突，422无效schema，429配额/限流，503依赖不可用。审批不足用业务状态而不是循环重试403。

`campaigns/evaluate/promote`是控制能力，不要求用户逐个调用；Evolution依项目证据自主驱动候选和评测。生产版本切换单独遵守项目采用政策，通知端点没有安装副作用。上述新增 `/v1/projects` 均为目标接口，不能当成原型已有路由。

### 3.1 消息投递与中断

正式产品保留 `send / steer / followup` 三种用户意图，并在输入账本明确记录接收和消费边界：

| 场景 | 行为 |
|---|---|
| 空闲会话接收输入 | 持久化 `InputEnvelope` 后启动下一轮；没有活动轮时 steer/followup 按普通输入处理 |
| 后台Run进行时普通交流 | Responder可独立及时回应；与后台动作相关的修正生成目标明确的控制事件，不先取消所有背景工作 |
| 活动轮中 `steer` | 排入指定targetRunId/当前轮的引导队列，在执行器可安全接收的模型/工具边界消费；不假装撤销已经产生的副作用 |
| 活动轮中 `followup` | 保持待发，当前轮明确结束后才创建新轮；不能注入当前模型请求 |
| 活动轮中普通 `send` | 客户端明确显示默认投递策略，服务端返回实际采用的 delivery；当前原型默认 steer |
| 暂停时提交 | 保存输入但不隐式恢复当前轮；急停解除也不自行消费队列 |
| 撤回与消费竞争 | 在同一事务比较输入状态，仅一方成功；已消费内容可以通过新消息修正，不能改写旧输入 |
| `stop-turn` | 结束本轮的继续推进，保留已发生的消息与副作用证据；未消费消息变为可取回草稿，停止事件与恢复内容持久化 |

UI 在输入区上方展示未消费队列，可区分本轮引导与下一轮补充。停止、撤回和重新发送不能丢失附件/技能引用，也不能因请求重试产生重复输入。正式协议的恢复内容需支持幂等查询，不能仅在第一次 HTTP 响应里返回。`accepted` 只表示服务端已保存；真正的消费要有 `input.consumed` 事件及对应 `turnId`，worker 崩溃时需核对 Pi 记录后再决定是否重投。

## 4. 事件协议与重连

```json
{
  "schemaVersion": 1,
  "id": "evt_01...",
  "seq": 1042,
  "projectId": "prj_01...",
  "workspaceId": "ws_01...",
  "aggregateId": "run_01...",
  "aggregateVersion": 12,
  "type": "run.waiting_approval",
  "at": "2026-09-24T02:00:00Z",
  "causationId": "cmd_01...",
  "correlationId": "decision_01...",
  "data": { "approvalId": "apr_01..." }
}
```

durable事件：project.updated、observation.accepted、concern.updated、commitment.created/resolved、decision.selected/superseded、notification.queued/delivered/dismissed、version.eligible/trial_started/withdrawn、run.created/state_changed、message.accepted、tool.intent/started/settled/unknown、budget.reserved/settled、approval.decided、artifact.committed、candidate.frozen、release.promoted/rolled_back。transient事件：model.delta、tool.progress、worker.heartbeat；增量不是已持久完成证据。

客户端先请求快照+cursor，再订阅cursor之后事件，按事件id/seq去重。cursor是绑定订阅scope的存储流位置；授权过滤会合法跳过其他对象事件，因此不能因seq不连续就判丢包。对象更新使用aggregateVersion检测冲突；服务端发现日志截断、cursor过期或无法续传时返回 `RESYNC_REQUIRED`。断线显示“连接中断，状态可能已更新”，不把任务改为失败；已提交命令重发同commandId获取相同结果。流量背压时合并transient进度，durable事件不丢弃；必要时断开慢client并让其恢复。

## 5. SQLite与Pi会话日志的一致性

产品库与Pi日志是两个存储，不能假定共同ACID事务。采用意图日志和恢复核对：

1. 控制事务登记run、commandId、Pi session映射和启动outbox；提交后才能唤醒worker。
2. worker打开唯一Pi session，写入可追溯command标记；若支持的扩展点无法原子标记，则维护session偏移+输入hash，恢复时保守判定。
3. 对工具调用，broker先在产品库保存intent+预算预留，然后调用工具；Pi收到的结果与产品结算用operationId关联。
4. 崩溃后核对控制intent、Pi已持久工具记录和外部回执；只对 `safe` 的读取或有有效幂等key的动作重放。
5. 若输出已经落到Pi日志而控制投影未更新，重建投影；若外部写结果未知，进入待核对，不凭“未看到success事件”重做。

MVP可接受模型最后一段未settle增量丢失，不能声称每个token持久化。重要文件写入使用临时文件+fsync+rename及目录持久化策略；实验验证各OS实际语义。SQLite一致性和Pi日志耐久性分别测试；`WAL`本身不代表断电零丢失。

建议表：projects、project_snapshots、observations、evidence、concerns、commitments、decisions、notifications、sessions、turns、conversation_items、workspaces、goals、runs、commands、events、leases、tool_intents、approvals、budget_accounts、budget_reservations、inbox、outbox、artifacts、capability_versions、campaigns、candidates、evaluations、releases、project_release_pointers（active/trial）、memory_outbox。事件与必要投影在同事务更新；大产物先写内容存储，再提交引用，孤儿对象由延迟GC清理。

## 6. 调度算法

```text
accept(event):
  verify source + scope
  transaction:
    insert inbox if eventId absent
    coalesce only compatible wakes, preserving original IDs
    append event and enqueue dispatch outbox

consider(project, coalescedEvents):
  update evidence / concerns / commitments and project snapshot
  if no meaningful change or no allowed budget: persist wait, no model call
  reserve decision budget; ask DecisionAdapter(snapshot)
  validate scope, evidence, latest policy and relevant resource versions
  if stale: supersede and reconsider at next eligible boundary
  apply choice: act / share / reflect / learn / recall / wait
  persist decision + action/notification outbox atomically
  // Goal optional; wait is an acceptable outcome, not a task failure

dispatch(run):
  if paused/cancelled/expired: stop
  if no eligible trigger: sleep without LLM
  transaction:
    compare-and-swap run state
    acquire lease with new fencing token
    reserve bounded spend
  worker.drive(fence)

recover(expiredLease):
  revoke old admission at broker
  inspect tool intents and session settlements
  retry safe work / reconcile external operation / ask for missing evidence
```

watch文件事件使用去抖和内容hash；cron保存实际触发id与时区，DST或睡眠唤醒不能重复执行；webhook验证签名、时间窗和deliveryId。Responder优先于无期限的背景探索；承诺有自己的到期优先级。Initiative/Evolution分别有研究额度和可中断边界，避免单一任务饿死其他项目。选择share时还检查消息新颖性、接收会话和注意力；选择wait保存可重新判断条件，不每次tick制造空回复。

## 7. 预算和费用

账本分 `reserved`（尚未结算上限）、`settled`（已知实际），可用余额=limit−reserved−settled。所有币值用整数微美元或显式币种单位，避免浮点累积。供应商usage未返回时保留预留，按对账任务处理，不直接释放为0。

模型请求上限由输入token估计、最大输出token、价格版本与安全余量组成；没有可信价格或输出上限时禁止无人值守该provider。project为预算根，按lane分配并为Responder保留响应额度；请求、每日、run、可选goal和workspace可再设子限额；预热/失败重试/子Agent/embedding/评测都占同一总账。价格按配置快照记录，不把今天价格回算旧账。

Pi缓存预热器有独立定时请求，不能仅在 `session.prompt()` 前扣预算。Phase0默认关闭warming，验证受信provider准入边界覆盖主生成、摘要与预热后才启用streaming；warm决策hook用于提前否决，最终请求仍必须有有效预留。一次逻辑请求内的transport重试须预留全部有上限尝试的最坏费用，或逐次重新准入；仅在payload构造时调用一次hook不能宣称已逐HTTP尝试拦截。没有可验证覆盖的provider不开放无人值守预热，公开API不够时采用受控传输适配或最小上游补丁。

`cache_warm`用量单独入账；失败/取消可能已收费却没有成功usage，继续保留未知预留。预算耗尽或急停必须停止warm定时器、阻止新请求并取消在途可取消请求，而不是只停止对话。CacheWarmer估算1个输出token，但Responses适配器的输出参数最小值为16；产品预留以最终payload及模型计费上界为准，不能照抄预热收益估计作为费用上限。

进程内上限只能控制新请求及可取消的调用，已被供应商接收的费用可能继续产生。因此并发总预留+最大在途风险必须受控，供应商账户限额作为第二道限制；UI展示潜在在途费用，不能承诺按钮点击后账单绝对不再变化。

## 8. 安全与IPC

本地CLI优先Unix socket（用户权限0600）或带访问控制的Windows named pipe。Web gateway仅绑定loopback且要求会话认证；校验Host/Origin/CSRF，不接受任意跨域凭据。token通过安全引导交换，避免在URL/query、终端history或截图泄露。renderer仅调用受限API，不持有provider或MCP密钥。

插件与MCP输出视为不可信内容，参数过JSON schema和长度限制；文件工具校验规范化真实路径与挂载根；shell runner从策略决定网络和环境。操作授权绑定参数hash，参数变更必须重审；持久授权是显式scope规则，不是对一句自然语言的无限信任。

路径检查还要覆盖检查后符号链接替换等TOCTOU情况，依靠受限挂载/OS沙箱或安全句柄执行最终访问，不能只在入口调用一次realpath。工具worker不继承全部宿主环境或读取daemon凭据；产品数据根、正式能力版本及评测器与工作区写域分离。插件在子进程运行只解决生命周期隔离，只有配套文件/网络/凭据限制才形成权限隔离。

资源配额除模型费用外还包括wall time、进程数、内存、磁盘/产物字节数、工具输出和并发连接；到限停止新工作并保留已有证据。多run共享工作区时另加文件/仓库写入互斥，不能靠各自session lease防止互相覆盖；独立worktree集成采用基线commit和文件版本检查。

## 9. 迁移与备份

schema升版前导出快照，迁移带版本和校验；新格式拒绝旧client危险写入。CLI与Desktop共享产品数据，但安装包与启动版本受同一兼容性闸门管理。更新采用旁路安装→健康检查→切换启动版本；失败退回旧二进制，数据库不可逆迁移必须先备份且独立发布。

每日增量备份控制库、Pi会话、release manifest和必要产物；向量索引可重建不必全量复制。恢复演练验证引用、权限、预算预留及候选hash，而不只验证数据库能打开。导出包默认脱敏且不含凭据。

## 10. 当前项目/会话原型的映射与限制

本节描述 `prototypes/control-center` 已实现的 `/api/*` 接口，与以上 `/v1` 正式协议分开。原型使用同步 JSON 快照与 `demo-policy` 确定性模拟器，没有 Pi adapter、真实模型、工具副作用、SSE、SQLite 或执行租约。项目主轴已实现为较小的事件/状态闭环；旧Goal七阶段状态机保留兼容，不代表项目主动性设计。

### 10.1 实际状态模型

```ts
// 当前原型字段摘录，非正式服务完整协议；其他字段以本地源码为准
type Project = {
  id: string; name: string; description: string; workspace: string; focus: string;
  sessionIds: string[]; primarySessionId: string | null;
  facts: object[]; commitments: object[]; observations: object[]; decisions: object[];
  jobs: object[]; attention: object[]; opportunities: object[];
  initiative: { enabled: boolean; cooldownMs: number; minRelevance: number;
    budgetUsd: number; spentUsd: number; tokens: number; quietUntil: string | null; lastSpokeAt: string | null };
  activeVersionId: string; trialVersionId: string | null; versions: object[];
  evolution: { enabled: boolean; lastEvaluatedAt: string | null; scope: string; candidateCount: number };
  decisionMode: 'demo-policy'; simulated: true;
};
type Session = {
  id: string; projectId?: string; title: string; workspace: string;
  model: string; mode: 'build' | 'plan'; // model 仅为演示标签
  status: 'idle' | 'running' | 'paused';
  pauseReason: null | 'manual' | 'budget' | 'emergency' | 'recovery' | 'gate';
  activeTurnId: string | null;
  createdAt: string; updatedAt: string; simulated: true;
  items: Item[]; turns: Turn[]; inbox: Entry[]; artifacts: Artifact[];
  plan: { id: string; text: string; status: 'pending' | 'running' | 'completed' }[];
  context: { tokens: number; capacity: number; compactions: number };
  usage: { usd: number; tokens: number };
  submissions: { requestId: string; fingerprint: string; message: Entry }[];
  sourceTaskId?: string; // v1 旧任务迁移形成的历史快照
  goalId?: string; // 旧Goal调度演示关联；项目主动性不使用此字段作为前提
};
type Entry = {
  id: string; text: string; delivery: 'send' | 'steer' | 'followup';
  attachments: { name: string; size?: number; type?: string; path?: string; metadataOnly: true }[];
  skillIds: string[]; createdAt: string; requestId?: string;
};
type Turn = {
  id: string; status: 'running' | 'paused' | 'completed' | 'stopped';
  stage: number; mode: 'build' | 'plan'; model: string;
  createdAt: string; completedAt?: string; userItemId: string | null; steering: string[];
  projectId?: string; versionId?: string; // 项目能力快照，本轮固定
  source?: 'autonomy'; goalId?: string; autonomyStage?: Goal['stage']; trigger?: Trigger;
};
type Item = {
  id: string; turnId: string | null; kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string; createdAt: string; simulated: true;
  delivery?: Entry['delivery']; attachments?: Entry['attachments']; skillIds?: string[];
  submissionId?: string; artifactIds?: string[]; recoveredMessages?: Entry[];
  goalId?: string; source?: 'autonomy' | 'initiative'; trigger?: Trigger;
  projectId?: string; versionId?: string; decisionId?: string; evidenceIds?: string[];
  decisionMode?: 'demo-policy'; reason?: string; initiative?: object; originContext?: object;
  tool?: { name: string; args: object; status: 'running' | 'succeeded' | 'failed'; output: string };
};
type Artifact = {
  id: string; turnId: string; title: string; path: string;
  mime: 'text/markdown'; content: string; createdAt: string; simulated: true;
};
type Trigger = { kind: 'timer' | 'event'; reason: string; eventId?: string };
type Goal = {
  id: string; sessionId: string; title: string;
  status: 'scheduled' | 'running' | 'waiting' | 'paused' | 'completed' | 'cancelled';
  pauseReason: Session['pauseReason']; resumeStatus: string;
  stage: 'observe' | 'repair' | 'validate' | 'evolve' | 'evaluate' | 'promote' | 'accept';
  nextAction: string; nextWakeAt: string | null;
  lastWake: (Trigger & { at: string }) | null;
  waitingFor: { key: string; label: string; readyAt: string; receivedAt?: string; eventId?: string } | null;
  runCount: number;
  budget: { limitUsd: number; maxRuns: number; spentUsd: number; tokens: number };
  candidateId: string | null; policyVersion: string;
  evaluation: {
    baseline: number; score: number; cases: number; passed: number;
    isolated: true; isolation: 'independent-function-only'; simulated: true;
    gatePassed: boolean; evidence: string;
  } | null;
  acceptance: { label: string; passed: boolean; detail: string }[];
  history: { id: string; at: string; type: string; message: string; [key: string]: unknown }[];
  receipts: string[];
  createdAt: string; updatedAt: string; completedAt?: string; cancelledAt?: string;
  simulated: true; automatic: true;
};
```

`workspace` 是标签，不是经过权限检查的工作区根目录。附件只保存元数据；`artifact.content` 内联存储在状态文件中，`path` 不代表已写入工作区。工具卡在快照中原位更新，无法据此声称正式不可变事件流已完成。所有轮次、计划、用量和工具文本都来自模拟逻辑。

根状态包含 `projects: Project[]` 和旧 `goals: Goal[]`。项目主动助手消息可以 `turnId:null`，由projectId/decisionId/evidenceIds归属，不先建立用户Turn或Goal。旧Goal自主轮次的userItemId为null；该分支仍保留历史兼容。`evaluation.isolated:true` 是早期模拟标记，必须同时解释 `isolation:'independent-function-only'`：评测函数和生成逻辑分开，但没有进程/文件系统隔离或真实保留集，不能据此显示“已完成安全隔离”。

### 10.2 实际接口与正式目标差异

| 原型接口 | 已实现行为 | 尚不具备的正式能力 |
|---|---|---|
| `GET /api/projects` | 项目列表及完整投影；详情按ID查找 | 生产身份/授权过滤、分页、字段级投影 |
| `POST /api/projects` | `{name?,description?,workspace?,focus?,demo?,initiative?}`→`{project,session}`；demo仅注入语境事件 | 真实工作区发现、模型自主理解 |
| `PATCH /api/projects/:id` | 文本字段、initiative配置、evolution.enabled | 独立的通知静音政策、expectedVersion、通用幂等 |
| `POST /api/projects/:id/observations` | `{kind,text,eventId?,relevance?,data?}`，来源事件去重 | 真实watcher/webhook认证、模型相关性判断 |
| `POST /api/projects/:id/presence` | `{sessionId,typing,visible}`，内存短期提示 | 多客户端存在感合并、可靠已读信号 |
| `POST /api/projects/:id/versions/:versionId/control` | trial/rollback/adopt，项目指针隔离，Turn固定版本 | 真实安装器、自动灰度监测、任意历史稳定版本回退 |
| `POST /api/projects/:id/checks` | signal/revision/smoke布尔输入，使用trial或active模拟策略 | 真实测试、模型能力与独立保留集评测 |
| `GET /api/state`、`GET /api/sessions`、`GET /api/sessions/:id` | 读取完整快照；UI/CLI 共用 | 授权过滤、分页、快照游标与增量订阅 |
| `POST /api/sessions` | 可带projectId关联项目；demo:true创建静态示例 | 真实工作区检查、能力装载 |
| `PATCH /api/sessions/:id` | title/workspace/model/mode；模式与模型在下一轮生效 | expectedVersion、多客户端冲突解决、供应商验证 |
| `POST /api/sessions/:id/messages` | 输入落盘、两类队列、可选 requestId 去重；返回 `{session,queued,entry,duplicate?}` | Pi 消费核对、传输失败补偿、真实附件上传 |
| `POST /api/sessions/:id/control` | pause/resume/stop/compact；返回 `{session,recovered:Entry[]}` | 在途工具取消、供应商费用核对、真实上下文压缩 |
| `DELETE /api/sessions/:id/inbox/:messageId` | 只撤回未消费消息；返回 `{session,recovered:Entry}`，竞争失败 409 | 通用幂等取回命令和跨设备草稿同步 |
| `POST /api/autonomy/demos` | `{title?,budget?:number,maxRuns?:number}` 创建旧Goal专用调度演示会话，返回 `{goal,session}`；预算默认 0.3 模拟 USD、10 轮 | 任意自然语言目标规划、真实触发器与真实执行器 |
| `POST /api/goals/:id/control` | `{action:"pause"|"resume"|"cancel"|"advance"|"signal"|"budget",eventId?,limitUsd?,maxRuns?}`；返回 `{goal,session,duplicate?}` | 生产租约、控制幂等键、外部事件认证、分布式调度 |
| `POST /api/emergency` | 关闭项目主动能力，暂停会话、旧任务与旧Goal；解除不自动恢复 | 真实工具 broker 与 cache warming 的全链路急停 |

活动轮中 `send` 自动变为 steer；steer 在下一次可推进 tick 消费，followup 只在当前轮结束后变为新轮。暂停、急停或预算不足时不消费队列。每会话最多 50 条待发消息。最终演示结果已经展示但轮次尚未关闭时收到 steer，会更新示例产物后再结束本轮。停止保留已有条目，将运行中的模拟工具标为 failed，并把未消费队列返回调用者；同一批内容还保存在停止 notice 的 `recoveredMessages`。单条撤回也在对应 notice 中保存该条消息及附件/技能引用，操作响应丢失后可再次取回。

消息 `requestId` 在单个会话内持久去重；同 ID、同规范化输入返回已有消息，不增加 revision；同 ID 不同输入返回 409。自主目标的模拟依赖事件另以 `eventId` 在目标内持久去重；重复返回 `duplicate:true`，没有待处理依赖时的新事件返回 409。其他原型命令没有统一 commandId/expectedVersion，因此不能把上述行为扩展解释为正式命令协议或外部副作用幂等性。会话、旧任务与自主目标共用 UTC 日预算和模拟并发限制，不预留真实供应商费用。

### 10.3 项目主动事件与版本边界

项目没有Goal也可处理观察。当前确定性适配器将低相关度/普通会话选择为wait，将context选择为后台检查，将ci_failure/preference选择为候选研究，结果与恢复信息再按注意力/冷却/预算决定分享。决策与job同一tick事务推进，没有三个真正并行模型worker；不能由事件类型分支推断已具备真实模型决策。

项目主动助手消息由统一状态mutation追加；版本通知与notifiedAt一并保存，避免重启重复。普通用户聊天不要求等待背景检查，主动分享会等待用户Turn结束；Web打字presence有效期10秒，CLI未上报typing。当前quietUntil同时延后背景工作和提醒，不等同于目标规格的独立静音功能。

候选由当前active策略生成，经独立模块8个固定合成样例评测，达标标ready并形成通知观察；提醒不改activeVersionId。trial设置trialVersionId，rollback只退出该试用，adopt需先试用并明确采用。新Turn固定versionId；checks使用trial优先于active的当前模拟策略。job固定focus/baseVersionId，焦点变化时superseded，评测期间基线改变时候选stale；采用新版本也使旧ready同辈失效，不再通知/试用。排队消息的观察仅在实际消费后可处理，撤回/停止取回时标withdrawn。不存在真实安装、进程隔离、真实holdout或已采用版本的完整自动回退。

项目观察eventId相同证据不增加revision；不同证据复用ID返回409。项目主动费用进入项目和全局模拟总账；它与普通会话的模拟并发方式不代表生产lane资源仲裁。CLI命令和字段详见 [原型README](../../prototypes/control-center/README.md)。

### 10.4 旧Goal调度兼容边界

daemon 每 3 秒执行一次 tick；页面仅轮询状态。专用演示按七阶段完成七次自主运行，首轮观察后等待模拟依赖约 12 秒，事件就绪后继续。等待时不重复记账，每次自主运行**开始时**一次性登记 0.024 模拟 USD、1,240 模拟 tokens；检查目标金额/轮数及全局金额/token 限额通过后才开始。暂停和恢复同一轮不重复收费；正常七轮为 0.168 模拟 USD。这里没有供应商调用、真实预算预留或未知结果核对。

`budget` 使用 `limitUsd` / `maxRuns` 更新目标上限，不能低于已记账金额/已运行次数，只保存额度，不改变暂停状态。`advance` 只提前该目标的下次时间，不能绕过门禁；`signal` 只提供模拟依赖条件，暂停状态仍保持。`cancel` 取消目标及其当前自主轮次，保留历史和产物，后续时钟不再续行。全局急停禁止新自主运行，解除后要显式恢复。

用户向有关联目标的会话发送新消息时，先暂停目标、结束其当前自主轮次，再开始普通会话轮次；目标恢复时仍须等待该普通轮次结束。被插话终止的阶段重开属于新运行并重新计费。会话 Stop 结束当前自主轮次并暂停目标，防止下一次自动唤醒，不等同于 `cancel`。自主轮次的会话 pause/resume 会转到目标控制。

候选来自固定模拟失败，在独立函数中以 8 个合成样例比较基线与候选。通过评测门禁后仅更新 `goal.policyVersion`，不安装真实 skill；自主候选不能经通用候选管理 API 绕过门禁。末轮再次评测并检查事件消费、模拟版本启用、合成通过和预算四项，全部满足才完成。具体因果与可复验场景见自主闭环演示。

### 10.5 现有数据升级

JSON 状态版本从 1 升到 2 前，先以独占创建方式复制原文件为 `state.json.v1-backup`；已存在备份时使用唯一后缀，避免覆盖。迁移保留旧 `tasks`、配置与事件，为每个旧任务增加 `sourceTaskId` 关联的空闲会话历史快照，不把旧任务自动恢复为新会话执行。旧任务 API 继续可用，但其后续修改不反向更新历史快照。

全局 `events` 延续旧版最多 1000 条的保留策略，新增迁移或恢复事件也计入上限；迁移前完整状态可从备份核对。会话 `items` 单独保存，不因这一全局日志上限裁剪。

旧v2曾补充goals:[]；本次再补充projects:[]，缺失项目字段的文件先复制为 `.before-projects-backup`，不另行升JSON版本，旧会话和任务保留。项目证据/job可在重启后继续处理；它们是同步模拟动作，不代表可自动重放真实工具。daemon 重启将 running 会话转为 paused/recovery，并将尚未暂停的未结束目标转为 paused/recovery；原有目标暂停原因保留。轮次阶段、工具卡、待发队列、目标截止时间和模拟账本持久保存，只在显式 resume 后推进。此恢复语义仅针对模拟器的本地状态，不证明 Pi 日志、真实工具或供应商请求具备同等恢复保证。操作与验证说明见 [原型 README](../../prototypes/control-center/README.md)。
