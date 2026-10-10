# Rna Agent：macOS 安装包与 CLI 验收

本轮把仅连接开发端口的 Electron 窗口改为可独立运行的 macOS 应用。应用包含 Rna 后端、独立 SDK、内置方法技能、网页资源、Node.js 和 npm；无需用户先安装 Node，也不依赖源码目录。模型服务与 OpenViking 是外部服务，首次独立使用仍需配置它们。不会携带开发机器的凭据、项目、会话或记忆。

## 安装与使用

将 DMG 中的 **Rna Agent.app** 拖到 Applications 后启动。本轮构建针对 **macOS arm64 / Apple Silicon**，使用 Electron 44.4.5、Node 22.19.0、npm 10.8.2。

启动时优先发现用户已有的 `local.rna-agent.*` LaunchAgent。它会核对服务配置、状态文件位置、监督器与后台进程锁、OS 进程出生身份，以及 HTTP health 的进程代次；仅仅在某个端口返回 HTTP 200 不足以被连接。核对成功后，原有项目、模型配置和会话直接出现在桌面应用。

没有现存服务时，应用在 `~/Library/Application Support/Rna Agent` 中建立私有状态，以空闲本机端口启动既有服务监督器。端口和身份记录在该目录的 `desktop-connection.json`，不占用开发服务默认的 4317。

- 关闭窗口：后台工作继续；点击 Dock 图标可重新打开。
- 退出应用：停止应用自己启动且身份仍匹配的监督器，等待已有退出流程完成。
- 连接已有外部服务：退出桌面客户端不停止该服务。
- 启动超时或返回异常：仍核对已启动的私有监督器身份，退出时清理可验证的启动尝试；不因缺少“启动成功”回执而直接放弃清理。
- 监督器身份已被其他进程替换：不向后来进程发送停止信号。

应用菜单可以打开数据目录、复制 CLI 启动命令。复制命令会连接同一个桌面/已有服务，因此不需要复制模型密钥或重新配置项目。

```sh
"/Applications/Rna Agent.app/Contents/Resources/app/runtime/bin/rna" chat --workspace "$PWD"
```

模型与 OpenViking 配置继续通过现有设置页完成；本轮没有增加本地记忆替代后端。

## CLI 行为

Pi 的入口围绕当前目录、持续交互和可组合的非交互模式；Harness 的 CLI 负责启动和连接共享工作台。本轮沿用这些边界，CLI 与桌面仍使用同一后端和 Rna SDK，不另建一套执行引擎，也不引入 Pi SDK。

- `chat --workspace <目录>` 打开或复用该目录项目与会话。
- `/model` 列出模型，`/model <供应商ID> <模型ID>` 切换后续轮次。
- Tab 补全常用斜杠命令；`/status` 显示会话、当前模型、队列与恢复状态。
- 连续粘贴多行通过串行输入队列提交，避免上一条尚在提交时丢弃下一条。
- `/steer` 调整当前轮，`/followup` 排队下一轮。
- `/attach`、`/attachments`、`/detach`、`/send` 管理附件；`/send` 可单独发送附件。
- SSE 断线自动重连，退避从 300ms 增至最多 10 秒；使用完整持久化快照恢复，按 item ID 去重。恢复订阅不会再次提交用户消息或重放工具。
- assistant 的追加文本以增量显示，TTY 收到输出后恢复正在编辑的输入。
- 401/403/404 等终止错误不永久循环；退出会取消订阅及重连等待。
- `/quit` 只退出 CLI；`/stop` 才请求停止当前轮次。
- `help` 提供短入口，`help all` 保留完整高级命令。原有 JSON/JSONL 自动化输出格式保留。

## 构建与内容边界

