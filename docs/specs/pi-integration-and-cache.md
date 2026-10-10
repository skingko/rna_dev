# Pi 缓存研究与旧集成方案

> 此文的 Pi SDK 接入路线已于 2026-09-24 被 [独立 Rna SDK](../rna-sdk.md) 替代。保留本文用于理解上游缓存设计和待验证目标；不代表当前运行依赖或已实现功能。

状态：设计提案，尚未实现。依据：Pi `a328aa89ad6e6dc5c5628ff896769532ed3d29df`、包版本`0.87.1`。详细证据见Pi源码审计。本文出现的`RunKernel`、`ToolGateway`、`CachePolicy`等名称属于新系统目标接口，**不是声称Pi已有同名API**。

## 1. 主路线与决策

采用“Pi执行内核 + 产品控制平面”，第一阶段以`@earendil-works/pi-coding-agent`公开SDK的`createAgentSession()`、`AgentSession`、`SessionManager`、`ModelRuntime`为唯一上游集成入口，复用实际的prompt构建、provider适配、usage、压缩与预热。产品层拥有Goal、Run、scheduler、policy、预算、记忆检索、技能版本、MCP桥接、评估、CLI/桌面协议。禁止把修改Pi内部实现作为默认扩展方式。

| 决策 | 采用方式 | 原因/退出条件 |
|---|---|---|
| 模型调用 | 同版本`@earendil-works/pi-ai`，经Pi ModelRuntime | 保持缓存/兼容行为，不手写第二套provider payload |
| 主执行session | `@earendil-works/pi-coding-agent` SDK | 已接通CacheWarmer与structured prompt；Phase0验证非TUI使用与生命周期 |
| 低层loop | `@earendil-works/pi-agent-core`作为上游依赖 | 不直接控制内部Agent.state，防止破坏会话同步 |
| CLI | 产品CLI连接daemon；需要富终端时复用`@earendil-works/pi-tui` | CLI与桌面是同一个run的两个观察端 |
| 桌面 | React应用 + 桌面壳 + 产品daemon IPC | DOM UI独立于Pi TUI，UI重启不终止任务 |
| Durable AgentHarness | Phase0开隔离spike，不是MVP主依赖 | 仅当恢复语义与缓存一致性gate通过才迁移 |
| `pi-durable`/Chord | 评估并保持adapter边界 | 避免与产品操作账本双权威；Chord本身不是沙箱 |
| `pi-server/client/protocol` | 参考其route/attachment/订阅思路；不作为产品稳定公共API | 当前experimental、无认证、无兼容保证 |
| 上游fork | 默认0改动；必要补丁集中在adapter patch目录，记录可删除条件 | 阻止深fork长期失去provider修复与缓存优化 |

注意：`CacheWarmer`类不属于coding-agent根入口公开的值导出；根入口只导出其状态/决策类型，实际由SDK创建。新系统不能用未公开deep import冒充稳定集成。策略优先通过公开settings、session状态与extension事件控制；确有必要时向上游提交最小扩展点，或在产品adapter中明确维护小补丁。

## 2. Phase0必须验证的集成问题

Phase0目标是用一组真实源码与端到端原型证明主路线可行，而非开始重构上游。建议持续2周，由内核负责人主导，测试/桌面负责人各参与必要切片。

| 实验 | 交付物 | 接受条件 |
|---|---|---|
| SDK嵌入 | 无TUI worker，读文件→写文件→验证输出完整链路 | 不触发交互阻塞；events、tool result、usage完整 |
| 缓存等价 | 原Pi与adapter最终payload对照报告 | 未声明改变的字段结构一致；亲和键稳定 |
| 扩展policy | shell/MCP gateway验证、取消、审批等待 | 所有实际副作用经过最终gateway；无隐式builtin旁路 |
| 生命周期 | worker kill/resume、UI断线/重连 | 会话可重建；副作用不确定时进入reconcile，不盲重放 |
| 双UI | CLI和桌面同时观察一个任务 | event序号一致；其中一端退出不结束任务 |
| 资源快照 | skills/tools/resource loader定版 | 相同快照生成相同系统前缀；热更新不污染运行中任务 |
| AgentHarness候选 | 单独小实验对比缓存、tools recovery、watch | 得出继续SDK或迁移的ADR；不要求一定迁移 |
| 分发可用性 | 依赖锁定、Node/桌面sidecar打包检查 | 所选npm版本与源码差异有记录；平台资源可解析 |

