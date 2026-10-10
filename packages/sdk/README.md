# @rna-agent/sdk

Rna Agent 自有执行内核，当前版本 `0.11.0`。使用 Node.js 标准库实现 provider、持久会话、工具调用、skills/MCP、模型项目初始化和无 Goal 的主动决策；**不导入 Pi SDK**。Pi、DeepSeek Harness 与 Headlong 是代码研究和设计来源，具体对应关系见[实现说明](../../docs/rna-sdk.md)。

0.11.0 增加显式固定重复评测、逐轮语义证据审阅及只读问题交接证明；研究评测公开必要任务约束、区分搜索匹配范围。旧调用不自动增加评测次数。见 Phase 6C 报告。

0.10.0 增加作者有依据的停止结果、实际像素/来源主张评估和持续会话多轮用例；旧调用默认仍要求候选。压缩与快照减少大历史复制，保持消息边界和缓存契约。真实检验及局限见 Phase 6B 报告。

```js
const result = await proposeProjectGenome({
  project, baseline, evidence, model, provider,
  allowAbstention: true, // 可选；不传时保持原候选返回契约
});
if (result.status === 'no_change') {
  // 这是当前证据下的复核结论，不是评估通过，也不是新的定时任务。
  console.log(result.abstention.summary, result.abstention.revisitWhen);
} else {
  // 继续使用冻结用例评估；生成成功不等于可采用。
  console.log(result.proposal.genome);
}
```

冻结用例可声明 `followUps`（最多 5 条），每条有 `input` 和可选内容/工具/产物检查。它们复用同一会话与工作区，每轮受同一执行额度约束并单独记账，不会覆盖前轮失败。初始工作区不变量每轮检查；领域来源核验与浏览器交互目前在最后一轮执行。`environment.visualReview: true` 要求可信的图像输入模型和实际浏览器适配器；不支持时在付费前明确失败。`coverage.userTurns` 和 `multiTurnCases` 是计划量，实际完成以逐轮回执为准。

0.9.0 为项目候选作者增加可选 `searchPolicy`：核对实际能力改动范围、区分完整测量与未完成反馈，并识别相同条件下已经测过的相同候选。完整技能及资源计作一个能力单元，不能当作原子语义编辑数。原有调用不传策略时保留兼容行为；筛选、一次性确认和质量门槛保持原契约。接口与实测限制见 RRSI SDK 设计。

需要 Node.js ≥22.19.0。该包暂未发布到 npm；在仓库内直接 import。包本身没有第三方运行时依赖。

```sh
cd packages/sdk
node --test test/*.test.mjs
```

可运行的无 Goal 主动协作示例见 [examples](examples/README.md)，包括模型项目初始化、后台研究、主动消息和可选评测器。

## 一个真实模型会话

以下代码从仓库根目录运行。先设置 `RNA_MODEL_BASE_URL`、`RNA_MODEL_ID`、`RNA_MODEL_API_KEY`；按已配置模型填写上下文和输出上限。代码中的默认容量仅是本例的请求预算，不是供应商规格。`RNA_MODEL_PROTOCOL` 可为 `openai` 或 `anthropic`，前者填写包含 `/v1` 的兼容 API 基址，例如当前 DeepSeek 配置所用的基址。执行会产生真实模型请求。

```js
// 保存为仓库根目录的 example-rna.mjs，再执行 node example-rna.mjs。
import { resolve } from 'node:path';
import { createSession, createWorkspaceTools } from './packages/sdk/src/index.mjs';

const model = {
  providerId: 'configured',
  protocol: process.env.RNA_MODEL_PROTOCOL || 'openai',
  baseUrl: process.env.RNA_MODEL_BASE_URL,
  modelId: process.env.RNA_MODEL_ID,
  contextWindow: Number(process.env.RNA_CONTEXT_WINDOW || 32000),
  maxOutputTokens: Number(process.env.RNA_MAX_OUTPUT_TOKENS || 2048),
  reasoning: 'off',
  cacheRetention: 'short',
};
if (!model.baseUrl || !model.modelId) throw new Error('请设置模型地址和模型 ID');
const cwd = process.cwd();
const stateDir = resolve('.rna-sdk-state');
const session = await createSession({
  sessionId: 'example-conversation', projectId: 'example-project', cwd, stateDir,
  model, apiKey: process.env.RNA_MODEL_API_KEY,
  tools: await createWorkspaceTools(cwd, { deniedPaths: [stateDir] }),
  systemPrompt: '你是 Rna Agent，结合可读取的项目内容协助用户；不要声称执行了没有执行的操作。',
  onEvent(event) {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  },
});
try {
  await session.prompt('查看项目顶层目录，并简要说明下一步值得关注的事项。');
  console.log('\n', session.snapshot().usage);
} finally {
  await session.dispose();
}
```

相同 `stateDir + sessionId + projectId` 重新创建会话，会读取同一 JSONL。可显式传入 `sessionFile`，但它必须在 `stateDir` 内。日志单写者锁、完整性链和副作用恢复属于 SDK；宿主负责选择状态目录、保护工具执行环境与保存项目资料。

## 运行中的输入

