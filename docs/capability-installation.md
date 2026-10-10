# Rna Agent 能力安装与运行

适用于 Rna SDK **0.4.0**、控制平台 **0.10.0**。本文依据本仓库实现和隔离端到端测试，说明当前已经接入的行为。需要 Node ≥22.19.0；Git、npm 来源分别还需要本机可用的 Git、npm。

能力目录由 daemon 管理，项目保存自己的 `skillIds`、`toolIds`、`mcpServerIds` 分配。安装到目录、启用实现、分配给项目是三个不同状态。安装时 `activate:true` 会启用并分配给当前项目；省略或设为 `false` 只安装，随后可显式分配。其他项目的权限不会随之增加。

## 从对话使用

在已配置真实模型的项目会话中，可以直接说明来源和用途，例如：

> 请将 `/absolute/path/to/my-skill` 中的完整技能安装到当前项目，检查来源后启用。根据任务需要读取 SKILL.md 和它引用的资料，再继续当前讨论。

前台项目会话常驻以下管理工具；它们与界面、CLI、HTTP API 调用同一安装服务。

| 工具 | 用途 | 是否改变项目或目录 |
| --- | --- | --- |
| `capability_list` | 查看可用目录和当前项目分配 | 否 |
| `capability_inspect` | 检查来源格式或元数据 | 否，不启动 MCP |
| `capability_install` | 安装完整能力，按 `activate` 决定是否启用 | 是 |
| `capability_assign` | 将已安装能力或内置工具分配给当前项目 | 是 |
| `capability_remove` | 移出项目，或注销未被其他项目使用的能力 | 是 |

一次模型响应中的当前工具批次执行完后，SDK 在下一次模型请求前同时刷新工具声明、实现和技能目录。因此可以在同一轮中完成“安装 → 读取新技能/调用新 MCP → 回答”，无需重开会话。尚在执行的工具调用使用它已经持有的实现；新能力不会插入当前批次的中间。

普通项目写入与命令执行工具仍需项目明确分配，例如：

```json
{
  "toolIds": ["project_write", "project_edit", "project_exec"],
  "reason": "当前项目需要保存、修改并运行本地代码"
}
```

管理工具是用于配置能力的独立入口，不代表项目自动取得普通文件写入或任意命令工具。后台主动研究不携带这些管理工具；后台默认只读，仅用户明确选择“使用项目权限”时可在已分配能力范围内继承项目权限。

## 界面入口

选择项目后打开“技能与工具”，点击“安装能力”。来源下拉框提供本地技能目录、Git 技能、npm MCP 服务、MCP JSON 导入和官方浏览器预设。可先“检查来源”，再选择“安装并启用”或取消勾选后“仅安装”。浏览器预设查找已安装 Chrome/Chromium、固定官方版本并实际启动和截图验证后再发布，无需 API 密钥；不会接管个人浏览器。

目录区可按技能、MCP、工具筛选，查看当前项目使用状态、MCP 已发现工具和权限。已有能力可“用于此项目”或“移出项目”；非内置能力可“注销”，界面会确认注销范围。

当前界面启用普通新 MCP 时，会显式采用 `toolPermission:"exec"`。若导入配置没有 `allowTools` 限定，本次发现的工具获得执行权限，界面会显示这一含义；配置显式给出 `allowTools` 时，它就是完整授权边界，其余工具不会被额外授予权限。空对象 `{}` 表示不授予任何工具。浏览器预设例外：使用固定、经过验证的工具白名单，不允许覆盖成只读或导入任意执行工具。若普通 MCP 只需特定工具，可在界面导入的 MCP JSON 中填写 `allowTools`，或通过下文 API、CLI、对话工具精确声明。

npm 技能包和通用 JSON stdin 命令工具目前通过对话、CLI 或 API 安装；界面可以显示与分配已经安装的这些能力，尚无专门的来源表单。

## CLI 与 HTTP API

从仓库中的控制平台目录运行：

```sh
cd prototypes/control-center
./rna start
./rna projects
./rna project-capabilities PROJECT_ID
./rna capability-inspect PROJECT_ID /absolute/install.json
./rna capability-install PROJECT_ID /absolute/install.json
./rna capability-assign PROJECT_ID /absolute/assign.json
./rna capability-remove PROJECT_ID /absolute/remove.json
```