本报告读取的是git提交而非已发布tarball；实现时需核对registry可用包版本与tarball是否包含当前提交功能。若0.87.1发布物滞后，使用该SHA内部构建的明确版本包，而不是假设同版本号代表同代码。初次构建遵循仓库AGENTS规则并单独审查依赖/lifecycle scripts。

## 3. 推荐模块边界

```text
apps/cli ─────┐
apps/desktop ┼── Product API / Event stream ── daemon
apps/web* ────┘                                  │
                         ┌──────────────────────┼───────────────────┐
                     RunService             Scheduler           ApprovalInbox
                         │                      │                   │
                     RunLedger <──────── Policy + Budget ──────────┘
                         │
                     PiKernelAdapter ── Worker per active session
                         │                   │
                    AgentSession         ToolGateway
                         │              ┌────┼──────┐
                   ModelRuntime        shell MCP browser
                         │              │    │      │
                    pi-ai adapters     sandbox / connector isolation
```

`apps/web`为可选远程产品形态，不在本地MVP自动开放。所有UI只操作产品API，不能读取模型密钥或调用Pi内部对象。worker归daemon所有；窗口生命周期与run生命周期解耦。一个Pi session同一时刻只有一个owner worker；多agent并发是多个session/worker，不能让多个进程写同一个JSONL。

建议新系统仓库模块：`packages/contracts`、`packages/pi-adapter`、`packages/run-service`、`packages/tool-gateway`、`packages/mcp-bridge`、`packages/context-compiler`、`packages/memory-adapter`、`packages/evolution`、`packages/evals`、`packages/ui-components`。Pi仓库继续作为只读引用/上游依赖来源，不把产品代码散入其packages。

## 4. 产品目标接口与Pi映射

下面是概念性TypeScript接口，不是已经可编译的实现；方法名和数据结构由产品定义。具体Pi调用需以固定版本公开类型为准。

```ts
interface RunSpec {
  runId: string;
  goalId: string;
  workspaceId: string;
  resourceSnapshotId: string;
  policySnapshotId: string;
  modelProfileId: string;
  input: string;
  budgetId: string;
}

interface KernelCheckpoint {
  sessionRef: string; // 产品不向UI暴露实际本地路径
  lastCommittedSeq: number;
  piEntryId: string | null;
  transcriptDigest: string;
  pendingEffectIds: string[];
}

interface RunKernel {
  open(spec: RunSpec): Promise<RunHandle>;
  attach(runId: string): Promise<RunHandle>;
}

interface RunHandle {
  submit(command: {
    commandId: string;
    text: string;
    mode: "message" | "steer";
  }): Promise<void>;
  requestPause(): Promise<void>;
  cancel(reason: string): Promise<void>;
  observe(cursor?: string): AsyncIterable<KernelEvent>;
  checkpoint(): Promise<KernelCheckpoint>;
  close(): Promise<void>; // 释放观察/控制句柄，不等于终止任务
}
```

接口名称与[控制平面规格](control-api-and-storage.md)一致；内部worker的启动、恢复和停止由adapter实现，不能把 `attach()` 理解为创建第二个Pi writer。

| 产品动作 | Pi可用原语 | 必须由产品补充 |
|---|---|---|
| 开始run | `createAgentSession()`后`session.prompt()` | admission、预算预留、worker lease、operationId |
| 用户修正 | `session.steer()`/`followUp()` | 选择两者的产品语义、commandId去重、ack |
| 停止 | `await session.abort()`；settled后dispose | 外部工具终止、不可取消结果回收、状态reconcile |
| UI观察 | `session.subscribe()` | 持久seq、snapshot、backpressure、客户端重连 |
| 恢复对话 | `SessionManager.open()`后构造session | 未知副作用检测、run状态重建、外部世界核验 |
| 恢复任务 | 对话恢复后显式继续输入/调度 | 不等同恢复尚未完成的shell/MCP副作用 |
| skill/tool更新 | resource loader/扩展与active tools | 快照锁定、schema hash、灰度与回滚 |
| 缓存状态 | session公开cache warming状态、usage与事件 | 全任务账单、预热预算、冷失效解释 |