```js
const running = session.prompt('开始检查');
const queued = await session.followUp('检查结束后补充测试建议');
await session.steer('先关注兼容性，再处理其他问题');
// 仍在队列中时可以移除；已进入上下文的输入不能撤回。
await session.withdraw(queued.id);
await running;
```

`steer(text, { requestId, wake: false })` 可供宿主持久指令邮箱使用：同一 `requestId`/正文跨重开去重，正文冲突拒绝，不自行唤醒空闲会话。`yieldAtBoundary({ requestId })` 保存合作式暂停请求，结算当前请求或工具批次后产生 `continuation.reason = "control"`。它不取消已执行副作用，也不能越过未知工具结果；宿主确认原日志与授权后使用 `resume()`。

`steer` 在模型／工具安全边界进入上下文，不能改变已发出的 HTTP 请求，也不撤销已执行副作用。`followUp` 在当前工作收束后接续。`abort()` 请求停止，`resume()` 继续持久会话。SDK 对结果不明确的写操作要求宿主先提供 `toolResolutions`，不自动重试。

手动压缩保留原始日志，并要求提供真实摘要：

```js
await session.compact({
  keepLastTurns: 2,
  summarize: async ({ messages, previousSummary, instructions }) => {
    // 在宿主实现摘要模型调用，返回非空字符串；这里不能直接返回“已完成”。
    return await yourSummarizer({ messages, previousSummary, instructions });
  },
});
```

`yourSummarizer` 是需要宿主实现的接口示意，不是包导出的函数。也可传 `summary` 字符串。默认启用真实模型自动压缩；可用 `autoCompaction: false` 关闭。接近配置上下文的 80% 时，在完整工具批次之后，逐段摘要较早历史，保留最近两组回应／工具结果。摘要只使用同一已配置供应商、无工具权限；摘要被截断、失败或未减少上下文时保留原投影并停止这一轮。仍不做缓存预热。

## 能力分配和项目初始化

```js
import { CapabilityRegistry, bootstrapProject } from './packages/sdk/src/index.mjs';

const registry = new CapabilityRegistry({
  tools: await createWorkspaceTools(cwd, { deniedPaths: [stateDir] }),
  skills: [{
    id: 'project-analysis',
    path: resolve('packages/sdk/skills/project-analysis/SKILL.md'),
    enabled: true, trusted: true,
  }],
});
try {
  const initial = await bootstrapProject({
    title: '数据库迁移助手', description: '为已有系统提供可验证、可恢复的迁移流程。',
    catalog: await registry.catalog(), model, apiKey: process.env.RNA_MODEL_API_KEY,
  });
  if (initial.status !== 'ready') throw new Error(initial.reason);
  const assigned = await registry.resolve(initial.assignments);
  console.log(initial.overview, initial.focus, assigned.tools.map(tool => tool.name));
  // 宿主持久化 initial，将 assigned.tools 接入后续 createSession；
  // 只提供技能元数据目录，相关时再加载正文。bootstrap 不执行工具或安装插件。
} finally {
  await registry.close();
}
```

上例沿用前例的 `cwd`、`stateDir`、`model`。初始化由已配置模型生成；无真实模型时返回 `blocked`，不会用模板冒充生成结果。所有技能、工具、MCP 分配必须来自启用且可信的能力目录，并逐项解释原因。MCP 工具先由宿主配置、连接和发现，再参与分配。

初始化可通过 `beforeRequest({attempt, estimatedTokens, usage, signal})` 为每次生成或修复请求单独做预算准入；抛错即阻止该次请求。`bootstrap_request_start` / `bootstrap_request_end` 给出逐次生命周期，结束事件包含 `requestUsage` 和累计 `usage`，取消也会结算已开始的请求。`usage.totalTokens` 包含实际报量和缺报估算，`usage.estimatedTokens` 单列估算部分；异常附带 `error.usage`。估算采用该次完整上下文与输出余量，不是精确账单。宿主应在每轮结束后结算并释放预留，再准入下一轮，不能把前一轮的报量误当成全部重试用量。

## 公共模块与边界

| 接口 | 当前能力 |
|---|---|
| `createSession` | 流式会话、工具循环、steer/followUp/observe、停止恢复、自动／手动压缩、可恢复 JSONL、beforeRequest / beforeCompletion / beforeFinish / afterRun / beforeTool / afterTool |
| `streamCompletion` / `buildRequest` | OpenAI Chat Completions 兼容、Anthropic Messages SSE；DeepSeek thinking 参数；显式支持视觉的模型可接收有界原生图片块 |
| `CapabilityRegistry` / `loadSkill` | 显式可信能力、静态 SKILL.md、工具 schema 校验、按项目授予 |
| `CapabilityInstaller` | 本地/Git 技能包、固定 npm 包、MCP 配置导入；stage / validate / commit / rollback，由宿主管理授权 |
| `createWorkspaceTools` | 默认只读；显式 includeMutations 加入 hash 校验写入、精确编辑、可取消执行及完整输出日志 |
| `McpClient` | stdio、Streamable HTTP 的请求/响应子集；工具发现、调用、取消 |
| `bootstrapProject` | 项目标题和介绍 → 初始状态、里程碑、能力分配、缺失能力 |
| `InitiativeCoordinator` | 根据项目证据主动选择 wait/work/share/learn，无需 Goal；宿主提供动作和持久化 |
| `LearningCoordinator` / `reflectProjectLearning` | 独立持久学习积压、真实经验反思、defer/no_change/experiment、冻结实验排队和未知结果对账 |
| `executeProjectEvaluationCase` | 独立执行一个冻结用例，保留真实工具、产物验收及计量；不评分、不晋升 |
| `EvolutionCoordinator` | 项目候选生成、冻结基线对照、评估门槛、宿主显式试用／晋升／回滚 |
| `prepareContext` / `compactionCandidate` / `automaticCompactionCandidate` | 稳定工具顺序、前缀摘要、会话缓存身份、整轮或完整工具批次的压缩边界 |