`PROJECT_ID` 替换为实际项目 ID。参数是 JSON 文件路径，不是内联 JSON，也不需要 `--file`。CLI 默认连接 `127.0.0.1:4317`，可用 `RNA_AGENT_PORT` 选择另一个本机 daemon。JSON 文件必须为不超过 60 KB 的普通文件；示例中的绝对路径须替换为当前机器的路径。

| HTTP 方法与路径 | 请求体 |
| --- | --- |
| `GET /api/projects/:id/capabilities` | 无；返回目录、安装记录、当前项目分配和 revision |
| `POST /api/projects/:id/capabilities/inspect` | 安装描述 |
| `POST /api/projects/:id/capabilities/install` | 安装描述，可加稳定的 `requestId` |
| `POST /api/projects/:id/capabilities/assign` | 分配描述 |
| `POST /api/projects/:id/capabilities/remove` | 移除描述 |

例如将后文任一安装描述保存为 `install.json`：

```sh
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  --data-binary @install.json \
  'http://127.0.0.1:4317/api/projects/PROJECT_ID/capabilities/install'
```

API 限本机 daemon，检查 Host/Origin，写入请求要求 `application/json`。错误以非 2xx 状态和 `{ "error": "原因" }` 返回；调用方应检查 HTTP 状态。来源检查中找不到目录返回 404、无法读取返回 403、非法权限声明返回 400；其他项目仍引用能力而无法注销时返回 409。不要把安装失败当成已经获得能力。

## 安装描述示例

下面的本地路径、Git 仓库与 npm 包名是示例占位符；不会宣称某个第三方包已经兼容。先以实际来源执行 `inspect`，再安装并核验连接。

### 本地技能：保留整个 bundle

目录结构可以是：

```text
my-skill/
  SKILL.md
  references/
    guide.md
  scripts/
    helper.mjs
  assets/
    template.txt
```

`SKILL.md` 示例：

```markdown
---
name: project-review
description: 核对项目约束并引用配套审查资料
---
执行审查前按需读取 references/guide.md。基于实际证据报告结果。
```

安装描述：

```json
{
  "kind": "skill",
  "id": "project-review-v1",
  "source": {
    "type": "local",
    "path": "/absolute/path/to/my-skill"
  },
  "activate": true,
  "reason": "用于当前项目审查"
}
```

本地来源接受技能目录或其中的 `SKILL.md` 文件路径，复制其完整所在目录。`references`、`scripts`、`assets` 等资源随包保存；安装不会执行技能脚本。`.git`、`node_modules`、`.DS_Store` 不复制；符号链接、特殊文件、超过 10,000 个目录条目或 32 MiB 的 bundle 被拒绝。安装后的 bundle 与来源目录分离，后续修改来源不会自动更新已安装版本。

### Git 中的技能目录

```json
{
  "kind": "skill",
  "id": "review-git-v1",
  "source": {
    "type": "git",
    "repository": "https://github.com/your-org/agent-skills.git",
    "ref": "v1.2.3",
    "subdirectory": "skills/project-review"
  },
  "activate": true
}
```

`repository` 支持无内嵌凭据的 HTTPS URL 或绝对本地 Git 仓库路径；`ref` 可为可获取的分支、标签或提交，省略时使用默认 HEAD。安装记录保存实际 commit。子目录必须位于仓库内并包含 `SKILL.md`。`inspect` 对 Git 只检查描述格式，不下载或验证仓库内容；实际下载与校验发生在安装阶段。当前无 SSH URL、交互认证或 Git 凭据配置界面。

### npm MCP 服务

```json
{
  "kind": "mcp",
  "id": "project-docs-mcp",
  "source": {
    "type": "npm",
    "package": "@your-org/your-mcp-server@1.2.3",
    "bin": "your-mcp-server",
    "args": ["--workspace", "/absolute/project/path"],
    "env": { "SERVICE_TOKEN": "${PROJECT_DOCS_TOKEN}" }
  },
  "activate": true,
  "allowTools": {
    "search_docs": { "permission": "read", "idempotent": true }
  }
}
```

