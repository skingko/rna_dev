# Rna Agent 的真实语义记忆部署

本文是 OpenViking 语义记忆的部署说明。没有 Docker 的机器可以在「设置 → 记忆」改用[本地记忆（内置）](embedded-memory.md)，它不需要本文的任何部署。OpenViking 方式的默认部署必须使用真实训练的 embedding 模型和真实文本模型；缺少模型配置时直接失败，不再自动生成哈希向量或固定摘要。Docker 的数据卷属于 OpenViking 服务存储，不是应用层本地记忆回退。

## 模型和存储身份

| 部件 | 固定配置 |
| --- | --- |
| OpenViking | `ghcr.io/volcengine/openviking:v0.4.21.1@sha256:13a78525aa255f0cdb026bfdc1ab8c3a9b2baa49148aa10df061e6c2b689c15f` |
| 本地推理运行时 | `ollama/ollama:0.34.4@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551`，包含 Linux arm64/amd64 |
| macOS 原生运行时 | 官方 `ollama-darwin.tgz` 0.34.4，完整 SHA-256 `e9c8fddaab5f48f47f2c4ae3d23d0732f5182417125353faeed2188e34a22799`；由受管 helper 包装 |
| Embedding | BAAI BGE-M3，1024 维 dense 向量；Ollama 模型 manifest `sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab` |
| 文本摘要、记忆提取 | 私有配置指定的真实 OpenAI 兼容文本模型，可复用已配置的 DeepSeek |
| 服务容器 | `rna-openviking-semantic`、`rna-openviking-embedding` |
| 数据卷 | `rna-openviking-semantic-bge-m3-1024-790764642607` |
| 模型权重卷 | `rna-openviking-models-bge-m3-790764642607` |
| 私有配置目录 | `deploy/openviking/.runtime/semantic/` |