实施伪代码只展示调用关系：

```ts
// 产品拥有的worker启动步骤；不是上游可直接复制的完整代码。
async function launchWorker(spec: RunSpec) {
  const lease = await runLedger.acquireExclusiveLease(spec.runId);
  const resources = await resourceStore.openImmutable(spec.resourceSnapshotId);
  const manager = await piSessionStore.openOrCreate(spec.runId);
  const tools = toolGateway.asPiToolDefinitions(resources.toolManifest);
  const { session } = await createAgentSession({
    cwd: workspaceStore.path(spec.workspaceId),
    agentDir: productOwnedAgentDir,
    modelRuntime: configuredPiModelRuntime,
    sessionManager: manager,
    resourceLoader: resources.piResourceLoader,
    settingsManager: productOwnedPiSettings,
    noTools: "builtin",
    tools: resources.activeToolNames,
    customTools: tools,
  });
  // 禁止自动载入未审查的项目extension；由resourceLoader显式控制。
  // subscribe是同步void listener；这里只做不抛异常的拷贝/入队，不当作commit barrier。
  const unsubscribe = session.subscribe(event => eventBridge.enqueueCopy(spec.runId, event));
  try {
    await runLedger.markAdmitted(spec.runId, lease.epoch);
    await session.prompt(spec.input);
    await eventBridge.flush(spec.runId);
    await reconcileAndVerifyOutcome(spec, session);
  } finally {
    // 真正实现需要区分“任务继续驻留”和“worker退出”，不能每个UI断线都执行。
    unsubscribe();
    await session.abort();
    session.dispose();
    await lease.release();
  }
}
```

`noTools:"builtin"`与显式`tools`可同时配置；完整allowlist和自定义loader用于保证不意外启用其他extension工具。要保留Pi工具实现，需从公开tool factory创建并包到gateway，验证signal、stream updates、二进制结果和TypeBox schema不丢失，而不是直接启用未受管builtin。产品tool wrapper是最终policy边界；上游extension hook可以修改input，故wrapper内需再验证参数与权限。

## 5. 上下文与缓存不变量

固定一个run的`ContextPlan`，包含模型身份、provider能力快照、system模板版本、资源快照、初始tools序列、schema hashes、memory引用版本、compression策略与会话key。该计划是可审计数据，不包含模型秘密推理过程。

1. 已提交消息不可原地修改；只追加消息或显式创建新branch/压缩边界。
2. 初始system文本来自已定版模板与快照；动态进度/当前时间/临时memory放在尾部消息或tool result，不每轮重写首部。
3. tool schema、description、顺序必须可复现。初始manifest按稳定规则定序；后续保持既有顺序，只按持久化新增序列追加。
4. 同一逻辑会话使用稳定cache affinity；不要使用每轮request UUID作为sessionId。
5. requestId、runId、sessionId、tool invocationId各自分工，不能用同一个随机ID替代所有语义。
6. provider能力由固定模型元数据+验证结果决定；不能为了命中率盲目打开native tool changes flags。
7. 重新生成prompt的hook必须纯函数或明确记录输入版本；随机字段/时间字段不进入可缓存前缀。
8. 未知provider usage不按0成本处理；预算保留未知费用或保守估算。
9. 技能晋升、工具重定义与模型切换创建可见的cache epoch变化；UI解释可能的冷启动成本。
10. 附件预处理结果稳定、带hash并可复用；不要每次用不同编码重新发送相同图片，且不能把图片本地缓存与prompt cache混为一谈。

`CachePolicy`的产品目标结构：