SDK 通过控制平面的 ProjectInitiativeController 接入持续后台服务，绑定项目与对话证据、定时复查、投递与获准调查。后台默认只读，显式继承项目权限时仍受当前分配约束。宿主已接入真实基线/候选运行、冻结标准与产物检查；候选失败保留证据，不等于获得质量提升。完整示例与接入矩阵见[SDK 设计和运行契约](../../docs/rna-sdk.md)。

缓存目前实现稳定前缀、供应商支持的缓存参数和真实 usage 归一化；没有复制 Pi 的全部适配器、缓存预热器和计价系统，也没有与 Pi 做性能对比。`cacheRead` 来自供应商回报，`estimatedInputTokens` 只是估算，`costStatus: unpriced` 表示没有已验证费用。

OpenViking 是应用唯一记忆后端，不内嵌于这个基础包。通过宿主工具适配器接入；[本机官方 Docker 集成](../../docs/openviking-local.md)已单独验证，模型侧的协议夹具不能当作语义质量评估。

`LearningCoordinator` 的宿主提供 `saveState`、`review`、`execute`，通过 `ingest()` 录入身份稳定的轻量 episode。`tick()` 先持久化 claim，再调用模型；新证据只追加，不取消已冻结实验。反思必须明确选择 `no_change`、有到期时间的 `defer` 或带可证伪假说的 `experiment`。实验间隔未到时保存决策，不反复反思。`archiveReviews` 必须持久保存再返回；没有归档器时历史满会明确暂停，不静默丢审计。未审积压满时 `ingest().deferred` 返回未接受的身份，宿主保留源记录供后续准入。

同一证据连续反思失败采用退避，第三次后进入 `awaiting_evidence`；连续延期也最多三次。只有确实接受的新外部证据可以解除等待，重复 ingest 或 timer 不构成新证据。`health().awaitingEvidence` 显示数量。宿主证明执行尚未派发时，可用 `reconcile(reviewId, {status: 'retry_experiment', verifiedNoExecution: true})` 重排原实验，保留已经付费的反思；SDK 不自行推断这个证明。实际控制平面接入见独立学习运行时。

重启时未结束的 review/experiment 标为 `interrupted`。宿主可用已保存的不可变版本结果 `reconcile()`，未知实验不可自动重放。`invalidate()` 只发取消；`close()` 等待真实请求结算，包含无视取消的提供商。源删除应先 drain，再用纯函数 `revokeLearningSources()` 清除该源对应的原文摘要与反思正文，同时保留版本身份和账单收据。此队列是运行元数据，不是本地项目记忆替代品。架构对照及未完成的真实任务评估能力见持续学习审计。

图片使用 `{type:'image',data,mimeType}`，通过 `session.prompt(text,{images})` 或已授权工具结果传入；模型必须显式声明 `input: ['text','image']`。支持格式、大小、原生协议、CLI 附件入口和实际读屏证据见图像链路。不支持的模型得到明确诊断，不自动换模型或假装读过图片。


## 请求边界与动态能力

`beforeRequest({signal,snapshot})` 可返回 `{tools,contextUpdates}`。它在上一批工具全部完成后、下一次模型请求之前等待；失败或取消不会继续发请求。`tools` 是完整的新工具集合，宿主应先完成权限筛选；`contextUpdates` 的 `{key,source,text}` 以内容 hash 去重并持久化，作为来源明确的参考资料进入会话。`afterRun({snapshot})` 在收束后等待，便于宿主记录结果；它不是新权限来源。

`beforeTool({tool,args,signal,toolCallId,callKey})` 与 `afterTool({tool,args,result,isError,signal,toolCallId,callKey})` 是会话级的工具钩子，一次装上，对每个工具都生效（对照 pi 的 beforeToolCall/afterToolCall）。`beforeTool` 在参数校验之后、持久的 `tool_intent` 之前运行；返回 `{block:true,reason,code?,details?}` 时这次调用不执行，以 `refusalReceipt: {source:'host_before_tool',code,neverExecuted:true}` 完成（事件与 journal 都带，工具结果伪造不了）；钩子抛错同样视为拒绝。这次调用的 `tool_execution_start` 在钩子运行之前发出（与 pi 相同），在钩子里等待的调用已经是正在进行的一步。钩子运行期间被中止时，调用没有 intent：确定从未派发，既不执行也不是 uncertain，也不为它记录任何东西（没有结束事件、没有完成记录）；由宿主 `cancelUnstartedTools`（cancelled、neverStarted）或在 resume 时重新经过钩子执行。`afterTool` 在工具返回之后、结果提交之前运行，只能在结果末尾追加文本块并合并 details，不能改内容、`isError` 或参数；它被中止或失败时，调用以工具自己的结果完成。两个钩子拿到的参数都是副本，钩子永远不改写参数。拒绝之后与执行之后一样接受转向：`beforeTool` 等待期间到达的 steer 让同一批剩下的调用以“因新的转向输入取消”完成，不再执行。

