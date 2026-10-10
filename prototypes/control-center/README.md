# Rna Agent · v0.17.0 后端与协作界面

Rna Agent 以项目组织持续会话、工作目录、观察、后台工作和能力版本。桌面风格的 Web 界面与 CLI 共用一个本机 daemon；模型、工具轨迹、用户插话和主动消息保留在同一段对话中。

本版本已接入 **独立 Rna SDK 0.10.0 的真实模型执行**，**OpenViking 是唯一记忆后端**。内置 `demo` 模型仍用于无密钥交互演示。真实项目由模型生成提示词、技能、自动化脚本与可编辑评估标准，后台自主判断、研究和进化。候选会实际执行脚本与冻结基线用例，通过后邀请试用；当前有限评测不证明通用能力提升。旧 `demo-policy` 只保留显式演示。详见[执行与版本契约](../../docs/specs/project-genome-lifecycle.md)。

0.17.0 将无需改动的作者复核单独留档，不生成空候选、不启动无意义的配对评估；版本详情展示真实收益与冻结门槛，统计按尝试、候选、完整评估、通过、采用分开。GUI/CLI读取同一解释，用户无需额外配置。评测增加来源主张、真实像素和同会话多轮验证，后台通知避免每帧克隆全部状态。见Phase 6B 报告。

0.16.0 增加有边界的进化搜索反馈：按真实能力差异核对本轮范围，区分完整测量和未完成尝试，避免相同条件下重复购买相同候选的评测。宿主自动推导策略，不增加必配选项；版本详情折叠展示“候选搜索与反馈”，CLI `version` 读取相同记录。真实收益及已发现的质量边界见阶段验收。

聊天顶部的“文件”提供真实目录、源码和下载；选中 `game/index.html` 后可启动右侧分屏静态预览，返回聊天时继续显示页面。输入区权限菜单直接保存项目权限；加号与斜杠共用文件、目标、计划、反馈、压缩、权限、模型和导出命令。主动复查、主动发言与自动进化间隔可在“设置 → 主动协作”调整。详见工作台说明、文件与预览边界和内置协作助手。

Agent 也可通过 `project_preview` 启动同一个静态预览。成功工具卡的“查看页面预览”可直接打开聊天分屏；每次先向宿主核对当前地址，服务已停止时不会沿用旧链接或擅自重新启动。页面渲染、交互和截图需要实际浏览器能力，不能从预览启动成功推断质量通过。

## 启动与安装

要求 Node **≥22.19.0**。daemon 使用工作区内的独立 `@rna-agent/sdk`，不依赖或包装 Pi SDK；SDK 与 daemon 均无第三方运行依赖。

```bash
cd prototypes/control-center
./rna start
```

打开 <http://127.0.0.1:4317>。界面是 `web/` 下的工作台（React + Vite），daemon 只提供其构建产物 `web/dist`；首次使用或更新界面源码后需构建一次（`cd web && npm ci && npm run build`），构建后刷新页面即可，无需重启 daemon。未构建时 daemon 仍提供 API 与 CLI，页面会显示构建说明。CLI 共用的纯展示模块位于 `presentation/`。本工作区提供 `./rna` 启动器，会优先选择已经准备好的独立 Node 22，否则使用 PATH 中的 Node；不需要调整系统 shell 环境。

```bash
cd prototypes/control-center
./rna start
./rna help
./rna test
```

可用 `RNA_AGENT_NODE=/absolute/path/to/node` 明确指定 Node。其他机器安装符合版本的 Node 后即可用启动器或 `node server.mjs`；daemon 和 SDK 没有第三方运行依赖。

`RNA_AGENT_PORT` 设置端口，`RNA_AGENT_STATE` 设置状态文件。旧 `PI_FORGE_PORT` / `PI_FORGE_STATE` 保留兼容，新名称优先。默认只监听 `127.0.0.1`，面向可信本机单用户；不是可直接暴露到公网的服务。

## 持续后台运行

```bash
./rna service start                       # macOS LaunchAgent / Linux systemd --user
./rna service status
./rna endurance start                     # 按实际历史选择观察窗口
./rna endurance status
./rna endurance stop
./rna service stop
```