```ts
type CacheProfile = {
  retention: "none" | "short" | "long";
  warming: "off" | "streaming" | "idle";
  promptVersion: string;
  toolManifestVersion: string;
  cacheEpoch: string;
  providerCapabilityRevision: string;
  maxWarmSpendUsd: number;
};
```

主路线保留Pi SessionManager产生的sessionId，避免覆盖内部身份导致warming启动条件失配。产品通过自己的`cacheEpoch`做诊断与实验分组，**不默认把epoch拼进Pi sessionId**。若后续单独使用pi-ai或新Harness需要生成provider cache key，应使用固定长度、版本化、租户隔离的摘要键，而不是把很长lane/resource路径直接放入会被64字符截断的key中。

## 6. Provider策略矩阵

以下描述是当前Pi adapter行为，不是供应商SLA；运行时必须通过实际模型/endpoint确认支持情况。

| 适配器 | retention/affinity | 动态工具策略 | 产品处理 |
|---|---|---|---|
| Anthropic Messages | short=ephemeral 5 分钟，四个断点：工具、system、上次尾部、本次尾部（扁平摘要请求不写缓存） | 系统和工具在会话内钉住，系统提示的修改以对话中系统消息追加，工具集变化是思考重建点 | 只追加历史（0.66）：`drop_block` 加思考截止点，settle/fold/forget/压缩只在截止点前生效并随 `thinking_rebase` 提交；空闲时由回来间隔决定 `max_tokens:0` 保温；budget 思考不保温 |
| OpenAI Responses | key由session提供；long为24h或支持显式模式时30m | capability支持additional_tools/tool_search时可增量；删除/重定义fallback | 测试实际payload；warming不能假设恰好1 token成本 |
| OpenAI Completions兼容 | key/retention/cache_control依据compat与endpoint选择 | 不支持增量时全量当前工具 | 不按“OpenAI兼容”推断有同等缓存；按endpoint验收 |
| Bedrock Converse | 采用provider cachePoint与能力判定 | 单独验证上下文和工具支持 | 不与Anthropic直连共享缓存假设 |
| Google/Vertex | usage可能报告cachedContentTokenCount | 需看具体adapter/模型 | 没有显式缓存对象管理就不承诺手动缓存生命周期 |
| faux | 进程Map模拟前缀 | 可复现fixture | 仅用于契约回归，不用于成本结论 |

原Pi对适配器参数有专门测试，产品保留这些行为并增加自己的捕获fixture。对自定义endpoint，支持程度设为`verified/declared/unknown`，而不是一个无来源的boolean；provider不报告cacheWrite时“0”可能只是未报告，UI标注其含义。

## 7. CacheWarmer控制与预算

Phase0默认`off`，先验证实际provider准入与费用预留覆盖全部预热请求；验证通过后产品默认`streaming`，允许用户关闭；`idle`是显式偏好并有独立预算。沿用Pi的TTL窗口、收益门槛与不安全重放排除，先测后调。关闭阶段的缓存基准须将原Pi对照也配置同样的warming模式，另报保留上游默认设置的结果。禁止主动性scheduler通过不停无意义发消息维持缓存。

上游决策可写成：`estimatedSavings = p × (coldPromptCost − cachedPromptCost) − refreshCost`。源码中的`missCost`字段已经表示括号内的差价，`warmCost`表示refreshCost；实现产品日志时不能再减一次cachedPromptCost。当前idle概率0.15、streaming为1、门槛$0.05。产品观察`cache_warming_decision`时可停止超过预算的warm；独立请求的实际费用从`cache_warm` usage汇总。

预算分层：用户日预算、Goal预算、Run预算、每模型请求上限、warming子预算。每个允许的provider请求先预留合理上界，usage到达后结算；取消、断网或失败无usage时保留`unreconciled`费用，而不是立即全额释放。warming进入紧张预算状态直接停止；主任务优先于预热。`before_provider_request`/warm决策与usage之间的关联是Phase0验证项，当前API未提供通用产品requestId，不应承诺无补丁即可完整对账。必要时通过受控ModelRuntime/传输代理观察请求，避免改provider序列化。