应用中的 skill_load、五个 capability_* 工具与 OpenViking 适配器属于宿主，使用同一 SDK 调用与恢复机制。完整接口、安装 JSON、限制见[能力接入说明](../../docs/capability-installation.md)。

## 可执行项目能力包

0.3 增加 ProjectGenome：项目提示词、技能/资源、自动化脚本、可编辑评估条件与案例。bootstrapProject 的 ready 输出现在必须包含经过真实脚本 smoke 检查的 genome。createGenomeTools 可将受限文件 API 脚本用于 SDK 工具循环；proposeProjectGenome 与 evaluateProjectGenomes 负责提案和冻结基线的执行对照。新版契约见[项目生命周期](../../docs/specs/project-genome-lifecycle.md)，盲评与真实效果的区别见源码研究。

进化作者可将未修改的已有工具写成严格的 `{id, inheritFromBaseline:true}`。宿主从本次冻结且已验证的基线深拷贝完整工具（包括不向作者公开的 smoke 案例），记录 `proposal.toolInheritance` 的基线与工具哈希，再执行原有自测和冻结兼容检查。该引用只属于作者输入；发布的 `ProjectGenome` 仍只能包含完整工具定义。工具列表是完整清单：`[]` 不会自动继承，只有基线本来没有工具时才可为空。新增或主动修改的工具仍须提供完整定义和自己的自测。显式继承的工具在此候选内不可被任何脚本、参数、自测、fixture 或撤回修复修改；后续修复请求只收到引用与聚合检查状态，不会收到这些工具的隐藏自测输入、预期或实际输出。

主机使用 ProjectGenomeStore 发布不可变版本，并将版本 ID 固定在轮次上。SDK 本身不自动覆盖宿主文件或采用新版本。

## 持续运行的请求与资源边界

`streamCompletion` 默认空闲时限 120 秒、每个请求总时限 15 分钟；SSE 心跳只能刷新空闲计时，不能延长总时限。`idleTimeoutMs`／`totalTimeoutMs` 可按供应商覆盖，旧 `timeoutMs` 作为空闲时限兼容。仅明确返回 HTTP 429／5xx 且尚未接受 SSE 响应时自动重试，最多 2 次，指数等待并尊重不超过 60 秒的 `Retry-After`；长等待返回可重试错误供上层调度。连接错误、半条流、已执行工具均不隐式重放。

`iterateCompletion(provider, request, {timeoutMs})` 对第三方异步迭代器也提供取消／总时限。忽略取消的实现可能仍在外部运行；SDK 丢弃晚到输出，以 `error.completionPending` 通知上层等待真实未决 `next()` 结算，同一 session 在此期间拒绝新请求。它不能强制终止任意 JavaScript 或外部服务，进程监督必须处理真正的进程失去响应。

`beforeCompletion({signal,snapshot,purpose,estimatedInputTokens,maxOutputTokens})` 在每个实际模型请求前运行，包括 `purpose: 'compaction'`。预算宿主应在这里预留，而非只在能力刷新的 `beforeRequest` 预留。普通回应使用 `message_start/end` 结算；摘要使用 `compaction_request_start/end`，包含真实报量或 `usageReported: false`，取消也结算。摘要报量写入 journal 并纳入 session 累计 usage，不伪装成助手对话。配置上下文估算取字节启发式与同模型、同前缀、同摘要投影的最近供应商报量加增量估算的较大值；估算不是账单。

流式 token 仍逐个发布给 `onEvent`，但在日志中按流（请求、消息、增量类型）合并为 ≤250ms / 32KB 的 `message_update` 片段（`data.deltas` 为合并的 token 数）；任何其他记录写入前先结束当前片段，因此中断请求回放得到的部分正文与逐 token 记录完全一致。同一片段的事件共享该片段记录的 `seq`。每次正常关闭在日志旁写 `<日志>.checkpoint`（文件身份、大小、mtime/ctime、边界记录与 SHA-256 分段摘要）：新进程打开未变化的日志只核对边界记录，写入方崩溃后只增长的日志按分段摘要核对前缀、只校验尾部，其余情况完整校验。旧日志可用 `journal-compaction.mjs` 的 `compactJournal(file, { dryRun })` 离线合并逐 token 事件（重建哈希链、核验回放投影后替换，原文件保留为 `.precompact-<时间>-<记录数>`，`removeCompactionBackups` 核对后删除）。原始 JSONL 不被自动删减。replay 后释放日志事件数组，避免每个 token 的持久事件与 canonical messages 同时长期常驻；请求投影只复制摘要之后的正文。canonical messages 和完整 snapshot 仍随历史增长，100 小时低频观察与 100 小时持续高吞吐生成须分别验收，不能用加速时钟测试代替墙钟持续运行证明。MCP registry 关闭时同时取消连接中的客户端并等待子进程退出；同一 close 共用 Promise，关闭后不能重新注册晚到的能力。