原生模式由用户级管理器托管，不依赖终端或聊天窗口。macOS 若尚未授予后台 Node 文稿目录权限，可明确使用 `service start --session`；已有原生定义时用 `service restart --session` 切换。会话模式不具备系统重启或 supervisor 自身退出后的自动恢复，状态会明确显示模式；权限获准后可 `service restart --native`。关闭服务会记录停止意图并收回所属进程，不会被守护程序自行重新开启。`service restart` 应用服务配置变化，`service uninstall` 移除托管定义并保留全部项目数据。环境变量形式的供应商密钥必须在后台服务环境中可用；设置页保存的独立凭据库可直接复用，安装器不会把 shell 密钥复制到 plist。

本机兼容 relay 可通过 `service restart --helper-descriptor /绝对路径/relay-helper.json` 一并托管；正常 start/restart 保留这项配置，`--without-helpers` 明确清空。依赖进程有独立租约、身份校验、关闭期限和恢复退避，其故障及重启会进入耐久报告。详见 [OpenViking 部署](../../docs/openviking-local.md) 与 [长期运行说明](../../docs/operations/continuous-runtime.md)。

耐久观测每 5 秒检查服务、每分钟保留摘要，故障及实例变化立即记录。重启、休眠空档和时钟跳变不能计为连续健康。`--keep-awake` 仅在 macOS 本次观测期间运行 `caffeinate -i -s`，请求防止空闲睡眠及接通电源时的系统睡眠，允许显示器睡眠；不修改全局电源设置，停止观测或服务时释放。它不承诺合盖、主动睡眠、断电或登出时仍持续运行。详细默认值、故障语义和边界见[持续运行说明](../../docs/operations/continuous-runtime.md)。

## 应用更新与恢复

“设置 → 应用与恢复”提供本地运行包检查、恢复点和版本切换，CLI 使用 `./rna maintenance status`。更新等待已接纳的工作结束，拒绝新的执行请求并保留草稿；已开始的工作可以收尾或由用户停止。后台进程独立完成维护，关闭页面不会重复提交或取消操作。

应用回退只切换兼容代码。还原恢复点会替换本机会话、配置、SDK 记录等数据，**不回滚项目目录和 OpenViking 远端记忆**；因此还原后保持暂停，旧待办必须核查，不能承诺旧外部效果“执行一次”。离线可用 `./rna recovery status` 查看，详见[应用维护操作说明](../../docs/operations/application-maintenance.md)。本地 macOS 包为 ad-hoc 签名，尚无在线更新源、Developer ID 签名或 Apple 公证。

## 配置真实模型

侧栏“设置”或 `⌘ ,` / `Ctrl ,` 打开配置；模型菜单支持搜索、供应商分组、键盘选择和对应模型的推理档位。可以先保存只有 endpoint 和凭据的空模型目录，再测试目录连接并显式添加模型。

提供商支持 OpenAI 兼容或 Anthropic 协议，内置 OpenAI、Anthropic、DeepSeek、Google 兼容接口、Groq、OpenRouter 和自定义七种接入预设；具体模型容量与来源在设置中查看。保存模型 ID、名称、上下文窗口、最大输出和支持的推理档位后，设置默认模型或切换会话模型。新轮次固定模型配置，在途轮次保持原配置；切换到非 `demo` 提供商后会调用真实模型。

连接测试只请求模型列表，不产生生成请求，也不自动采用发现的模型。它不能证明填写的上下文容量、推理档位或生成接口都有效。首次真实请求的失败会留在会话轨迹中；不会将失败伪装成演示成功。

自定义 OpenAI 兼容服务可在模型的 `compat` 中明确声明 `supportsJsonObject` 和 `supportsToolChoiceNone`，两项均只接受布尔值。先按服务文档核对，再通过下面的 `provider-add --file` 或供应商 API 保存，例如 `"compat":{"supportsJsonObject":true,"supportsToolChoiceNone":true}`。声明分别允许结构化作者请求使用 JSON object 输出格式和禁止工具选择；它们不代表服务支持 JSON Schema，也不能替代结果校验。未声明的代理能力不会仅凭模型名称开启；SDK 明确支持的官方端点与型号可使用其已知能力，显式 `false` 会覆盖自动识别。