用该服务真实的包名、bin、启动参数和工具名替换示例值。只有一个 bin 时可省略 `bin`；多个 bin 必须明确选择。`allowTools` 中的名字必须实际存在于服务 `tools/list` 返回值中，否则激活失败。显式 `allowTools`（包括 `{}`）始终是完整授权边界。只有未给白名单时，`toolPermission:"exec"` 才用于明确授权本次发现的全部工具；两者均省略则不授予工具。之后服务新增加的工具不会自动获得权限，服务自报的 `readOnlyHint` 也不能代替明确授权。

npm 版本范围或标签在安装时解析为准确版本，随后使用 `--save-exact` 和 lockfile 安装并核对版本及可用的 integrity。对话中启动的是保存好的本地入口，不会每轮重新运行 `npx` 下载包。可用 `source.registry` 选择 HTTPS 包源或本机 HTTP 测试包源；URL 不接受内嵌用户名、密码、查询或片段。

### npm 技能包

```json
{
  "kind": "skill",
  "id": "review-npm-v1",
  "source": {
    "type": "npm",
    "package": "@your-org/agent-skills@1.2.3",
    "subdirectory": "skills/project-review"
  },
  "activate": true
}
```

包内子目录应有 `SKILL.md`；目录复制规则与本地技能一致。技能不要求 npm 包具有可执行 bin。

### 常见 mcpServers JSON 导入

```json
{
  "kind": "mcp",
  "source": {
    "type": "mcp-config",
    "config": {
      "mcpServers": {
        "local-docs": {
          "command": "node",
          "args": ["/absolute/path/to/mcp-server.mjs"],
          "cwd": "/absolute/project/path",
          "env": { "SERVICE_TOKEN": "${PROJECT_DOCS_TOKEN}" },
          "allowTools": {
            "search_docs": { "permission": "read", "idempotent": true }
          }
        },
        "remote-docs": {
          "type": "streamable-http",
          "url": "https://mcp.example.com/mcp",
          "headers": { "Authorization": "${REMOTE_MCP_AUTHORIZATION}" },
          "allowTools": {
            "lookup": { "permission": "read", "idempotent": true }
          }
        }
      }
    }
  },
  "activate": true
}
```

支持 1–30 个服务。HTTP 示例地址须替换为实际的 Streamable HTTP MCP 地址。stdio 的可执行名会解析成本机路径；参数按数组传递，不经过 shell。现有命令和脚本引用其原有路径，安装器不会复制该外部程序，因此原文件需要持续可用。

常见 `"command":"npx", "args":["-y","package@version", ...]` 形式会转换为前述固定版本 npm 安装。当前只解析这一常见形式，不提供完整 npx 参数兼容。服务配置中的 `disabled:true` 或 `enabled:false` 在导入时仍保持停用，即使外层设置 `activate:true` 也不会启动它。

MCP 项目授权同时保存服务 ID 和具体工具 ID，例如 `mcp:local-docs:search_docs`。模型端工具名为 `mcp__local-docs__search_docs`。有服务连接不等于拥有该服务全部工具。

### 通用命令工具：JSON stdin/stdout

这类工具运行一次命令来处理一次调用，不使用 MCP 协议。先准备一个本机程序，例如保存为 `/absolute/tools/echo-json.mjs`：

```js
let input = '';
for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(input);
process.stdout.write(JSON.stringify({ echoed: args.text }));
```

安装描述：

```json
{
  "kind": "tool",
  "id": "echo-json",
  "name": "回显 JSON",
  "description": "将 text 参数作为 echoed 返回",
  "permission": "exec",
  "idempotent": false,
  "parameters": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"],
    "additionalProperties": false
  },
  "source": {
    "type": "command",
    "command": "node",
    "args": ["/absolute/tools/echo-json.mjs"],
    "cwd": "/absolute/project/path"
  },
  "activate": true
}
```

参数先通过声明的 JSON Schema 校验，再作为一行 JSON 写入进程 stdin；stdout 必须整体构成一个 JSON 值，诊断请写 stderr。默认执行超时 30 秒，收集输出上限 1 MiB。配置保存权限和幂等性声明；`idempotent:true` 必须符合程序真实行为。也可用 `kind:"tool"` 搭配 npm 来源安装提供 bin 的 JSON stdin 程序；它必须满足这一协议，不会自动适配任意 CLI。