BGE-M3 是训练过的多语种模型，支持中文及最长 8192 token 文本；当前集成仅使用其 dense embedding，不声称启用了全部稀疏和多向量能力。约 1.2 GB 权重在首次准备时下载到独立模型卷，在 CPU 上推理。来源：[模型页](https://ollama.com/library/bge-m3)、[原作者模型说明](https://huggingface.co/BAAI/bge-m3)、[Ollama CPU Docker 部署](https://docs.ollama.com/docker)。实际官方 OpenViking 0.4.21.1 镜像已有 `local` provider，但没有 `llama_cpp`；本部署通过其官方 OpenAI-compatible embedder 使用 Ollama `/v1` 接口，没有自行替换 OpenViking 的语义实现。

配置、数据卷名称和卷内 `rna-model-identity.json` 同时固定模型、维度和 manifest。启动前校验已下载 manifest；不符则停止。不能仅修改 `dimension` 或用另一个 1024 维模型复用索引。更换 embedding 必须使用新的部署身份和数据卷，通过原文重新建立向量。旧 `rna-openviking-data` 的 64 维测试索引原样保留，不挂到真实服务上。

文本模型用于摘要、分类和结构化记忆提取。选择 DeepSeek 文本模型不等于具备图像理解；图像等多模态能力必须另行配置和验证。下载权重及本地 embedding 不消耗远端模型额度，但摘要、提取与检索中的文本模型请求可能产生费用。

## 私有配置与候选准备

先将 `models.json` 写入 `.runtime/semantic/`，目录权限 `0700`、文件权限 `0600`。文件仅允许 `vlm` 字段；密钥从现有私有配置读取，不能提交到仓库、输出到日志或作为命令行参数。

```json
{
  "vlm": {
    "provider": "openai",
    "api_base": "https://api.deepseek.com/v1",
    "api_key": "从私有凭据来源填写",
    "model": "已向供应商确认可用的真实模型 ID",
    "timeout": 120,
    "max_tokens": 4096,
    "max_retries": 1,
    "max_concurrent": 2,
    "extra_request_body": {"thinking": {"type": "disabled"}}
  }
}
```

默认流程不提供假模型兜底。配置要求 HTTPS 文本模型地址，embedding 仅通过专用 Docker 网络访问，不发布主机端口。

摘要与记忆提取使用非思考模式。DeepSeek 官方 API 默认开启思考；OpenViking 0.4.21.1 的通用 `thinking=False` 不会为 DeepSeek 设置请求开关，必须经 `extra_request_body` 传入 `thinking.type=disabled`。部署器为官方 DeepSeek endpoint 的 `deepseek-flash` / `deepseek-v4-pro` 自动补齐此设置；显式 extra body 也只接受上例，不允许覆盖模型或预算。依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

2026-09-24 首轮真实验收发现五篇资料目录的 L0/L1 正文为空，sidecar 元数据却记录五篇全部处理、零待更新，语义队列也报告成功。实际镜像的 OpenAI backend 将空 `message.content` 转为空串，目录处理器随后把空摘要持久化；不会因缺少最终文本而报错。该次历史请求没有保留逐请求 finish reason，不能断言它一定耗尽 4096 token。非思考配置后的重建必须仍通过正文长度和主题覆盖验收，不能只检查队列完成或 HTTP 成功；结果见真实 QA 报告。

```sh
# 只写私有 ov.conf 与模型身份文件，不访问 Docker 或模型
python3 scripts/openviking-local.py configure

# 独立候选：下载、验证真实权重，启动新容器，检查 embedding，创建新租户
# 不占用 1933，不停止旧容器、不修改原 relay 和原凭据
python3 scripts/openviking-local.py prepare --desktop-relay
```

Docker Desktop 兼容模式将所有 Compose、cp 和候选 HTTP 请求固定到 `docker.raw.sock` 和绝对 Docker 可执行文件，忽略 shell 的 `DOCKER_CONTEXT`、`DOCKER_HOST` 等切换。正常 Docker 环境省略 `--desktop-relay`。

`prepare` 通过 `docker exec` 在明确的新容器中调用官方 HTTP API，不会把 root 凭据发送给主机上可能已有的 1933 监听者。新租户为 `rna-local` / `rna-agent`，其凭据保存在私有 `rna-client.json`；root key 仅用于管理，Rna 使用租户 key。候选健康检查会运行真实本地 embedding，但不会主动上传历史会话或调用文本模型进行摘要。候选通过并不意味着实际记忆质量已经验证；还需要真实语义 E2E。

## 迁移和正式切换

迁移须由服务协调者暂停写入并保存耐久观测，然后使用官方备份/恢复接口导出原文、排除旧 vectors，在新租户中重建索引。不得直接复制旧向量库或覆盖旧卷。迁移脚本为 `scripts/migrate-openviking-semantic.py`；检查其参数及报告后执行。只有校验迁移和真实语义 E2E 后才能切换 Rna 的租户 key 与 relay descriptor，恢复写入并开启新的耐久观测。旧服务、旧租户和旧卷保留，回退时也必须保持其模型身份一致。

使用 Docker Desktop relay 时：

```sh
# 只生成新私有 relay.json/relay-helper.json，不启停进程
python3 scripts/openviking-local.py configure-helper

# 在迁移完成后由服务协调者执行；会替换已安装 helper 列表
./prototypes/control-center/rna service restart --helper-descriptor /绝对项目路径/deploy/openviking/.runtime/semantic/relay-helper.json
```

新 descriptor 仍监听 `127.0.0.1:1933`，但目标为 `rna-openviking-semantic`。必须先由 Rna 的服务管理器关闭旧的受管 relay，不能并行争用端口，也不能根据旧 PID 文件任意杀进程。普通 Rna service start/restart 保留 helper 配置；`--without-helpers` 是明确移除指令。

正常 Docker 端口模式在确认 1933 可用后运行：

```sh
python3 scripts/openviking-local.py start
```

该命令在默认 Compose 上显式增加 `compose.direct.yaml` 的 loopback 端口。`prepare` 永远不增加它。`stop`、`down` 仅操作所选 Compose 项目；`down` 不删除 named volumes。`restart` 应在完成依赖配置核对后使用。新旧实例的控制命令不混用。

### macOS 原生 embedding

macOS 可使用官方原生 Ollama 和 Metal，避免下载 Docker 镜像中与本机无关的大型 GPU 库。OpenViking 仍运行官方容器，语义模型、manifest 和 1024 维数据卷保持相同；更换的是推理运行时，不是 embedding 模型。

```sh
# 从官方 registry 下载固定模型；8 路有界 Range、断点恢复、最终完整 SHA-256
python3 scripts/download-openviking-model.py

# 官方原生压缩包完整校验并解压后，生成受管 helper 的配置
python3 scripts/openviking-local.py configure-embedding-helper --ollama-binary /绝对路径/ollama-runtime/ollama

# 选择原生运行时，仅写配置
python3 scripts/openviking-local.py configure --native-embedding
```

模型目录为 `.runtime/semantic/ollama-models`。下载器严格核对每片 `Content-Range`、断点已保存内容及最终全文件 hash；未验证的 `.part` 不作为模型发布。为避开错误复用 Range 响应的网络缓存，每片 URL 使用不同的非秘密查询参数。只有所有 config、license、模型 blob 均验证后才发布模型 manifest。下载变慢或失败不降级到假 embedding。

`embedding-helper-descriptor.json` 指向严格受管的 `openviking-embedding-helper.py`。它要求主监督进程提交 owner 记录后才启动自身子进程，拒绝接管原有 11434 监听者；监听者 PID 必须属于自己的 Ollama，且 `/api/tags` 模型名和 manifest digest 必须匹配。`modelDigest` 指整个模型 manifest 的摘要，不是 1.2 GB GGUF 权重 blob 的摘要；两者不可互换。首次标签检查成功后，每个受管原生进程只发送一次本地 `/api/embed` 预热，输入固定为 `ok`；须返回符合配置维度（默认 1024）的非零有限数值向量才可就绪。预热异步执行，默认总期限 60 秒，超时或无效结果保持 503，不在本生命周期重复推理；停止会中断请求并回收原生进程树。新生成 descriptor 的启动宽限为 90 秒，容纳这次真实冷加载，daemon 的真实记忆就绪检查标准保持不变。

原生进程默认 `OLLAMA_KEEP_ALIVE=-1`，预热请求也显式指定 `keep_alive=-1`，后续未指定该参数的 OpenViking 请求沿用驻留设置；不以默认短暂驻留掩盖 100 小时期间再次冷加载的问题。每次 helper 检查仍验证原生监听者、标签身份和 `/api/ps` 的同名同 digest 模型实际驻留；内存压力或外部卸载造成缺失时返回 503，由监督进程的有界恢复策略处理。驻留不是语义质量证明，实际 OpenViking 依赖就绪及记忆质量仍分别由 `/ready` 和独立语义 E2E 验证。预热只调用本机真实 embedding，不调用付费 VLM。生命周期事件由监督进程写入有界日志，模型 stdout/stderr 不写入公开日志。配置中推理和身份健康端口均只绑定 loopback（11434 / 11435）。OpenViking 容器使用 `http://host.docker.internal:11434/v1`，不需要向局域网开放端口。本机已验证 Docker 可达主机 loopback；其他 Docker 环境需要单独核对。

候选验证时，应由独立临时 ManagedHelpers controller 持有 native helper；验证完成后明确关闭，再让正式服务接管。不要自行写 owner 伪造监督关系或用无人监管的后台 `ollama serve` 代替长期部署。模型下载完成且 helper 已就绪后：

```sh
python3 scripts/openviking-local.py prepare --native-embedding --desktop-relay

# 正式切换需要同时安装两个 descriptor，不能只保留 relay
./prototypes/control-center/rna service restart \
  --helper-descriptor /绝对项目路径/deploy/openviking/.runtime/semantic/embedding-helper-descriptor.json \
  --helper-descriptor /绝对项目路径/deploy/openviking/.runtime/semantic/relay-helper.json
```

`deployment.json` 保存选择，后续 start/restart 沿用；`--container-embedding` 显式切回相同模型的 Docker 运行时。原生模式的 Compose override 禁止启动大镜像 embedding 服务。已运行容器的配置发生变化时，普通候选准备会拒绝直接覆盖，须协调后显式 restart。

## Relay 与持续健康

Relay 只以前台辅助进程运行，由 Rna 的监督进程托管。`configure-helper` 固定 Docker Engine、Python 路径、配置路径和 SHA-256；实际配置只读取一次，内容 hash 必须与受管 owner 快照匹配，否则在监听前退出。子进程必须在 10 秒内看到相同 PID、nonce 和 fingerprint 的持久化 running 所有权；未提交的准备记录不能放行。

首次通过随机身份、PID 和指纹认证的健康响应后，监督进程原子保存 Python exec 后的稳定进程身份，再发布健康。写入失败、旧响应或错 nonce 均停止放行。监督进程若恰在 exec 完成而稳定身份尚未落盘时退出，恢复仍可能因无法证明身份而停止接管；不声称这个窗口必然自动恢复。

Relay 默认最多 8 个并发连接，请求和响应各最多 2,000,000 bytes；空闲 I/O 超时 5 秒、整体请求 80 秒、Docker transport 70 秒、容器内 HTTP 65 秒。超时会回收 Docker 子进程。日志不记录密钥或请求正文，1 MiB 轮转并保留 3 个历史文件，权限 `0600`。它不支持 Studio、SSE、WebSocket，不适合高吞吐场景。独立开发调试可使用 `python3 scripts/openviking-local.py relay`；该命令占用终端，退出即停止。

| 检查 | 可以证明 | 不能证明 |
| --- | --- | --- |
| Relay `/_rna/health` | 辅助进程身份与存活 | Docker、OpenViking、模型可用 |
| OpenViking `/health` + 鉴权后 `/api/v1/system/status` | HTTP 存活、租户凭据有效、完成初始化 | 模型推理与检索质量 |
| OpenViking `/ready` | 文件系统、向量库、embedding 均通过官方检查 | 文本模型成功、记忆理解质量 |
| 真实语义 E2E | 报告所列文本样例的向量、摘要、记忆提取和召回表现 | 所有项目的长期准确性或连续 100 小时 |

`/ready` 会执行真实 embedding（官方实现为 `embed_compat(embedder, "ok", is_query=True)`），不是静态检查。Rna 默认每 60 秒探测一次，首次连接及手动检查也可能触发。当前部署使用本地训练模型推理；若未来改为远端 embedding，探针可能产生额外费用，尚不计入聊天 token 账本。HTTP 200 但 embedding 不明确成功不会记为健康；旧服务缺少 `/ready` 时返回 `not_supported` 和 `ready:false`。

容器配置 `restart: unless-stopped` 与有界日志。该策略负责容器退出后的重启，healthcheck unhealthy 本身不会自动重启；`depends_on: service_healthy` 只控制启动顺序。[Docker 重启策略](https://docs.docker.com/engine/containers/start-containers-automatically/)、[Compose 依赖启动](https://docs.docker.com/compose/how-tos/startup-order/)。Docker Engine、主机可访问磁盘与网络仍是持续运行前提。

## 历史协议夹具

旧协议测试环境现保存在 `compose.fixture.yaml`，只能显式选择：

```sh
python3 scripts/openviking-local.py status --fixture --desktop-relay
python3 scripts/openviking-local.py stop --fixture --desktop-relay
```

其 `.runtime/ov.conf`、`rna-openviking-data` 和 `rna-local-test` 租户不变。夹具为 64 维词项哈希与固定摘要/空提取，仅用于离线协议回归；不得接入真实项目。旧 `integration-report.json` 的 15/15 仅证明官方 OpenViking 协议、隔离、持久化和任务流程，不证明真实语义。不可把旧观测累加到切换后的真实模型耐久时间。

```sh
python3 -m unittest discover -s scripts/test -p 'test_openviking_relay.py' -v
python3 -m unittest discover -s scripts/test -p 'test_openviking_semantic_deployment.py' -v
python3 -m unittest discover -s scripts/test -p 'test_openviking_model_download.py' -v
```

这些部署与 transport 测试不调用远端模型。真实语义评估单独运行 `scripts/test-openviking-semantic.mjs`，使用隔离数据并产生独立报告；不能用 HTTP fixture 或示例期望值替代真实推理结果。