更新已有供应商使用 `PATCH /api/providers/:id` 的 `models` 数组，保留仍需使用的模型。模型补丁省略 `compat` 时保持原声明；提交新的 `compat` 对象会替换原声明，`"compat":{}` 清除所有显式兼容声明并恢复 SDK 的端点识别，设置某项 `false` 则明确禁用该能力。界面编辑其他模型设置时会保留已配置的声明。新轮次和后台协作采用更新后的模型配置，已在执行的会话仍使用启动时的快照；配置变化也会使旧学习范围和评估模型指纹失效。

```bash
./rna config
./rna providers
./rna provider-add --file /path/to/provider.json
./rna provider-test PROVIDER_ID
./rna model-default PROVIDER_ID MODEL_ID high
./rna model-set SESSION_ID PROVIDER_ID MODEL_ID high
```

提供商文件示例，不把密钥放进命令行参数：

```json
{
  "name": "我的模型服务",
  "protocol": "openai",
  "baseUrl": "https://your-provider.example/v1",
  "apiKeyEnv": "RNA_MODEL_API_KEY",
  "models": [
    {
      "id": "your-model-id",
      "name": "项目模型",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "reasoning": ["off", "high"]
    }
  ]
}
```

这些容量与档位仅是格式示例，应按实际服务填写。环境变量需提供给 **daemon 进程**，只在另一个 CLI 进程里设置变量不会改变已启动 daemon 的环境。

API Key 可通过设置页、配置文件的只写 `apiKey` 字段，或 `apiKeyEnv` 引用保存。读取配置只返回“已配置”与凭据来源；密钥不进入普通状态 JSON、事件、浏览器 localStorage 或 CLI 配置输出。独立 `.secrets` 文件使用 `0600`，但仍是本机明文文件，未接系统 Keychain。远端连接要求 HTTPS，本机可用 HTTP；目录探测不跟随重定向，错误响应不回显上游原始正文。

## OpenViking：唯一记忆后端

新配置默认 `openviking`；没有本地记忆选项或本地回退。已有 `local` 配置启动时迁移为 OpenViking，旧 `projectMemories` 只在原状态文件中归档保留，不进入检索、会话上下文或普通状态 API。不会自动把历史记录上传到 OpenViking。

打开项目记忆页时会自动连接已配置的 OpenViking，首次浏览若确认当前项目根目录尚不存在，会在验证服务与鉴权后创建该目录，并显示空库。已有目录直接加载；缺失子目录、错误地址与鉴权失败仍明确报错。无需先手动连接或初始化。常用的“记忆偏好”提供自动关联开关、估算 token 预算与候选检索数量；服务地址和凭据放在默认折叠的“高级连接设置”中。

**本机使用官方 OpenViking Docker 与真实语义模型。** 已完成从测试夹具到 BGE-M3 向量模型及实际文本抽取模型的切换，跨语言检索、记忆抽取与跨会话召回的独立证据见 真实记忆验收。当前运行状态以服务健康检查为准；配置与 Docker 转发说明见 [部署文档](../../docs/openviking-local.md)。服务离线时记忆操作明确返回 `503`，不会假装命中旧本地记录。

```bash
./rna memory-config --endpoint http://127.0.0.1:1933 --api-key-env OPENVIKING_API_KEY --auto-recall true --context-budget 2048
./rna memory PROJECT_ID health
./rna memory PROJECT_ID initialize
./rna memory PROJECT_ID list
./rna memory PROJECT_ID browse
./rna memory PROJECT_ID search "发布约定" --level L1
./rna memory PROJECT_ID read viking://resources/projects/PROJECT_ID/note.md --level L2
./rna memory PROJECT_ID write --file /path/to/note.md --title "发布约定"
./rna doctor PROJECT_ID
```