## 凭据引用

`env`、`headers` 中的凭据值只接受完整的 `${ENV_NAME}` 引用，不接受明文或拼接模板。HTTP 的 `headerEnv:{"Authorization":"REMOTE_MCP_AUTHORIZATION"}` 是另一种等价写法。环境变量必须存在于**运行 daemon 的进程环境**；修改另一个终端的变量不会改变已启动 daemon 的环境。

若服务要求 `Authorization: Bearer …`，环境变量值需包含完整的 `Bearer ` 前缀，例如 JSON 中只保留 `"Authorization":"${REMOTE_MCP_AUTHORIZATION}"`。不要在 JSON 中写 `"Bearer ${TOKEN}"`，当前不进行这种模板展开。stdio 的 `envNames` 也可显式引用同名变量。

安装配置保存变量名称，不保存上述引用变量的值；命令工具结果会对显式引用的凭据做脱敏。凭据引用不保证第三方程序不会在其他位置输出或存储敏感信息，不能将第三方输出视为可无条件公开的数据。当前没有 MCP OAuth 登录、授权回调或自动刷新令牌流程。

## 分配、移除和更新

已安装但未启用的能力可分配到某个项目：

```json
{
  "skillIds": ["project-review-v1"],
  "mcpServerIds": ["local-docs"],
  "activate": true,
  "allowTools": {
    "search_docs": { "permission": "read", "idempotent": true }
  },
  "reason": "当前项目需要审查技能和资料检索"
}
```

分配是增量添加，不会用这份输入替换项目全部现有分配。MCP 分配会重新连接并发现目录；所列工具必须仍存在。`allowTools` 适用于请求中的 MCP 服务；不同服务需不同工具白名单时，分别提交分配请求。

移出当前项目：

```json
{ "kind": "skills", "id": "project-review-v1" }
```

也可用返回的 `installationId` 一次移出该安装的所有条目：

```json
{ "installationId": "install-REPLACE_WITH_ACTUAL_ID" }
```

若要从全局可用目录注销，再添加 `"uninstall":true`。其他项目仍引用任何相关条目时会拒绝注销；内置能力不能全局注销。普通能力保留在途调用持有的实现。受管浏览器预设撤销时会关闭它持有的会话连接；未知外部操作不能据此推断已回滚。安装文件保留，不删除工作区或远端数据。此版本没有已保留安装文件的自动垃圾回收接口。

能力 ID 不允许覆盖已有条目。更新时使用新 ID 安装新版本，核验后调整项目分配；或先确认无人使用再注销旧 ID。npm 版本或 Git commit 会记录在新安装记录中，不能将修改来源目录当作更新已经复制的技能。

内置 `project_write`、`project_edit`、`project_exec` 等工具也可在界面显式启用或移出项目。通过 API/CLI 撤销执行权限的描述为 `{ "kind":"tools", "id":"project_exec" }`，使用同一 `remove` 接口。内置工具可以撤销项目分配，但不能用 `uninstall:true` 全局注销；调用会返回 409。撤权在后续模型请求边界生效，不以删除安装目录代替权限修改。

## 安装事务与失败恢复

安装采用独立代际目录，默认位于 `${stateFile}.capabilities`：

1. 在私有 `.pending-*` 目录准备完整文件、npm lockfile 和描述。
2. 校验 manifest、工具名冲突、技能内容及显式 MCP 激活；激活 MCP 会启动或连接服务并读取目录。
3. 将准备好的目录提交为不可变的安装代际，再在一次 Store 修改中发布目录与项目分配。
4. 保存安装事务记录。已确认未发布的失败会回滚准备目录，不向项目发布半套能力。

同一 daemon 的安装管理请求串行发布，防止并发覆盖分配。HTTP/UI 可使用稳定 `requestId`；同项目、同 requestId、同安装内容成功重试会返回已提交安装，不重复安装。更换内容应使用新的 requestId。安装工具自身也以调用 ID 和参数摘要建立请求标识。

