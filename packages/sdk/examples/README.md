# 无 Goal 的项目主动协作示例

`proactive-project.mjs` 从项目标题和介绍开始，调用真实模型生成初始状态并分配可信 skills／只读工具。随后把“项目创建”作为观察事件交给 `InitiativeCoordinator`，由模型判断研究、发言或等待。它不要求先设定 Goal，也不会强制模型输出预制的主动消息。

在仓库根目录执行（Node.js ≥22.19.0）：

```sh
node packages/sdk/examples/proactive-project.mjs --help
node packages/sdk/examples/proactive-project.mjs \
  --model ./model.json \
  --title "离线备份工具" \
  --description "给独立开发者设计可验证、可恢复的备份流程" \
  --workspace ./packages/sdk --interactive
```

`model.json` 由你指定，模型容量、接口地址和 ID 应填写供应商的实际配置。不要在文件中写 API key；先在当前终端配置 `RNA_MODEL_API_KEY` 环境变量。

```json
{
  "apiKeyEnv": "RNA_MODEL_API_KEY",
  "model": {
    "providerId": "configured",
    "protocol": "openai",
    "baseUrl": "https://your-provider.example/v1",
    "modelId": "your-model-id",
    "contextWindow": 32000,
    "maxOutputTokens": 4096,
    "reasoning": "off"
  }
}
```

地址、模型 ID 和容量均为配置格式示意，不是可直接连接的默认服务。没有模型文件或环境变量凭据时明确退出，不会切换到模拟运行。

- `work` 创建真实 `createSession`，只接收模型初始化时分配的只读工具及技能；过程输出为后台研究事件。
- `share` 输出 `chat_message` 事件，包含主动消息和证据 ID。`--jsonl` 可以让自建聊天前端逐行消费事件。
- `--interactive` 将终端输入变成新观察，同时通过 `steer()` 插入正在研究的会话。此示例不模拟逐键输入状态；完整 UI 应把真实 typing/presence 传给协调器。
- `--ticks`、`--max-requests`、`--token-budget` 限制本次运行。token 用量优先采用供应商报告；缺失报告时保守预扣，不把估算描述为真实计费量。
- 状态和会话写入 `.rna-sdk-example/<随机运行 ID>/`；每次启动是独立示例，当前脚本不自动恢复旧运行。只读工具禁止访问该状态目录、模型配置、私密目录和目录外路径。
- Ctrl+C 取消请求并关闭所有 session、coordinator 和 Registry。

## 可选进化流程

添加 `--evolve` 后，`learn` handler 可运行 `EvolutionCoordinator` 的真实函数评测示例：基线函数原样返回标签，候选由宿主提供，先去掉边缘空格、再统一大小写；实际运行同一组三个输入，比较返回值和期望值。这用于验证 SDK 的候选、成对评测、门槛和事件流程，**不是模型质量或 Agent 能力提升的证据**。模型是否选择 `learn` 仍由当次主动判断决定。

通过门槛的版本产生 `evolution_candidate_ready` 事件，进入新的项目观察，供模型决定是否提醒用户试用。本例不自动调用 `trial`、`promote` 或覆盖用户文件。

你也可以通过 `--evaluator ./my-evaluator.mjs` 提供项目相关的真实宿主评测器。该路径由命令显式指定，模块会作为可信本地代码加载。它须导出：

```js
export const evaluatorId = 'your-domain-evaluator@1';
export const label = '具体说明这些案例能证明什么';
export const baseline = {
  versionId: 'baseline-v1',
  strategy: '当前真实策略快照',
  skills: [],
  assignments: { skillIds: [], toolIds: [], mcpServerIds: [] },
};
export const cases = [/* 至少 3 个带唯一 id 的实际输入/验收案例 */];
export async function evaluate({ project, version, testCase, side, signal, tokenBudget }) {
  // 在隔离环境实际执行当前 version，返回真实评分及证据。
  // return { score: 0..1, passed: boolean, safetyPassed: boolean,
  //          evidence: { 实际输出及验证结果 }, usage: { totalTokens } };
  throw new Error('必须实现真实评测，不能返回预设成功分数');
}
// 可选：export async function propose(...)，返回 { proposal, usage? }。
// 不提供 propose 时，SDK 调用配置模型生成候选策略/已有技能修订。
```

评测器负责隔离执行、响应取消并遵守预算；SDK 本身不提供操作系统沙箱。`baseline.assignments` 不能添加项目初始化未分配的能力，候选也不能增加工具或 MCP 授权。所有质量结论仅覆盖你配置的固定案例。