- `health` 验证服务健康、鉴权和初始化状态；`initialize` 明确创建当前项目的远端目录。
- `doctor` 的 `evolution` 段按项目列出进化的状态：三条线（经验转做法、纠正复核、对照分析）此刻在等什么，每条规则被运行或放进回合多少次（从不读自我确认的等级），没有变成规则的经验与纠正的类型化去向，每一代之后被纠正的比例，预测记分板，定时任务在某条规则前后的配对读数，以及最近的对照分析。数据来自只读的 `GET /api/v2/projects/:id/genes/observability`，只含计数与代码。
- `list/browse/search/read` 都访问 OpenViking；`list/browse` 首次访问项目根目录时可自动初始化。搜索使用官方 `search/find` 与 `target_uri`，默认不限制索引层级，返回结果再次按项目范围过滤；显式 `--level` 是索引过滤，不能将摘要变为全文。
- L0 摘要、L1 概览读取目录，L2 全文读取文件。默认 L2 读取 200 行、最多 500 行，并限制内容长度；目录不能直接当成全文文件。
- `write` 将文件内容写入当前项目命名空间，默认新建 UUID 文件；可显式传 `--uri` 与 `--mode create|replace|append|upsert`。写入已接受不代表语义索引已完成。本轮不开放远端删除。
- 已获记忆能力的真实模型会话默认在新轮次关联有预算的候选摘录，再按需调用 `openviking_search`、`openviking_read` 展开目录概览或原文。动态记忆记录到该轮参考上下文，不改变缓存系统前缀；恢复复用已提交快照，关闭自动关联不移除显式读取工具。自动保存独立配置，只登记完成的真实回合，不批量补传全部历史。

默认目录为 `viking://resources/projects/<projectId>`，由项目自动管理，常用界面不展示命名空间编辑项；底层项目 API 仍验证不同项目目录不得重叠。OpenViking `search(mode="context")` 在当前固定版本不支持 `target_uri`，因此没有把它当作可隔离项目的自动上下文注入接口。

OpenViking 会话创建、消息写入、提交和任务查询使用同一宿主服务。创建时关闭服务端自动提交和 self 提取，启用 peer 提取；用户消息绑定固定的项目 peer 身份。自动保存将完成回合登记到持久同步队列，再写入、提交及轮询，未知提交不盲目重复。`task_id` 只表示提取任务已受理，不能据此宣布学习完成。检索同时覆盖项目 resource 目录及已验证身份下的项目 peer 记忆目录，并逐项检查项目边界。新增记忆抽取完成后另行整理目录摘要，任务完成还须核对真实正文；缺失摘要不伪称就绪，原文可继续浏览。

源码依据见 配置与记忆研究。

## 项目与会话管理

项目由真实工作目录确定。侧栏按目录展示项目与其会话，支持折叠、目录内新会话和跨项目搜索；不再通过顶部下拉框管理项目。项目保留用户定义的名称并显示真实路径。目录经过绝对路径、存在性、目录类型和 `realpath` 校验：同目录、尾斜杠或符号链接重开复用原项目 ID、提示词、技能和会话，不重复初始化。历史同目录的多个项目保留并要求明确选择，不合并、不迁移文件夹。新目录首次接入仍由配置模型根据标题与介绍初始化。

“打开项目目录”在 Electron 中调用受限的系统目录选择器，在浏览器中浏览 daemon 所在电脑上的真实目录，也可输入绝对路径或明确新建文件夹。项目目录分组与会话行提供三点菜单，可查看概览、重命名、归档或删除；“已归档”入口可查看、恢复和删除归档记录。菜单支持键盘导航、Escape 关闭与焦点返回。操作其他会话的菜单不切换当前对话；重命名、归档和恢复保留会话草稿。设计依据及兼容边界见 目录与项目。

归档会保留历史与待发送队列，并暂停正在执行的轮次；归档项目还会暂停初始化和项目主动能力。恢复归档只恢复列表可见性，不自动续跑暂停的付费请求或初始化；需要明确继续会话、重试初始化或重新开启主动能力。项目归档期间不能新建会话或向其会话发送消息，内部单独归档的会话也需要先恢复项目。

删除需要界面确认。删除会话会清理聊天记录、附件、会话专属运行文件、相关远端原始会话及可确权的后台原文副本；删除项目会同时处理其中会话。工作区文件和已提取的项目记忆保留，既有迁移备份与人工备份不在本次清理范围。存在未决执行、写入尚未结束或远端清理失败时，状态保持待清理，不删除唯一核对依据或假报完成。删除最后一个会话后项目仍保留，可重新创建会话；已删除记录无法从归档入口恢复。

## CLI 与持续对话

先启动 daemon，再建立带真实工作目录的项目：