长期运行的 `InitiativeCoordinator` 支持 `decisionTimeoutMs`、`actionTimeoutMs`、独立故障退避和 `archiveHistory({ actions, seenEventIds })`。`decisionDue({ cacheWindowUntil, wakeFloor })` 无副作用地读出此刻 `tick` 会不会请求决策（与 `tick` 读同一组闸门，只差请求大小的预算检查）；宿主只在它为真时询问判断模型，否则协调器空转时每次轮询都会多一次判断和一条账本行。归档回调成功后才裁热历史；缺少回调时不会删除调用方历史。忽略取消的自定义函数会被隔离，未知副作用保持 `needs_review`，不会靠自动重试伪造恢复。Rna 宿主已接入持久归档、跨项目并发预算与健康状态，代码依据及 120 虚拟小时故障测试见长期调度说明。

每个 stdio MCP 增加一个随 SDK `src/` 一起分发的轻量 Node guardian。它转发标准流并遵守背压；服务运行在独立进程组。SDK 宿主被 SIGKILL 后，guardian 通过 stdin EOF 或 250ms 父进程检查发现失联，对拥有的服务组 TERM，500ms 后 KILL，并限制自身清理等待；不会按未知 PID 扫描或杀其他应用。该进程树保证针对 POSIX；Windows 目前只保证直接子进程终止，不能宣称等价的整个树回收。测试验证了512KiB背压输出、真实退出码、宿主SIGKILL、拒绝SIGTERM的孙进程和无关进程存活。

`project_exec` 和能力安装的 git/npm/命令调用使用独立的 [command guardian](src/command-process-guardian.mjs)。它用单独 IPC 通道和 250ms 父进程检查确认宿主存活，结束命令 stdin 只是普通 EOF，可继续计算并返回输出。取消先 TERM、300ms 后 KILL；命令正常退出也回收同组后代，输出排空最多等待 1,500ms。只有确认进程组不存在才报告清理完成。guardian 本身被强杀或失去响应时，父进程不按旧 command PID 猜测补杀；调用点显式返回 `cleanupUncertain`，启动回执丢失还标记 `startUncertain`，禁止自动重放未知副作用。此边界只覆盖 POSIX 所属进程组，不是沙箱，也不承诺回收主动另建会话逃离该组的程序。guardian 排除 Node preload/动态加载环境注入，实际命令仍保留调用方配置的环境。

宿主为 `createWorkspaceTools` 指定私有 `execLogDir` 后，命令回执另含 `outputId`。使用同一目录创建 `createExecOutputTool({execLogDir})`，可按字节 `offset` / `nextOffset` 分页读取完整捕获日志；工具名为 `project_exec_output`，不重跑原命令。它只接受当前私有范围内的日志 ID，拒绝任意路径、软链接和非普通文件，跨页保留完整 UTF-8 字符。原回执仍决定退出状态、日志是否完整及清理是否确定，读取日志不是补记执行成功。此工具由宿主显式注册，不改变 SDK 默认工具集合；会话删除时由宿主一并清理该会话的私有日志目录。

SDK 把工具结果/异常中的 `details.cleanupUncertain` 或 `details.startUncertain` 视为未决执行，持久写 `tool_uncertain`，不写 `tool_completed`，并停止后续模型请求。即使工具声明 read/idempotent，也必须经 `resume({toolResolutions})` 明确核对后恢复；进程可能仍在运行，不能叠加一个“可重复”的新调用。普通取消的已声明只读工具仍保留原有可重试语义。主动行动收到 `uncertain_tool` 时进入 `needs_review`，暂停项目 work/learn 而保留 wait/share，允许说明具体阻碍。`resolveAction` 的确认必须先持久成功才解除执行隔离，保存失败恢复未决状态。Rna 宿主提供带非空核对说明的显式结果确认入口，普通聊天“继续”不会解除隔离。

取消先于宿主检查结束时，晚到的工具不确定诊断仍会升级行动并先持久化，再结束异步清理隔离，不制造新证据或重放操作。`resolveAction` 拒绝确认仍有运行/未清理操作的项目；确认 `cancelled` 表示已核对终止但结果未验证，单独保存 `resolutionOutcome`/`resolutionSummary`，保留原诊断与部分结果，不等同于成功或从未执行。