warm决策hook是策略层，不是最终费用准入；extension override不允许越过产品预算。payload hook通常只在构造逻辑请求时运行一次，transport内部重试不一定再次经过它；必须为有上限的所有尝试预留费用或在实际传输边界逐次准入。provider没有输出/价格/重试可信上限时，禁止无人值守模式。急停覆盖warm定时器与在途请求，不以“主对话已结束”推断后台不再消费。

评估warming净收益：

```text
净收益 = 无warming对照组的任务总费用 − 有warming组的任务总费用
任务总费用 = 正常请求 + cache写/读 + warming + 摘要 + 重试 + 子agent + 工具收费
```

纯命中比例不能衡量价值：预热产生大量cacheRead会人为拉高命中比例。对话请求命中率和所有请求命中率应分开展示；raw分项用于审计。未报告cacheWrite的provider使用可观测分母，并明确标注不完整，不伪造统一精确比例。

## 8. MCP接入与缓存兼容

MCP bridge归产品管理，支持stdio和HTTP类远程传输的协议版本由实现时锁定的官方SDK/协议确定。Pi没有现成完整MCP client可直接打开配置即用，因此这是独立开发范围。

工具身份采用`serverId + toolName + schemaVersion`，模型可见name需要稳定、合法且冲突可消解；descriptor记录原始schema hash、能力、数据访问范围、读写属性和幂等性。启动时完成discovery并生成manifest；处理中途`tools/list_changed`只生成候选manifest，不在所有run中即时改列表。对支持增量的provider可在turn边界追加；其他情况延迟到新run或使用固定dispatcher工具，二者效果经eval比较。

MCP资源作为带URI、版本/hash、来源的内容；不是系统指令。MCP prompts作为用户显式选择或受治理模板；skills和server提示都不能授予比原run更大的权限。凭证驻留daemon/gateway侧，renderer和模型上下文仅得引用/脱敏错误。

工具执行路径：`Pi → ToolGateway → final args validation → policy/budget → effect intent → MCP call → result artifact + ledger → Pi tool result`。对大结果将原文存artifact，返回有出处的有界摘要/分页引用；摘要不能隐去对任务判定重要的失败标志。取消映射到AbortSignal及协议支持的cancel，取消请求不代表远程副作用已撤销。

## 9. 持久化与副作用边界

| 权威来源 | 保存内容 | 不负责什么 |
|---|---|---|
| 产品RunLedger | Goal/Run状态、commandId、lease epoch、effect状态、预算、审批、artifact refs | 不重写Pi历史语义 |
| Pi SessionManager | transcript、branch、compaction、模型变化、usage | 不保证外部MCP/shell exactly-once |
| Artifact store | 文件内容快照、工具完整输出、评测报告、hash | 不当作任务状态机 |
| Memory层 | 可检索经验、事实及来源 | 不作为Run事务账本 |
| Skill registry | 不可变版本、签名/hash、eval结果与active指针 | 不修改已锁定run的技能正文 |

产品run状态建议为`queued → admitted → running → waiting_approval/waiting_external → verifying → succeeded`；停止和异常有`cancel_requested/cancelled/failed/recovery_required`。UI的“agent_end”只意味着Pi本轮结束，不直接把Goal标成完成；必须经过artifact/verifier验收。

外部副作用使用`planned → intent_committed → in_flight → outcome_committed`；崩溃时停在in_flight进入`unknown`。恢复规则：

- 纯读取可以重试；结果绑定内容版本，以免“重试成功”却读到不同对象而误当旧结果。
- 具备幂等键的API携带稳定effectId，并通过查询结果对账后安全重试。
- 文件变更保存目标hash/前置hash，用临时文件+原子rename；恢复先检查实际文件状态。
- 无幂等性的外部写入先查询/人工处理，不自动重放。
- shell默认不是可安全重放工具；须显式声明且通过限制环境证明后才提高自动化等级。