```bash
./rna project-new "Rna Agent" "持续改进项目" --workspace /absolute/project/path
./rna project-open /absolute/project/path
./rna projects
./rna new "实现讨论" --project PROJECT_ID
./rna chat SESSION_ID
./rna run SESSION_ID "读取项目入口并解释结构" --jsonl --timeout 300
./rna watch SESSION_ID --jsonl
```

`chat/watch/run` 使用 SSE 订阅，不再轮询会话。`run` 等待自己提交的轮次；会话忙时先排队，不会把前一轮完成当成本次成功。`--jsonl` 输出接受、状态和结果事件。失败、停止或等待超时退出非零；超时与退出订阅不自动停止 daemon 中的工作，可用 `interrupt SESSION_ID` 明确停止。`--` 可分隔选项与以连字符开头的正文。

`project-open` 首次注册目录，之后复用原项目；历史目录若对应多个项目，可用 `--project PROJECT_ID` 明确选择。`project-new --workspace` 使用相同目录身份规则，重开不覆盖旧名称和介绍。不带 `--workspace` 的旧 CLI 用法保留：真实项目创建独立托管工作目录。`new --workspace` 用于指定独立会话工作目录；属于项目的会话继承项目工作区，不能单独改到其他目录。`doctor` 检查 daemon、运行时配置及当前项目的 OpenViking 连接；记忆离线会返回非零退出状态。

会话中的 `steer` 在下一可消费边界影响当前轮，`followup` 留到下一轮。停止当前轮会保留历史并返回未消费消息；停止当前轮不等于停掉项目主动能力。暂停真实请求涉及中断在途生成，恢复时重建后续执行，不承诺恢复供应商生成内部状态。

常用交互命令：

```text
/help
/project
/versions
/initiative on|off|mute|unmute|quiet|resume
/steer 先解释入口，不展开全部文件
/followup 下一轮再看测试
/inbox
/withdraw MESSAGE_ID
/pause
/resume
/stop
/mode plan
/quit
```

外层命令还有 `history/send/steer/followup/interrupt/withdraw/status/events/budget`。`stop/reset` 是全局急停与解除，解除后需显式恢复暂停工作。交互式 TTY `chat` 在实际按键后上报短时输入状态，主动消息等待输入停顿；退出只清理自己的 presence 回执。已有其他可见客户端时让出，全程通过回执条件更新避免覆盖新状态；CLI 本地也会暂缓显示主动消息并保留当前草稿。重定向、管道、`watch/run` 不占用可见会话。终端无法判断操作系统窗口焦点，空闲后不持续续约，其临时回执会自然过期。

## 当前执行与缓存边界

真实执行使用 [`@rna-agent/sdk`](../../packages/sdk/README.md) 的自有会话循环、HTTP/SSE 提供商适配、事件日志和工具账本；不依赖或包装 Pi SDK。内置 project_read/list 支持读取；显式分配 project_write/edit/exec 后可写文件、精确编辑和运行命令。文件修改校验 hash、原子发布；命令有取消、超时、输出截断和完整日志。项目 cwd 与文件路径检查是应用层约束，exec 和 MCP 不是 OS 沙箱。

普通 `project-new`/UI 新建项目会返回 `initialization: queued`，后台由所选模型生成状态、里程碑和能力分配。没有真实模型时保持 blocked，失败可执行 `rna project-init PROJECT_ID` 重试。不会用固定模板冒充模型初始化。`--demo` 明确创建演示项目。已有示例项目与历史会话保留。

侧栏“技能与工具”已接真实项目能力目录，支持安装、分配、移出项目与注销；也可在对话里直接要求安装。模型使用 capability_list/inspect/install/assign/remove，同一轮在工具批次结束后获得新能力。技能目录只含元数据，skill_load 按需读取正文与配套资源。CLI、UI 和模型工具共用安装服务；能力不会隐式分配给其他项目。

```bash
./rna project-capabilities PROJECT_ID
./rna capability-inspect PROJECT_ID /absolute/install.json
./rna capability-install PROJECT_ID /absolute/install.json
./rna capability-assign PROJECT_ID /absolute/assignment.json
./rna capability-remove PROJECT_ID /absolute/removal.json
```