后台调查可显式选择 `stepLimitBehavior: 'summarize'`：先运行至多 `maxSteps` 个正常模型请求（共享默认 `DEFAULT_MAX_STEPS = 64`），完整提交最后一批工具结果后，至多增加一个禁工具的收束请求。该请求经过相同的 `beforeCompletion` 预算和取消检查，要求只根据实际证据汇报结果、未完事项与下一步；不会伪造用户消息或授予新权限。收束消息以 `source: 'step-limit-summary'` 标记，usage 正常累计。如果模型仍返回工具调用、空内容或截断结论，工具不会执行，返回明确的 `step_limit` 失败并保留日志。SDK 默认 `stepLimitBehavior: 'error'` 保持调用方兼容；Rna 前台宿主显式使用下面的 `yield` 分片接续。后台持续推进仍由项目调度器按观察与策略决定。

生成结构化产物的宿主可同时传 `stepLimitInstructions`，替换上述默认的事实总结任务。例如候选作者明确要求完整 proposal JSON，并区分事实诊断与尚未验证的 hypothesis/genome。选项仅适用于 `summarize`，必须是非空、无 NUL、至多 `MAX_STEP_LIMIT_INSTRUCTIONS_BYTES = 32768` UTF-8 字节的字符串；SDK 不隐式序列化 schema，输出 schema 仍由宿主校验。定制任务不会增加调用额度、恢复工具、绕过预算或取消，也不会移除禁止假报完成的固定约束。有冻结来源的作者每次尝试最多五次研究请求加一次无工具输出；`maxAttempts: 1..3` 可在校验失败后产生新的付费尝试，最多十八次作者请求，不能把六次说成整个进化实验的总请求数。后续真实评测单独计费并受同一实验预算限制。

初始化与只使用公开参考的候选作者也使用同一尾轮契约，分别传入初始化 schema 和候选 schema，提前给出合法 JSON 时不增加尾轮请求。隔离作者关闭自动压缩，增长的资料超过模型真实上下文时以 `context_limit` 停止并保留已发生用量；六次作者请求上限不通过额外的隐藏压缩请求突破。普通交互会话的自动压缩默认行为保持不变。

`CompletionRequest.responseFormat: {type:'json_object'}` 和 `toolChoice:'none'` 是明确的原生协议要求，不支持时在发送前以 `unsupported_output_contract` 拒绝，不会在供应商失败后偷偷改用提示词再付费请求。`resolveJsonOutputContract(model)` 提供可审计的协商结果：只有核验过的 DeepSeek 官方 HTTPS 默认端口、根路径或 `/v1` 下的 `deepseek-v4-pro` / `deepseek-flash`，以及明确声明相应 `compat.supportsJsonObject` / `compat.supportsToolChoiceNone` 的 OpenAI 协议模型才自动发送字段；显式 `false` 优先。未知代理与未核验的模型返回 `prompt_only` 及原因；当前 Anthropic 路径不会套用 OpenAI 字段。

Session 的 `stepLimitResponseFormat: 'json_object'` 表示仅对 `summarize` 尾轮协商上述能力，不是承诺所有供应商强制 JSON；结果写入 `response_contract` / `request_started.responseContract`，请求身份摘要也包含输出约束。作者、初始化和直接 JSON 请求将原生格式与工具策略写入非敏感审计；普通聊天和研究步骤不强制 JSON。`native` 仅表示发送了协议约束，仍须整段解析并通过原有 schema、业务和脚本检查，不能从叙述或 DSML 中截取 JSON 冒充成功。[DeepSeek 官方 JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/)仍明确提醒空响应与截断可能发生。

若尾轮流已完整结束、没有工具调用，且明确报告 `stop` 但正文为空，或报告 `length`，Session 仍以 `step_limit` 停止普通会话，同时在 `request_completed` 和 `SessionError.responseDiagnostic` 保留请求/消息 ID、原始停止原因、正文 UTF-8 字节数和失败类别，不把正文或思考内容写进诊断。结构化作者只对这一精确回执转为 `invalid_output`，使用原有 `maxAttempts`，不会接受截断 JSON 或增加尝试上限。未知停止原因、缺少完成回执、工具越界、供应商异常、预算拒绝和取消不会因为带有 `step_limit` 字样而获得重试资格。

隔离的学习作者和参考作者（包括初始化）通过现有 `beforeFinish` 检查提前返回的正常 `stop` 响应。整段文本可解析为一个 JSON 对象时才结束此格式检查；允许已有的完整代码围栏形式，不从叙述或混合文本中抽取 JSON。非对象产物收到固定主机反馈，在原有五次研究请求内继续；第六次预留尾轮不再产生反馈，仍由原有严格 schema 和业务检查判定。该检查不验证候选质量、不增加请求上限，也不改变普通会话。`author_format_feedback` / `bootstrap_format_feedback` 只记录消息 ID 和反馈次数，不记录回答正文或成为新的项目学习证据。

`stepLimitBehavior: 'yield'` 把同一任务的步数上限变成调度边界。完整提交工具批次后，SDK 持久化 `run_yielded`，返回 `snapshot().continuation`，并以 `reason: 'yielded'` 结束当前段；这不代表任务完成。SDK 不自行启动下一段，待宿主让出事件循环并核对仍属同一轮、未暂停／停止及预算后，再调用同一 handle 的 `resume()`。下一条 `run_started` 记录 `continuationId` 并清除待接续标记，没有新用户消息、没有合成“继续”提示，也不重复已完成工具。重启只恢复标记，不自动运行。预算失败、供应商错误、未决副作用及交付检查上限继续作为真实错误停下。