非法路径、参数错误和已确认回滚可作为普通工具错误返回，模型能在同一轮修正再试。若写入结果无法确认，SDK 将其标为未决操作，不能靠自动重复安装推断安全。跨文件系统目录和 Store 文件不构成数据库式的跨文件原子事务；异常断电可能留下需要检查的事务记录或未引用目录。`not-published` 也只描述本地安装发布状态，不能撤销第三方服务在启动/握手时产生的外部副作用。

## 按需技能与缓存

技能分配后，模型先收到包含 `id`、`name`、`description`、`contentHash` 的动态目录附件。全文不拼进稳定 system 提示词。目录不变时不会在每次请求中重复追加；能力变更在下一个请求边界更新目录与工具 schema。

需要某技能时调用：

```json
{ "id": "project-review-v1" }
```

以上是 `skill_load` 的参数，默认读取 `SKILL.md`。读取相对资料：

```json
{
  "id": "project-review-v1",
  "path": "references/guide.md",
  "offset": 0,
  "limit": 100
}
```

`offset` 从 0 开始按行计数，默认 `limit` 为 200，最大 500 行；单次内容最多 30,000 字符，目标文件最大 512 KiB。返回哈希、分页信息与 `truncated`。仅允许当前项目已分配技能包内的相对路径，绝对路径和越出包目录的引用会拒绝。读取脚本只是读取文本，不执行脚本，也不提升权限。

这种组织方式使稳定系统上下文不随技能正文膨胀，并保留可复用的历史前缀。新增/删除工具会改变提供商请求中的工具 schema，动态目录和后续消息也会改变部分前缀；不能保证某一变更仍命中提供商缓存。界面显示的缓存用量以提供商实际返回为准，不能以目录哈希或本地上下文估算代替账单 token 或命中统计。

## 兼容范围与验证

| 场景 | 当前行为 |
| --- | --- |
| 本地/Git/npm 技能 | 保存完整允许的 bundle；按需读取正文与相对资料 |
| stdio MCP | 支持初始化、发现、调用、取消；每项工具需明确授权 |
| Streamable HTTP MCP | 支持 HTTP MCP 地址与引用请求头；远端要求 HTTPS，本机可 HTTP |
| 旧式 SSE MCP | 不支持；导入会拒绝 `type/transport: "sse"` |
| npm 安装脚本 | 始终 `--ignore-scripts`；依赖 native/postinstall 构建的包可能无法激活 |
| npm 自定义镜像/私有包 | 可指定合规 registry URL；未提供交互登录或凭据管理流程，不能假定所有私有源可用 |
| MCP OAuth | 未实现登录、回调或令牌刷新；需提供服务已支持的静态凭据引用 |
| 第三方进程隔离 | 不是 OS 沙箱；本地 MCP、命令工具与 `project_exec` 可运行当前用户权限下的代码 |
| workspace 读写工具 | 应用层路径、私有目录、符号链接与大小约束；不等价于进程级隔离 |
| 已注册能力更新 | 新代际/新 ID 显式切换；不热改在途调用，不自动删除旧文件 |
| 内置演示模型 | 用于演示；真实安装与工具循环的模型决策需要已配置的真实模型 |

已通过本机隔离夹具验证的路径包括：HTTP 流式模型同轮修复失败安装、完整技能及相对资源读取、系统前缀稳定、stdio MCP 导入后下一步调用、未授权工具不暴露、显式分配后写入/编辑/执行、项目间授权隔离，以及 CLI/API 共享安装与移除事务。后台另验证混合 MCP 服务仅暴露只读授权，项目作用域变化会取消旧结果。

验证源码：[对话与 CLI 端到端](../prototypes/control-center/test/capability-conversation.test.mjs)、[安装服务](../prototypes/control-center/test/capability-install-service.test.mjs)、[主动控制器](../prototypes/control-center/test/project-initiative-controller.test.mjs)。实现入口：[安装器](../packages/sdk/src/capability-installation.mjs)、[宿主安装服务](../prototypes/control-center/capability-install-service.mjs)、[动态运行时](../prototypes/control-center/rna-runtime.mjs)、界面。这些验证使用临时目录和本地 provider/MCP 夹具，不代表所有外部服务或 npm 包都已验证。