本地/Git技能目录、固定 npm 包、mcpServers 配置和命令工具的 JSON 示例及兼容边界见[安装说明](../../docs/capability-installation.md)。旧 capability-add 仅用于注册已有清单。MCP 环境变量/HTTP 凭据使用引用，安装 npm 不运行 lifecycle scripts；需要这些脚本的原生包可能无法激活。

缓存实现稳定系统前缀与工具顺序、会话 cache key、Anthropic cache_control、DeepSeek usage 以及中断恢复后的上下文连续性。是否命中以 provider 实报为准；没有缓存收益排名结论，没有自动预热。UI/CLI `/compact` 共用实际宿主摘要命令，自动压缩按上下文容量触发；两者均经过预算准入、记录实际用量并保留完整工具批次和原始日志。摘要不会重新执行历史工具，失败不会伪装成压缩成功。
**成本尚未定价。** 自定义模型没有配置真实价格，真实执行的费用状态为 `unpriced`；零价格占位不是免费调用。USD 上限当前只约束模拟账本，不能作为真实金融硬上限。真实调用与演示分别记账，真实每日上限默认不限，可在设置中显式开启；请求先预留再结算，缺失报量时记录估算。模型上下文容量和单次输出上限是另外两个设置。供应商账单校准仍待实现。

## 项目主动性与进化

项目不要求先创建 Goal。可以加入 `context/ci_failure/ci_recovered/preference/research_result/note/conversation` 观察，后台在 work、learn、share、wait 分支之间选择。模型可选择保持安静，事件 ID 去重，主动消息保留触发证据。背景研究与用户回复分离；静音消息、输入礼让、冷却期间，新的研究和进化仍能推进。

```bash
./rna observe PROJECT_ID ci_failure "版本变化后缓存验证失败"
./rna initiative PROJECT_ID mute
./rna initiative PROJECT_ID unmute
./rna initiative PROJECT_ID off
./rna initiative PROJECT_ID on
./rna versions PROJECT_ID
./rna version PROJECT_ID VERSION_ID trial
./rna version PROJECT_ID VERSION_ID rollback
./rna version PROJECT_ID VERSION_ID adopt
```

`mute` 只暂停主动发言；`off` 暂停项目后台；真实项目 `quiet` 只延后发言 30 分钟，后台研究继续，`resume` 解除（旧演示项目仍保留原演示语义）。自主进化开关独立，关闭进化不阻断普通研究。没有证据时不制造工作；关闭 Web 页面后 daemon 仍运行。

后台动作若处于 `needs_review`，先用 `./rna project PROJECT_ID` 查看动作 ID，并实际核对副作用、输出与残留进程，再显式记录结果：

```bash
./rna initiative-resolve PROJECT_ID ACTION_ID --status completed --summary "已核对动作结果及相关进程，结果完整且进程已退出"
# 只有确认动作未执行时，才改用 --status not-executed。
# 已执行部分工作、已核对终止但结果未验证时，使用 --status cancelled，不能声称从未执行或已成功。
```

对应接口为 `POST /api/projects/:id/initiative/actions/:actionId/resolve`，JSON 包含 `status: "completed" | "not-executed" | "cancelled"` 和非空 `summary`（最多 16000 字符）。`cancelled` 单独保存核对说明和原诊断/部分结果，不表示成功或未执行。确认只记录核对结果，不重放原动作，也不会启用已暂停的主动能力；普通聊天“继续”或 `initiative resume` 不会替代这项确认。非待核对动作返回 409，项目仍有运行/未清理操作时返回 409 `action_still_running`，缺少说明返回 400。运行项目仍存在未决执行阻挡时，健康检查返回 `executionBlocked: true`、`autonomyDegraded: true` 与 `ok: false`，不会将这段时间计作持续健康运行。

初始化完成的真实项目由 ProjectInitiativeController 调用配置模型，读取项目状态、已消费发言、完成轮次、人工观察与后台结果。首次复查默认等待 45 秒，后续新证据触发判断；时钟仅复查，默认空闲复查窗口为 30 秒至 15 分钟，故障另有退避。关闭浏览器不停止 daemon。后台默认只读；用户明确选择继承项目权限后，仍受该权限上限及已分配工具约束，不获得前台能力安装管理入口。消息投递再次校验输入、正在回复、静音、冷却和项目状态；自身发言不会制造无限新事件。