```js
// Illustrative host driver: ownsCurrentTurn includes live pause/stop/close checks.
await session.prompt(text); // session was created with stepLimitBehavior: 'yield'
while (session.snapshot().continuation) {
  await new Promise(resolve => setImmediate(resolve));
  if (!ownsCurrentTurn() || !canContinueWithinBudget()) break;
  await session.resume(); // beforeCompletion still reserves each actual request
}
// A remaining continuation is paused/pending, never a completed task.
```

宿主应让新指令通过原会话 inbox 进入，不重提原始 prompt；每次 `resume()` 的错误都必须显式处理，不能在失败后无条件循环。该设计采用 Pi 的无新增消息接续和完整工具循环，以及 Harness 的持久化检查点后复核生命周期原则，具体源码依据、真实崩溃测试与限制见会话分片接续。

持续行动可使用 handler context 的 `await reserveTokens(inFlightEstimate)` 与 `await reportUsage(cumulativeActionUsage)`：每个顺序请求先预留，结束后报告本行动的累计 reported/estimated usage，再进入下一请求。未结算请求不能被下一笔预留覆盖；最终 handler 的 `usage` 只补尚未记账的差额，不会重复收费。取消后不接受晚到更新，未知在飞请求保守计入当前预留并保留 `needs_review`。未使用这些回调的旧 handler 仍按完整行动结果结算。

`saveState(snapshot, {reservationAdmission:true})` 表示新的付费请求准入。多项目宿主必须在同一存储事务内检查**最新**全局/项目限额并写 reservation；普通使用量结算不能因用户随后收紧上限而拒收已经发生的真实用量。Rna 的工作与进化路径均已接入：从不限额改为有限额、执行中再次降低上限，都会阻止下一次不符合额度的请求，既有请求按真实回执计费。单次行动跨日时，每次回执及时结算到当日，最终结果不重复记入新一天。

`proposeProjectGenome`、`evaluateProjectGenomes` 的 `requestControl.beforeRequest({phase,estimatedTokens,signal})` 在真正进入供应商前执行，拒绝时既不调用模型也不生成估算账单；`requestControl.onUsage(receipt)` 在每次请求用量归一化后执行并被等待，覆盖提案、修复、baseline/candidate 工具循环及匿名 judge。显式 `tokenBudget` 仍是该次函数调用的固定上限；需要随用户配置变化的宿主传 `tokenBudget:null`，在回调内执行实时全局/项目准入。

主动决策默认使用配置模型的输出上限；调用方可用 `policy.decisionMaxTokens` 显式降低。失败的行动收据会带脱敏错误码和短诊断进入后续决策上下文，失败不等于完成工作，也不构成自动再次学习的新证据。故障状态保留来源与响应大小/摘要指纹，原始提示词、模型回答及凭据不写入诊断；历史记录的具体原因缺失时保留未知。

供应商 SSE 的终止状态按协议白名单处理：OpenAI Chat 的 `stop`、`length`、`tool_calls`、`function_call` 与 Anthropic 的 `end_turn`、`stop_sequence`、`max_tokens`、`tool_use` 才映射为对应正常停止、截断或工具状态。内容过滤、资源中断、拒绝、暂停、未知值及缺失原因不能生成成功 `done` 或派发工具；它们抛出 `ProviderError`，不会作为作者格式失败购买额外尝试。正常 `stop` 仍保留完整合法工具调用的已有兼容行为；截断工具不会派发。正常空白回答仍可能通过传输层，它是否构成有效产物由原有作者 JSON/schema 检查判断。

`ProviderEvent.done`、`ProviderError`、持久会话消息及作者请求回执的 `providerFinishReason` 保存供应商原始状态 token（最多 80 个 ASCII 状态字符；非法值记固定标记，缺失为 `null`），区别于 SDK 归一后的 `stopReason`。诊断不包含响应正文。`usage` 事件是**同一请求的累计快照**，可能多帧；消费者按最新值覆盖，只在跨请求时累加。已消费到的用量在异常前交付；取消前尚未消费或供应商尚未发送的用量仍可能未知，不伪造已知收费。

隔离作者仅在**本次操作**得到可信的原生 JSON 空白尾轮后，才启用备用提交通道：Session 必须完整消费该尾轮、无工具调用，SDK 本地诊断为 `empty_response`，且原始供应商原因为 `stop`。操作内 WeakMap 暂存已经完成的研究上下文；剩余原有尝试直接复用它，每次最多一笔 `submit_project_artifact` 请求，不重读来源、不新增确认请求。唯一工具只承载待验证参数，不注册或执行；保留模型的 reasoning，省略 `response_format` 和强制 `tool_choice`。异常、截断、未知完成、非原生 JSON、历史失败文本均不授予资格；早期完整 JSON 接受路径保持。