本地使用官方 `@electron/packager` 20.3.0 生成 `.app`，再以系统 `hdiutil` 生成包含 Applications 链接的 DMG。官方文档区分应用打包与 Developer ID 签名/公证；本轮采用本地 ad-hoc 签名，并通过严格 `codesign` 校验，**没有 Developer ID 签名或 Apple 公证**。[Electron 应用打包说明](https://www.electronjs.org/docs/latest/tutorial/application-distribution)、[官方打包教程](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)

```sh
cd prototypes/control-center/desktop
export PATH="$PWD/../.runtime/node/node_modules/node/bin:$PATH"
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run package -- --out dist/my-release
```

也可直接执行 `build.mjs --npm <npm分发目录> --node <Node二进制> --out <新目录>`。目标架构和 Node 架构必须一致；已有输出目录不被静默覆盖。x64 需对应 Node 二进制重新构建，本轮没有声称完成 Intel 实机验收。

白名单包括：

- `desktop` 启动、preload、受控 IPC、服务发现与拥有权逻辑。
- `control-center` 根目录运行模块及 `public` 静态资源。
- `packages/sdk/src` 与内置 `skills`，保持 host 到 SDK 的相对目录结构。
- 独立 Node/npm、CLI 启动器及依赖许可证。

排除 `.state`、`.env`、凭据文件、QA/测试产物、参考项目、开发目录 `node_modules` 和用户工作区。npm 来自其已安装分发目录，单独打包，排除 `.npmrc`。构建记录包含逐文件源哈希、运行时版本、应用图标哈希和 DMG SHA-256。复制应用时保留 framework 原有相对符号链接，避免 DMG 安装后签名损坏。

## 验收方式与证据

`qa/desktop-package-20260927.mjs` 从 DMG 只读挂载，复制到包含中文与空格的临时安装目录，以只含系统命令的 PATH 启动真实 Electron 应用。使用独立数据目录和 `RNA_DESKTOP_ISOLATED=1`，因此不会发现或修改生产服务。

验收覆盖安装包签名与资源、内置 Node/npm、真实窗口与安全 preload、文件列表中的 Markdown 标题/列表/GFM 表格/代码/源码切换、CLI 共用数据、关闭窗口与重新激活、显式退出。第二个独立桌面 profile 连接第一份测试服务，验证“外部连接退出不停止后端”。应用默认外部发现逻辑另以身份不匹配与 PID 复用测试保护。

`qa/cli-multiround-20260927.mjs` 可直接加载安装包中的 host、SDK 和 CLI，完成至少 10 个轮次，穿插连续输入、引导、排队、连接中断、主动消息、待答卡、模型选择、权限与附件。模型使用本地 OpenAI SSE 协议夹具，验证的是真实 SDK/传输/状态边界，**不代表付费模型的推理或视觉质量**。

所有生成请求限于隔离模型夹具；生产只读取 health 和脱敏配置，用进程 PID 与配置哈希前后对照检查无干扰。失败的早期构建和 QA 报告保留，最终交付以通过验收的 release-final 包及 final 报告为准。

最终安装验收在 2026-09-27 18:05（北京时间）完成，9/9 项通过；包内 CLI 完成 10 轮真实状态交互、8 组断言，实际调用 11 次本地协议夹具。桌面测试期间生产 PID 为 `49727`，前后保持一致，配置哈希不变；浏览器未出现未处理异常。已人工检查安装版 Markdown 截图。另核对 194 个打包的 host、SDK、桌面源文件与当前冻结源码，哈希全部一致。

最终 DMG：`Rna-Agent-0.10.0-macOS-arm64.dmg`，SHA-256：`bd428e11c00f47f6e411840ad549e5b25b822659b9f8afd0451d8983f57219b3`。CLI 聚焦与既有交互回归合计 34/34 通过；桌面与 IPC 回归 33/33 通过，其中包含独立审查补充的 16 项启动清理与进程身份边界。它们与安装包 10 轮验收分别验证逻辑边界和实际分发文件。

可复查的最终文件：

- `prototypes/control-center/desktop/dist/release-final-20260927/build-report.json`
- `prototypes/control-center/qa/desktop-package-final-20260927.json`
- `prototypes/control-center/qa/cli-multiround-packaged-final-20260927.json`
- `prototypes/control-center/qa/cli-experience-final-20260927.tap`
- `prototypes/control-center/qa/desktop-package-runtime-final-20260927.tap`
- `prototypes/control-center/qa/desktop-startup-cleanup-independent-20260927.tap`
- `prototypes/control-center/qa/desktop-source-freeze-final-20260927.json`
- `prototypes/control-center/qa/desktop-existing-service-discovery-final-20260927.json`

本轮没有验证 Apple 公证、跨机器下载后的 Gatekeeper 放行、Intel Mac、Windows/Linux 安装包或 100 小时墙钟运行。关闭计算机或注销登录会中断当前登录会话模式的私有后台；这些边界不以单次安装测试替代。

启动失败清理已覆盖默认桌面配置（没有额外受管 helper）。若用户定制了多个慢启动 helper，使监督器在 CLI 等待期限内尚未写出首次状态，当前实现会拒绝依据不完整身份停止它；这种自定义启动边界尚未完成验收，不属于本次默认安装路径通过的结论。