项目设置可调整启用、通知、输入礼让、复查窗口、发言冷却、自动进化最小间隔和 token 预算；真实项目不再显示模拟 USD 或无效相关度滑块。用量与全局预留额度共同限制后台请求，恢复未知在途动作不盲目重放。研究依据与实际调用链见Headlong 接入。

learn 使用配置模型产生完整项目能力包，实际执行脚本检查，并在临时工作区对基线和候选运行冻结案例、检查执行约束和进行匿名评分；通过全部门槛才允许试用。失败、拒绝和中断都保留证据，不更改当前版本。评分结论只适用于当前有限用例；不是普适能力提升的证明。旧演示项目的合成评测和 check 命令仅验证示例策略。旧 autonomy/goals/goal 脚本保留兼容。

## API 摘要

写操作使用 JSON，DELETE 也需空 JSON 对象。接口是当前本机协议，尚无远程认证或通用乐观并发版本参数。

| 接口 | 用途 |
|---|---|
| `GET /api/health`, `/api/state`, `/api/events` | 运行模式、脱敏状态与事件 |
| `GET /api/stream?session=ID` | SSE `event:state`，`data:{revision,session}`；连接时发送最新状态 |
| `GET/POST /api/projects` | 列表、新建项目及首个会话 |
| `PATCH /api/projects/:id` | 项目文本、initiative、evolution、memory.namespace，以及 `{archived:true|false}` |
| `DELETE /api/projects/:id` | 删除项目并清理所属会话原文及专属日志；保留工作区和已提取项目记忆，待清理状态见响应 |
| `POST /api/projects/:id/observations` | `{kind,text,eventId?,relevance?,data?}`；同 ID 去重 |
| `POST /api/projects/:id/presence` | `{sessionId,typing,visible,expectedReceiptId?}`；返回短时 `receiptId`，条件不匹配返回 `409`；不带条件的旧 Web 请求保持兼容 |
| `POST /api/projects/:id/versions/:versionId/control` | `trial/rollback/adopt`；真实项目验证候选、基线及评估记录，旧演示策略独立 |
| `GET /api/projects/:id/capabilities` | 安装目录、来源版本、项目能力分配 |
| `POST /api/projects/:id/capabilities/inspect`, `/install`, `/assign`, `/remove` | 同对话工具与 CLI 的能力管理事务 |
| `GET/POST /api/sessions`, `GET/PATCH /api/sessions/:id` | 会话、`modelSelection:{providerId,modelId,reasoning}` 与 `{archived:true|false}` |
| `DELETE /api/sessions/:id` | 删除会话并启动专属原文清理，返回 `cleanup` 状态；未完成时返回 202 |
| `POST /api/sessions/:id/messages` | `{text,delivery?,requestId?,attachments?:[{id}]}` → `{session,queued,entry}` |
| `POST /api/sessions/:id/control` | `pause/resume/stop/compact`，真实执行支持情况见上文 |
| `DELETE /api/sessions/:id/inbox/:messageId` | 撤回未消费消息 |
| `GET/PATCH /api/configuration` | 脱敏提供商、默认模型、唯一 OpenViking 配置 |
| `POST /api/providers`, `PATCH/DELETE /api/providers/:id` | 供应商与模型目录；使用中的模型不得移除 |
| `POST /api/providers/:id/test` | 目录探测，不调用生成接口 |
| `GET /api/projects/:id/memory` | OpenViking 列表，有 query 时搜索 |
| `POST /api/projects/:id/memory/search` | `{query,level?,limit?}` |
| `POST /api/projects/:id/memory/browse` | `{uri?,limit?}`；首次根目录浏览可自动初始化 |
| `POST /api/projects/:id/memory/read` | `{uri,level?}` |
| `POST /api/projects/:id/memory/health`, `/initialize` | 验证连接、显式创建项目目录 |
| `POST /api/projects/:id/memory/write` | `{content,title?,uri?,mode?}`；真实远端写入 |
| `POST /api/projects/:id/memory/sessions` | `{sourceSessionId?}`；创建独立远端会话，不上传历史 |
| `POST /api/projects/:id/memory/sessions/:remoteId/messages` | `{messages:[{role,content,sourceMessageId?}]}` |
| `POST /api/projects/:id/memory/sessions/:remoteId/commit` | `{keepRecentCount?}`；归档并启动提取 |
| `GET /api/projects/:id/memory/sessions/:remoteId/tasks/:taskId` | 查询本项目已提交提取任务 |
| `PATCH /api/settings`, `POST /api/emergency` | 调度预算、并行设置、全局急停 |