替代请求保留原始 schema、来源和用量检查。整条流与费用回执完成后，恰好一个匹配调用通过宿主 schema 验证才产生 `*_submission_captured`：这是 `captureScope: operation_memory, durable: false` 的内存草稿接纳，不代表持久写入、脚本检查通过或晋升。事件中的 requestId 与准入/计费回执一致，并记录 schema/参数/上下文哈希、callId 和原始终止原因。初始化修复会收到上一份未验证草稿，并继续约束其原工具 ID、smoke 输入和用例数。候选脚本修复与评估仍走原链路。学习作者原总上限不增加；公开参考作者原三次尝试最多 8 次请求、初始化最多四次尝试最多 9 次请求，备用提交只会减少研究请求。

备用提交的参数仍使用严格 JSON 解析，不修补、截取或执行无效参数。仅真实 OpenAI 流显式收到 `[DONE]`、原始 `tool_calls` 正常终止、所有参数片段均属于唯一且身份明确的已声明提交调用时，适配器可为参数 **JSON 语法**错误建立一次性私有证明。证明绑定本次请求、schema、上下文与输出合同；计费结算完成且未取消后，隔离作者才可使用原有剩余尝试修复。缺终止标记、模糊索引、错误身份、多调用、异常终止、结构错误、取消或结算失败均不获得这项资格。普通 Session 仍报 `invalid_tool_call`。

此时用量回执 `completed` 仍为 `false`（适配器未产生有效 `tool_call`/`done`），另行记录的 `argumentDiagnostic.transportCompleted: true` 只确认传输终态。公开诊断只有请求身份、终态、参数字节数与哈希；有界的无效参数正文仅在本操作内存中作为下一尝试的不可信修复材料，不附到普通错误、轨迹、修复证据或持久文件，重启后不恢复，也不为历史失败追授资格。


### 后台行动控制

`InitiativeCoordinator` 的宿主 work handler 可以显式选择 `actionControlKinds: ['work']`。新证据通过 `observe` 或 `invalidateDecision` 废弃旧判断；`interrupt` 保留原来取消执行的语义。

```js
const receipt = await coordinator.requestActionControl(actionId, {
  id: requestId, kind: 'steer', expectedRevision,
  instruction: '优先核对官方来源',
  // 由宿主填写；用于删除来源聊天时清理派生记录。
  sourceSessionId,
});
```

`kind` 支持 `pause/cancel/resume/steer`。宿主消费 `pendingActionControls(actionId)`；方向先写入原 session 日志，再用 `acknowledgeActionControl` 确认。暂停/取消先请求安全边界，handler 返回 `{control:{commandId,kind,checkpoint:{sessionId},summary},usage}`；pause 必须 checkpoint。仅仅调用 abort 或收到命令不能返回已暂停。恢复仍使用原 action 与 journal，未知效果仍需核对。

命令历史最多 64 条、pending 最多 16 条，来源集合独立保留至多 128 个会话。CAS 与 ID 幂等使旧客户端、丢响应和重试不会重复插入指令。宿主可提供同步 `beforeCommit` 复查来源是否仍有效，不能把该函数当成异步授权流程。详细验收见 前后台协作发布说明。

## 外部项目事件（0.8）

公共入口导出 `createProjectEventInbox`、`ProjectEventError` 与严格类型，提供项目/工作区/来源绑定、单调游标去重、有界待投递记录、来源撤销及持久确认。保存成功才向调用者公开事件；它不执行任务、不授予权限，也不负责跨进程锁。具体状态契约及宿主投递顺序见SDK 事件接口；完整目录接线见本轮发布说明。

## 技能市场来源与搜索覆盖

`SkillMarketplaceClient.search()` 返回 `coverage`，描述本次有界结果页：`complete` 为解析完成，`partial` 为有可用结果但部分行不支持或超出请求上限，`unsupported` 为返回了记录但全部无法解析，`empty` 仅代表 API 实际返回空数组。这不是全市场覆盖率，也不是质量评分。`returnedCount / inspectedCount / supportedCount / unsupportedCount / duplicateCount / omittedCount` 分别报告返回、检查、唯一可用、不支持、重复及未检查条数。`reasons` 仅含固定代码与计数；旧 `skippedUnsupported` 继续等于不支持条数。宿主不能把 `unsupported` 或请求异常显示成“没有技能”。

读取优先使用市场明确给出的目录；skills.sh 的精确同名子目录优先于仓库根 `SKILL.md`。目录名称与技能名称不同的时候，最多检查 8 份固定提交的完整 `SKILL.md`，每份最多 64 KB、合计检查时限 30 秒，以原始 frontmatter 的 `name` 核对唯一身份。超过范围返回 `marketplace_resolution_limit`，检查超时返回 `marketplace_resolution_timeout`，多个真正匹配仍返回 `marketplace_skill_ambiguous`。不猜目录、不把任意根技能当成目标、不截断原文来伪装完整来源。

`read()` 仍是来源检查；`acquire()` 获取完整文本包与许可原文，仍返回 `installed: false`。只有宿主将包写入隔离版本并通过原有验证、绑定项目后才能称为可使用。固定 commit、Git blob 校验、资源清单与 `packageHash` 保持不变；可执行脚本作为资源保存，不由下载过程执行。二进制、符号链接、超出包上限或缺失许可文件仍明确失败。范围、参考实现与 HTTP 回归见来源解析审计。
