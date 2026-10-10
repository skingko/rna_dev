<div align="center">

[English](README.md) · **简体中文**

<img src="docs/assets/logo.png" alt="Rna Agent 标志" width="96" height="96" />

# Rna Agent

### 面向长期项目的本地优先 AI Agent 工作台

**以项目为单位，而不是一次对话。Agent 在后台持续工作，记得发生过什么，该找你的时候才找你。**

[![CI](https://img.shields.io/github/actions/workflow/status/skingko/rna_dev/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/skingko/rna_dev/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/skingko/rna_dev?style=flat-square&color=5c4ee5)](https://github.com/skingko/rna_dev/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-f4c430?style=flat-square)](LICENSE)
![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555?style=flat-square)

[下载](#下载) · [为什么用 Rna](#为什么用-rna) · [功能](#功能) · [快速开始](#快速开始) · [记忆](#记忆有无-docker-都能用) · [联网搜索](#联网搜索六种服务同一对工具) · [常见问题](#常见问题) · [文档](#文档)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/workbench-dark.png" />
  <img src="docs/assets/workbench.png" alt="Rna Agent 工作台：项目对话、工具结果、后台工作与“你不在时”的汇总" width="1200" />
</picture>

</div>

---

Rna Agent 是一个桌面应用和命令行工具，用来和 AI Agent 一起推进比一次对话更长的事情：一个游戏、一部小说、一个调研主题、一个代码库。你创建项目、指定目录并写一段介绍，之后 Agent 会跨会话保留上下文，有值得做的事时在后台继续工作，回来时给你一份简短汇总，而不是一屏日志。

它运行在你的电脑上。项目、对话、记忆和密钥都在本地文件里；只有你配置的模型和搜索服务会收到网络请求。

## 下载

从[最新发布](https://github.com/skingko/rna_dev/releases/latest)下载对应系统的版本。

| 平台 | 文件 | 状态 |
| --- | --- | --- |
| macOS（Apple 芯片） | `Rna-Agent-<版本>-macOS-arm64.dmg` | 支持 |
| macOS（Intel） | `Rna-Agent-<版本>-macOS-x64.dmg` | 支持 |
| Linux x64 | `Rna-Agent-<版本>-Linux-x64.tar.gz` | 预览 |
| Windows x64 | `Rna-Agent-<版本>-Windows-x64.zip` | 预览 |

每个版本由 [GitHub Actions](.github/workflows/release.yml) 构建，并在各自平台上启动一次后才发布。安装包尚未做代码签名和公证，首次打开时 macOS 和 Windows 会要求确认，处理办法写在[发布说明](.github/release-notes.md)里。

日常开发和使用都在 macOS 上。Linux 和 Windows 版本运行同一份代码，但依赖 macOS 能力的部分（命令沙箱、后台服务管理）在那里有所缩减，欢迎反馈。

## 为什么用 Rna

多数 Agent 工具是接在模型上的一个聊天框。Rna 围绕“工作要持续好几天”时才重要的部分来设计：

- **以项目为单位。** 项目拥有目录、记忆、技能与工具、日程和历史；会话在项目里来来去去。
- **你不在时它也能干活，并且会告诉你。** 后台调查、定时工作和跟进都在明确规则下运行；你回来会看到“你不在时”的汇总，你发来的新消息会先让后台工作停下并保留已做的部分。
- **记忆不需要安装任何东西。** 选内置本地记忆，对话和交付文件立刻可在本机检索；需要语义检索时再连接 [OpenViking](https://github.com/volcengine/OpenViking)。
- **大模型之前先过一道便宜的判断。** 路由、“值不值得打扰你”、“要不要查记忆”这类是非题交给小型判断模型（JEV，成本约为主模型的千分之一），先判断，主模型才动笔。
- **改动靠测量，不靠假设。** 对项目自身行为的候选改动按冻结基线评测，通过明确门槛才采用，历史可见，可一键回退。

## 功能

| | |
| --- | --- |
| **项目与会话** | 项目目录、按项目分配能力、归档与恢复、删除时一并清理产生的证据、用于隔离修改的会话工作树 |
| **模型** | DeepSeek、GLM（智谱）、OpenAI 兼容端点、Anthropic（API Key）、ChatGPT 订阅登录；按会话选择模型与推理档位，也可自动选档 |
| **工具** | 项目文件读写编辑、命令执行（macOS 上有沙箱）、终端、侧栏浏览器、可热更新的文件预览、git 状态与工作树 |
| **技能与 MCP** | 按需加载的技能、技能市场（ClawHub、skills.sh）、stdio 与 Streamable HTTP 的 MCP、按项目分配与权限档位 |
| **记忆** | 内置本地记忆或 OpenViking，按 token 预算自动引用，记忆浏览器，记忆按项目隔离并随对话删除 |
| **联网** | FastCRW、Firecrawl、Tavily、Brave、智谱、博查六种搜索与读页服务 |
| **主动协作** | 后台调查、日程、“你不在时”汇总、随你的反馈调整的节奏、一键全局急停 |
| **进化** | 每个项目的行为规则基因树、受评测的候选、按原因统计工具失败的系统进化页 |
| **运维** | 带崩溃恢复的后台服务、恢复点、可回退的应用内更新、与应用共用同一服务的命令行 |
| **界面** | 中英文、浅色与深色、键盘优先 |

## 快速开始

### 使用发布版

1. 下载对应平台的文件并打开（macOS：把 **Rna Agent** 拖进 Applications）。
2. **设置 → 模型**：添加提供商和密钥，选择默认模型。
3. **设置 → 记忆**：选 **本地记忆（内置）** 即可零配置使用，或连接 OpenViking。
4. 可选：**设置 → 网页工具**，让 Agent 搜索和读取网页。
5. 新建项目，指定目录，开始会话。

### 从源码运行

需要 Node.js 22.19 或更新版本。宿主和 SDK 没有运行时依赖。

```bash
git clone https://github.com/skingko/rna_dev.git
cd rna_dev/prototypes/control-center

# 构建一次 Web 界面
npm ci --prefix web && npm run build --prefix web

# 启动本机服务，然后打开 http://127.0.0.1:4317
./rna start
```

### 命令行

`rna` 命令与应用连接同一服务、同一批项目。

```bash
./rna help                       # 全部命令
./rna config                     # 脱敏配置与模型目录
./rna memory-config --backend embedded
./rna web-config --provider firecrawl --enabled true && ./rna web-test
./rna chat --workspace "$PWD"    # 在当前目录开始交互会话
```

## 记忆：有无 Docker 都能用

在 **设置 → 记忆** 里二选一。两种方式各存各的记忆，互不迁移；切回去后原有记忆仍在。

| | OpenViking 语义记忆 | 本地记忆（内置） |
| --- | --- | --- |
| 需要 | Docker、OpenViking、向量模型、文本模型 | 什么都不需要 |
| 检索 | 按语义：换种说法、换种语言也能找到 | 按关键词（中文按相邻两字） |
| 对话 | 由模型提炼成长期记忆 | 原样保存，不调用模型 |
| 数据 | OpenViking 服务的数据卷 | 本机 `<state>.rna/memory/embedded.sqlite` |

内置引擎在主机进程里回答原本发给 OpenViking 的同一组请求，所以自动引用、记忆工具、记忆浏览和删除会话在两种方式下走同一份代码。用 100 次真实检索回放：同一对话里更早的一轮排第一的占 90%，进前五的占 98%；[说明文档](docs/embedded-memory.md)也写明了关键词检索做不到什么。

## 联网搜索：六种服务，同一对工具

Agent 看到的永远是 `web_search` 和 `web_fetch` 这两个工具，由哪个服务回答是一项设置。

| 服务 | 搜索 | 读取网页 | 密钥 |
| --- | --- | --- | --- |
| [FastCRW](https://fastcrw.com)（默认，可自建兼容服务） | 是 | 经服务 | 可选 |
| [Firecrawl](https://www.firecrawl.dev) | 是 | 经服务 | 可选，不填有次数限制 |
| [Tavily](https://tavily.com) | 是 | 经服务 | 必填 |
| [Brave Search](https://brave.com/search/api/) | 是 | 本机直接读取 | 必填 |
| [智谱 Web Search](https://open.bigmodel.cn) | 是 | 经服务 | 必填 |
| [博查 Bocha](https://bochaai.com) | 是 | 本机直接读取 | 必填 |

只提供搜索的服务，网页由本机直接读取：匿名请求、只访问公网地址，连接固定到已检查的地址，每一跳重定向都重新检查，也不发送密钥。换另一种服务时会切换到该服务的地址并清除已保存的密钥，密钥不会发给它不属于的服务。

<div align="center">
  <img src="docs/assets/memory-local.png" alt="设置 → 记忆：在 OpenViking 语义记忆与内置本地记忆之间二选一" width="49%" />
  <img src="docs/assets/settings-web.png" alt="设置 → 网页工具：六种搜索服务，含地址与密钥" width="49%" />
</div>

## 常见问题

<details>
<summary><strong>我的数据会离开本机吗？</strong></summary>

项目、对话、记忆和凭据都是本地文件。Rna 只向你配置的模型提供商、搜索服务和 MCP 服务发请求，启用后也会访问 JEV 判断服务。没有 Rna 的服务器，也不会向项目回传任何信息。

</details>

<details>
<summary><strong>必须装 Docker 吗？</strong></summary>

不必。选内置本地记忆即可。只有 OpenViking 后端需要 Docker，它提供语义检索和模型提炼的记忆。

</details>

<details>
<summary><strong>可以用哪些模型？</strong></summary>

任何 OpenAI 兼容端点，以及 DeepSeek、GLM、Anthropic（API Key）和 ChatGPT 订阅。在设置 → 模型里添加；模型列表从提供商读取，删掉的模型不会再回来。

</details>

<details>
<summary><strong>自进化是真的吗？</strong></summary>

是一个可度量的过程，不是承诺。对项目行为的候选改动按冻结基线评分，通过明确的提升、安全和成本门槛才采用，历史与失败都可见。Rna 不宣称通用质量已经提升。

</details>

<details>
<summary><strong>为什么 Linux 和 Windows 是“预览”？</strong></summary>

代码相同，但开发和日常使用在 macOS 上。命令沙箱和系统服务管理是 macOS 特有的，所以 Windows 上后台服务只在应用打开时运行。每个版本在 CI 中都会在各自平台上启动一次再发布。

</details>

## 文档

| 文档 | 内容 |
| --- | --- |
| [内置本地记忆](docs/embedded-memory.md) | 原理、实测与限制 |
| [OpenViking 部署](docs/openviking-local.md) | 语义记忆的 Docker 部署 |
| [SDK 指南](packages/sdk/README.md) | API 与示例 |
| [SDK 架构](docs/rna-sdk.md) | 设计、依据与边界 |
| [完整系统设计](docs/master-design.md) | 产品、架构、调度、缓存、记忆、进化、安全 |
| [规格](docs/specs) | 控制接口与存储、流协议、上下文与能力、进化与评测 |
| [运维](docs/operations) | 应用维护、持续运行、恢复 |

## 参与贡献

欢迎提交 issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[Apache License 2.0](LICENSE)。