历史本地记忆按 UUID 修改/删除的接口返回 `410`。项目会话/提取任务绑定远端 endpoint；切换服务后不能把旧远端会话 ID 用到新服务。

项目和会话列表包含归档记录，使用 `archivedAt` 时间或 `null` 判断状态；会话还需结合父项目的归档状态。直接写入 `archivedAt` 或传入非布尔 `archived` 会被拒绝。归档资源的执行操作返回 `409`，已删除资源返回 `404`。

## 持久化、验证与后续工作

默认状态为 `.state/state.json`，原子写入并保留已有迁移备份；凭据单独存储。Rna 的 hash-chain JSONL 与控制平面投影分开；旧 Pi 日志不会作为 Rna 格式读取，重启时未完成执行暂停，不自动向付费模型重放全部历史。记忆同步、目录摘要及会话删除已有持久任务和恢复状态；当前同步 JSON 控制面仍不是通用数据库事务系统或分布式 worker。

```bash
./rna test
.runtime/node/node_modules/node/bin/node --test test/runtime-cli.test.mjs
.runtime/node/node_modules/node/bin/node qa/browser-smoke.mjs
.runtime/node/node_modules/node/bin/node qa/proactivity-smoke.mjs
.runtime/node/node_modules/node/bin/node qa/settings-smoke.mjs
.runtime/node/node_modules/node/bin/node qa/lifecycle-smoke.mjs
```

后端测试使用独立临时 daemon、真实 CLI 子进程、自有 Rna SDK 与 HTTP 协议夹具；浏览器测试使用隔离的 headless Chrome。它们不写用户的 4317 状态。测试总数和最新结果统一见 验证记录，HTTP 夹具不代表模型质量；官方 OpenViking Docker 的独立验证见根目录文档。

`desktop/main.cjs` 是可选 Electron 壳源码，已使用 macOS 上实际安装的 Electron 38.1.1、独立 profile 和临时 daemon 验证生产 main/preload、文件与聊天分屏、真实 ES 模块运行、窗口隔离和预览打开 IPC。桌面“在浏览器打开”只接受当前应用主窗口请求，重新核对该项目已就绪的完整预览地址；其他弹窗仍拒绝。验收以主进程记录器替代系统浏览器启动，未干扰用户默认浏览器，见 桌面报告 与 截图。可用已安装的 Electron 运行 `electron desktop`；先启动 daemon，`RNA_AGENT_PORT` 可指定其端口。Electron 不随源码捆绑，尚未完成应用打包、代码签名、daemon 生命周期或自动升级验证。

主动协调、skills/MCP、候选对照、真实预算与恢复核对已接入产品；后续重点是更广的真实项目观察源、经过实测的浏览器工具安装链、独立质量保留集与发行能力。参见 [项目主动系统](../../docs/specs/project-proactive-system.md)、[进化规格](../../docs/specs/evolution-and-evaluation.md)、[开发排期](../../docs/planning/roadmap.md)。

## 项目能力版本（0.9）

新项目使用配置模型和独立工作目录初始化；失败保留实际诊断，不生成假基线。项目概览可以查看系统提示词、技能与工具脚本；版本页显示真实评测结果，并支持编辑完整能力包 JSON。

```sh
./rna genome PROJECT_ID > project-genome.json
./rna evolve PROJECT_ID project-genome.json
./rna versions PROJECT_ID
./rna version PROJECT_ID VERSION_ID trial
./rna version PROJECT_ID VERSION_ID adopt
./rna version PROJECT_ID VERSION_ID rollback
```

编辑或自动生成候选使用同一个评测器；新标准只在新版本中保存，本次评测仍使用冻结的旧标准。试用与采用从下一轮生效，已有运行和暂停恢复保持原版本。生成能力不能作为普通全局插件跨项目分配。