Pi JSONL与产品SQLite之间没有共同事务。采用“先intent后执行、观察结果后commit、启动时reconcile”的恢复协议；checkpoint记录Pi entryId/file digest，不把仅UI已看到的流token视为持久完成。若需要严格断电耐久性，应在产品存储使用适合目标的同步策略并测试；不能仅依赖上游默认WAL/NORMAL就承诺零数据丢失。

当前`AgentSession.subscribe`是同步void回调，公开`message_end`先于对应`appendMessage`执行；与低层Agent可await的订阅不同。事件bridge只能快速拷贝入队，不能依赖返回Promise阻止Pi继续运行，也不能抛异常破坏Pi持久化。产品在run开始前先提交输入/intent，结束或checkpoint时显式flush自己的事件队列并核对Pi entry；首次assistant前Pi还可能未将初始会话写到磁盘。恢复时从产品已提交输入及Pi可验证记录补齐projection，不能把缺失尾部直接当任务不存在。对需要严格持久副作用准入的操作，使用可await的gateway执行边界，不能仅依靠旁观的UI事件。

进程锁和lease epoch解决双writer：持有lease的worker才可发新副作用；接管时等待/终止旧worker并确认本地进程状态。对远程worker还需实际fencing到副作用服务，单纯数据库lease过期不能保证失联旧worker不会继续写。

## 10. CLI与桌面共享协议

产品API定义`RunCommand{commandId, runId, expectedRevision, type, payload}`、`RunEvent{runId, seq, schemaVersion, timestamp, payload}`与`RunSnapshot{revision,lastSeq,...}`。这是产品协议，与Pi内部event格式隔离；字段对外稳定，adapter负责翻译。

命令经RunService持久去重后ack；调用成功但客户端断线时用commandId查询结果，不重发新的命令。订阅按`afterSeq`补发，历史窗口外返回snapshot再追增量；背压时可以合并临时token增量，但不能丢失tool终态、审批、usage或run终态。renderer崩溃仅释放观察端，不自动abort任务。

本地socket放私有目录并做应用级握手/能力验证；如果使用localhost HTTP则限制origin、鉴权、避免任意网页调用本地工具。远程访问作为单独能力发布，具备认证、授权、加密与tenant隔离。此处是任务执行产品的接口边界，不是要求用户每步手工确认。

## 11. 自进化如何不破坏缓存与执行一致性

Pi负责执行；演化服务负责生成候选skill、工具包装器、prompt配置或workflow。候选不得直接替换生产runtime/provider代码。运行中session绑定旧`resourceSnapshotId`，评估中的候选在新隔离session执行；晋升只更新未来run默认指针。

候选记录至少包括来源task/effect引用、差异、可迁移范围、适用条件、预期收益、失效条件、训练/验证划分与回滚版本。评测同时检查成功率和缓存行为：一种skill若每轮全量检索并重写system，可能任务成功率提高但费用显著恶化，应给出Pareto权衡而不是单一分数。

知识检索采用稳定摘要/URI/hash，附于尾部工具结果；真正可重用规则才进入下一版技能目录。失败反思先写候选知识，经来源核验和重复成功证据晋升，避免把一次错误结论永久写入系统前缀。

## 12. 回归与基准设计

### 12.1 三层验证

L0契约测试：faux/payload capture，不需要真实密钥；覆盖request投影、skill/tool顺序、同名重定义、compaction、usage归一化、对话恢复、取消与双UI事件。新adapter没有主动变更时，对等Pi输入的payload应保持一致；不同requestId/trace等非语义字段单独列出。

L1故障恢复：受控shell/MCP模拟server；在intent前后、外部成功后、Pi写入前后、流中断与摘要中断等点kill进程。保证未知副作用可见、不重复执行、不把部分产物标完成。用多UI和断线重连验证重复command与seq补发。

L2真实provider基准：限额任务集，记录模型/endpoint版本、provider flags、token usage、费用、TTFT、总时长、成功证据。包含冷/热对话、长工具链、MCP动态发现、压缩、idle、fork、模型切换与多agent。相同任务随机化顺序、独立session缓存域、多次重复；报告置信区间/方差，不以一次调用得出“最强”。

### 12.2 建议fixture矩阵

| 场景 | 干预 | 核心断言 |
|---|---|---|
| 静态30轮工具链 | adapter vs原Pi | payload前缀保持；成功率与费用不回退 |
| 工具目录100/500项 | 全量/检索/增量 | 任务完成率、工具误选、成本三者比较 |
| MCP新增/删除/重定义 | native与fallback provider | 执行集合=模型可见集合；缓存冷变更可解释 |
| skill晋升 | run中/新run边界 | 老run固定版本，新run可见新版本 |
| idle预热 | off/streaming/idle | 含warm费用后的净收益，不只cache hit |
| 摘要 | 压缩阈值与不同recent保留 | 关键约束和产物可恢复；缓存变化有边界 |
| 重启恢复 | 不同持久化间隙 | 无重复高影响副作用；usage不遗漏/不重复 |
| 并行工具 | 乱序完成 | Pi transcript保留调用顺序，UI保持完成顺序可理解 |
| 长session/lane ID | 超64字符输入 | 无产品key碰撞；主路线遵守Pi实际ID |
| provider usage缺失 | error/abort/代理省略字段 | 未知费用不显示成确定0；预算可收敛 |

### 12.3 发布gate

以下是初始拟议gate，Phase0用基线校准后冻结，并非本次测得结果：L0/L1关键不变量必须100%通过；未授权副作用、重复不可逆操作与错租户数据为零容忍；adapter未改任务策略时成功率无统计上显著回退；缓存费用回退超预算容忍度时阻止升级并解释差异；明显的冷缓存、新模型价格或新skill内容变更单独归因，不能被全局平均掩盖。

不要把“cacheRead越高越好”设为单一gate。建议保留：对话cache read比例、每成功任务总费用、p50/p95 TTFT、总耗时、warm净收益、压缩前后重建成本、unknown usage比例与真实验收成功率。

## 13. 升级、迁移与回滚

锁定产品直接依赖的Pi packages为精确版本，并提交lockfile；不能仅依赖上游workspace中的caret范围。每次升级生成记录：旧/新SHA、npm包完整性hash、许可变更、provider参数diff、model catalog diff、public exports diff、session格式与实验接口变更。

升级步骤：创建独立adapter分支 → 运行L0/L1 → 受限L2 → 测试拷贝session导入/恢复 → 小比例新run → 观察费用/错误 → 扩大。正在运行的worker使用旧adapter直至安全checkpoint，不在工具调用中替换二进制/模型配置。回滚优先让新run使用旧版；会话数据迁移必须可复制转换，保留原文件并标记格式版本，不能在唯一副本上做不可逆升级。

如果转向新AgentHarness，先实现第二个adapter以跑相同RunKernel契约；迁移器把旧会话映射到新session，并验证工具结果、branch、compaction、usage、skills来源和模型状态。不得假设老JSONL与新session存储可直接互换。必须补足CacheWarmer、结构化prompt差分、tool增量和UI事件语义差距，达到cache parity后再切主路线。

采用Chord或实验Pi server同样在adapter内部进行，不改变产品API；实验版本升级失败可以退回产品已有IPC。上游未解决的阻塞点优先提出小PR；临时补丁必须有owner、测试、上游issue/PR引用和删除条件。

## 14. 尚待实测的明确问题

- 当前git提交与registry 0.87.1发布物的功能是否完全一致。
- SDK嵌入时用户/项目extension资源发现、信任与UI回调如何被产品loader完全限定。
- warm decision、实际provider request、usage关联能否仅用公开hook实现精确预算预留/结算。
- 对目标provider，streaming预热是否有正净收益；Responses最小输出限制和reasoning成本的实际影响。
- 新Harness是否值得在第一版之后替换SDK路径；替换后的prompt/cache行为差异。
- 目标操作系统的工具沙箱、进程取消、文件同步和桌面sidecar分发性能。

这些问题属于Phase0可执行验证范围；设计保留退路，不把尚未验证的上游能力写成已交付产品功能。
