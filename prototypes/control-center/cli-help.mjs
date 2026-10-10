import { cliError, languageReady, say } from './cli-language.mjs';

// Both languages of every help text live here side by side; the Chinese text is the one the CLI always printed.
const overviewZh = `Rna Agent · 终端与桌面共用项目、会话和模型

开始使用
  rna service start                  启动本机服务
  rna chat --workspace "$PWD"         在当前项目目录继续对话
  rna sessions                        查看已有会话
  rna chat <会话ID>                    恢复会话

自动化
  rna run <会话ID> <内容> --jsonl     提交并等待自己的轮次结束
  rna watch <会话ID> --jsonl          订阅状态，断线自动恢复
  rna background <项目ID>             查看和管理独立后台行动
  rna sources <项目ID>                查看项目目录观察状态
  rna maintenance status              查看应用版本、维护与本机恢复点
  rna versions <项目ID>               简洁查看候选与当前版本
  rna version <项目ID> <版本ID>        查看评测阶段、用量和验证范围
  rna help all                        查看配置、技能、任务、记忆与恢复命令

聊天中 /help 查看命令，Tab 补全；/steer 插入调整，/followup 排下一轮。
后台请求断线未确认时，/background retry <行动ID> 复用原请求重试。
退出 CLI 只断开客户端，后台工作继续；/stop 才停止当前轮次。
桌面安装包内 CLI 无需另装 Node，菜单可复制启动命令。`;
const fullHelpZh = `Rna Agent CLI（./rna start 前台运行，或 ./rna service start 后台运行）
  service install|start|stop|restart|status|uninstall|run
  service start|restart [--native|--session]   原生托管或当前登录会话后台
  service start|restart --helper-descriptor PATH  托管已配置的本机依赖（可重复）
  service restart --without-helpers         明确移除依赖托管
  endurance start [--hours 小时] [--keep-awake] | status | stop
                              默认按实测历史分阶段观测；指定时长则固定，不制造模型任务
  judge [status|ledger|calibration|completion] [--point 决策点] [--project 项目ID（仅 completion）] [--window 24h|7d|30d|all] [--json] 查看 JEV 配置、耗时、用量与校准；completion 对照“后台运行完成要不要复查”的影子判断与复查实际带来的结果（只读）
  bench extract|metrics|scenarios|compare [--project ID] [--window 7d|30d|all] [--json]  离线回放基准与“变聪明”指标（只读）
  maintenance status|prepare <本地目录>|backup [--json]
  maintenance apply|rollback <候选ID> [--json] [--request-id ID]
  maintenance restore <恢复点ID> --confirm [--json] [--request-id ID]
  maintenance cancel <操作ID> [--json]
  effort status | capture on|off | routing shadow | routing route [--purposes decision,narrator]   内部调用推理强度（JEV 选择记录/按用途生效、采集；后台工作、初始化、压缩始终只记录）
  effort replay --approved [--approve-more TOKENS] [--cases N] [--baseline N] [--narrator N] [--budget TOKENS] [--out 文件]   付费回放验证（决策与消息改写；已批准共 250 万 token，超出需另行批准）
  effort cancel | report <回放ID> [--out 文件]
  compaction probe [--approved] [--points N] [--budget TOKENS] [--project ID] [--out 文件] [--no-wait]   GLM 压缩分叉付费探针（缓存复用、纯文本、覆盖率；已批准共 200 万 token；不加 --approved 只预览）
  compaction status | cancel | report <探针ID> [--out 文件]
  schedule-text version [v1|v2] | status   日程任务文本的版本（v1 现行文本；v2 新文本，付费回放通过后再设为 v2）
  schedule-text replay [--approved] [--approve-more TOKENS] [--foreground N] [--planner N] [--baseline all|effect] [--budget TOKENS] [--project ID] [--out 文件] [--no-wait]   日程文本 v1/v2 配对付费回放（已批准 100 万 token；更多须用户另行批准并加 --approve-more，一次回放的预算（未花的额度加它）至多 800 万，计划只填满预算的九成；不加 --approved 只预览；--baseline effect 持久要求只发 v2，省约三成）
  schedule-text cancel | report <回放ID> [--out 文件]
  maintenance prune [--dry-run] [--json] [--state 路径]  按保留策略清理旧恢复点与运行包
  maintenance compact-journals [--dry-run] [--remove-backups] [--json] [--state 路径]
                              服务停止时合并旧会话日志中的逐字流事件；原文件保留到 --remove-backups
                              应用维护与项目进化版本分开；忙时等待，不中断现有工作
                              等待最多30秒后可用status继续查看；断线不重发，退出CLI不取消
                              恢复替换本机应用状态及凭据，项目目录和远端记忆不回滚；恢复后急停
  config | providers             查看脱敏配置和模型目录
  web-config [--enabled true|false] [--provider fastcrw|firecrawl|tavily|brave|zhipu|bocha]
             [--endpoint URL] [--api-key-env 名称] [--timeout-ms 毫秒]
  web-config --file <JSON文件> | web-test
                              全局联网设置与连接检查；密钥不接受命令行明文
                              换搜索服务时改用该服务的地址，原密钥不带过去
  model-default <供应商ID> <模型ID> [推理档位]
  model-set <会话ID> <供应商ID> <模型ID> [推理档位]
  provider-add --file <JSON文件> | provider-test <供应商ID>
  provider-auth catalog | status <供应商ID>
  provider-auth start <供应商ID> [--method browser|device_code] [--wait]
  provider-auth complete <供应商ID> --attempt <流程ID> --callback-file <文件>
  provider-auth cancel <供应商ID> [--attempt <流程ID>] | logout <供应商ID>
  memory-config [--backend openviking|embedded] [--endpoint URL] [--api-key-env 名称] [--auto-recall true|false] [--context-budget tokens]
  memory <项目ID> list|health|initialize
  memory <项目ID> search <内容> [--level L0|L1|L2]
  memory <项目ID> browse [URI] | read <URI> [--level L0|L1|L2]
  memory <项目ID> write --file <文件> [--title 标题] [--uri URI] [--mode create|replace|append|upsert]
  doctor [项目ID]              检查后台服务、Rna 模型配置、项目记忆连接、近 7 天的使用体验与进化状态
  run <会话ID> <内容> [--jsonl] [--timeout 秒]
  watch <会话ID> [--jsonl]     通过 SSE 订阅会话，无轮询
  questions <会话ID>           查看交互 ID、问题与选项 ID、回答状态
  answer <会话ID> <交互ID> --answers-file <JSON文件> [--request-id ID]
                              文件：{"answers":[{"id":"问题ID","selected":["选项ID"],"custom":"补充"}]}
  cancel-question <会话ID> <交互ID> [--request-id ID]
  permissions <项目ID>
  permissions-set <项目ID> --workspace read|write|execute --background read|inherit
  frequency <项目ID> [active|balanced|quiet]  查看或设置主动与进化频率
  retry <会话ID>              重试最后失败的真实轮次，保留原 turn 和已执行记录
  recovery <会话ID>           查看待核对的 callKey 与工具
  recovery <会话ID> resolve <callKey> completed|not-executed|abandoned <核对说明>
                              abandoned 保留结果未确认；核对不执行，之后显式 resume
  commands <会话ID>           查看指令及当前可用状态
  focus|feedback <会话ID> <内容>  保存项目关注或反馈
  plan <会话ID> plan|build    切换实际只读计划模式
  compact <会话ID> [整理要求] 使用当前模型整理较早上下文
  attach <会话ID> <文件路径>  上传附件（不限大小），返回附件 ID
  export <会话ID> <ZIP路径>   导出脱敏聊天记录，不覆盖现有文件
  files <项目ID> [相对目录] | file <项目ID> <相对文件>
  preview <项目ID> [status|start|stop] [HTML路径或Vite目录] [--mode static|vite] [--session 会话ID]
                              static 为默认；vite 需本地已安装 Vite、项目执行授权和 project_exec 分配
  marketplace [catalog]
  schedule <项目ID> [list|create|update|pause|resume|delete] [日程ID] [--file JSON文件] [--request-id ID]
  marketplace search <公开能力关键词> [--provider skills-sh|skillsmp] [--limit 1–10] [--project ID]
  marketplace read skills-sh|skillsmp <搜索结果ID> [--path 包内相对路径] [--project ID]
                              先搜索再读取固定 Git commit，不安装、不授予权限；关键词会发送到公开目录
  mind <项目ID>                读取项目心智（经验、议程、承诺、笔记、学习状态）
  mind reconcile <项目ID> [--dry-run]
                              用判断核对议程/承诺是否已在对话中答复或被后续工作取代；--dry-run 只预览
  evolution failures [项目ID] | system | proposals [数量] | resolve-proposal <ID> <addressed|rejected|proposed> [说明] | propose-system [组件] [说明]
  evolution changelog|components|history|signals <项目ID> [组件键]
  evolution task-types <项目ID> [research|coding|creative|design|analysis|writing|recurring|data…|auto]
                              进化记录、组件历史、真实交互信号与失败分类；系统级提议只写入待审记录，不自动采用
  capabilities | project-capabilities <项目ID>
  capability-inspect|capability-install|capability-assign|capability-remove <项目ID> <JSON文件>
  initiative-resolve <项目ID> <动作ID> --status completed|not-executed|cancelled --summary <核对说明>
                              人工核对待确认后台动作；普通“继续”不会解除
  background <项目ID> [list] [--json]
  background <项目ID> pause|resume|stop <完整行动ID> [--json]
  background <项目ID> steer <完整行动ID> --text <调整内容> [--json]
                              仅控制指定后台行动；普通会话 /stop 不停止独立后台研究
                              暂停/停止等待当前工具批次结束；请求已保存不表示已经停止
                              暂停后新的自动调查等待；已有任务和对话继续，不关闭项目主动能力
                              --request-id ID --revision N 用于重试同一已提交操作，保留原回执
  capability-add skills|mcpServers <JSON文件>（已有清单注册）
  project-init <项目ID>         重试模型初始化
  genome <项目ID> [版本ID]      导出可编辑能力包与评估标准
  evolve <项目ID> [能力包JSON]  生成或评估新版本（后台执行）
  projects | project <项目ID>
  project-new <名称> [项目说明] [--demo] [--workspace 目录]
  project-open <目录> [--project <历史项目ID>]
  sources <项目ID> [--json]        查看目录观察来源（只读）
  source <项目ID> workspace pause|resume [--json]
                              仅暂停/恢复变化采集；聊天和日程继续，恢复不回溯暂停期间
  observe <项目ID> <类型> <内容>   context|ci_failure|ci_recovered|preference|research_result|note|conversation
  initiative <项目ID> on|off|mute|unmute|quiet|resume
  versions <项目ID> [--json]   默认简洁列表；--json 返回完整机器记录
  version <项目ID> <版本ID> [--json]  查看评测阶段、用量与验证范围
  version <项目ID> <版本ID> trial|rollback|adopt  原有版本控制
  check <项目ID> [true|false true|false true|false]
                              默认模拟检查 signal=true / revision=false / smoke=false
  sessions | new [标题] [--project <项目ID>] [--workspace 目录] | demo
  chat [会话ID] | chat --workspace <目录>
                              交互聊天，自动重连并持续接收主动发现
  chat --project <项目ID>       在项目内新建会话
  history <会话ID>
  send|steer|followup <会话ID> <内容> [--attachment <附件ID>]
  pause|resume|interrupt <会话ID>
  withdraw <会话ID> <排队消息ID>
  status | events
  budget <每日模拟USD> [模拟token预算]
  stop | reset                 全局急停与解除
旧 Goal 调度兼容（非项目主动能力入口）：
  autonomy [模拟预算USD] | goals | goal <目标ID>
  goal <目标ID> pause|resume|cancel|advance|signal
  goal <目标ID> budget <模拟USD> [最大轮数]
旧任务兼容：
  list | create <任务标题>
  pause|resume|cancel|delete <任务ID>
  edit <任务ID> <新标题>
项目无需 Goal；--demo 只注入项目语境样本。quiet 暂停主动发言30分钟，resume启用并解除。
mute/unmute 仅控制主动消息，后台仍可运行。模型配置在每轮开始时固定；非 demo 提供商调用独立 Rna SDK。
OpenViking 为唯一记忆后端，离线会明确报错，不回退到本地。真实项目由配置模型主动判断，候选执行脚本检查和冻结标准对照评测。
API Key 请使用环境变量、设置界面或配置文件；不会作为命令行参数或配置输出暴露。`;
const overviewEn = `Rna Agent · the terminal and the desktop share projects, sessions and models

Getting started
  rna service start                  start the local service
  rna chat --workspace "$PWD"         continue the conversation in the current project directory
  rna sessions                        list existing sessions
  rna chat <session ID>               resume a session

Automation
  rna run <session ID> <text> --jsonl   submit and wait for your own turn to finish
  rna watch <session ID> --jsonl        subscribe to state, reconnecting automatically
  rna background <project ID>           view and manage independent background actions
  rna sources <project ID>              view the project directory observation state
  rna maintenance status                view the app version, maintenance and local recovery points
  rna versions <project ID>             list candidate and current versions concisely
  rna version <project ID> <version ID> view the evaluation stage, usage and verification scope
  rna help all                          list the configuration, skill, task, memory and recovery commands

In chat, /help lists the commands and Tab completes; /steer inserts an adjustment, /followup queues the next turn.
If a background request is cut off before it is confirmed, /background retry <action ID> retries with the original request.
Quitting the CLI only disconnects the client and background work continues; /stop is what stops the current turn.
The CLI inside the desktop installer needs no separate Node; the menu can copy the launch command.`;
const fullHelpEn = `Rna Agent CLI (./rna start runs in the foreground, or ./rna service start runs in the background)
  service install|start|stop|restart|status|uninstall|run
  service start|restart [--native|--session]   native hosting, or background in the current login session
  service start|restart --helper-descriptor PATH  host a configured local dependency (repeatable)
  service restart --without-helpers         explicitly remove dependency hosting
  endurance start [--hours HOURS] [--keep-awake] | status | stop
                              by default observes in stages by measured history; a given duration is fixed; creates no model tasks
  judge [status|ledger|calibration|completion] [--point DECISION_POINT] [--project PROJECT_ID (completion only)] [--window 24h|7d|30d|all] [--json]  show the JEV configuration, latency, usage and calibration; completion compares the shadow judgment of "should a finished background run be re-checked" with what the re-check actually brought (read-only)
  bench extract|metrics|scenarios|compare [--project ID] [--window 7d|30d|all] [--json]  offline replay benchmark and "getting smarter" metrics (read-only)
  maintenance status|prepare <local directory>|backup [--json]
  maintenance apply|rollback <candidate ID> [--json] [--request-id ID]
  maintenance restore <recovery point ID> --confirm [--json] [--request-id ID]
  maintenance cancel <operation ID> [--json]
  effort status | capture on|off | routing shadow | routing route [--purposes decision,narrator]   internal-call reasoning effort (JEV choice records / takes effect per purpose, capture; background work, initialization and compaction are always record-only)
  effort replay --approved [--approve-more TOKENS] [--cases N] [--baseline N] [--narrator N] [--budget TOKENS] [--out FILE]   paid replay check (decisions and message rewriting; 2.5 million tokens approved in total, more needs separate approval)
  effort cancel | report <replay ID> [--out FILE]
  compaction probe [--approved] [--points N] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait]   paid GLM compaction-fork probe (cache reuse, plain text, coverage; 2 million tokens approved in total; without --approved it only previews)
  compaction status | cancel | report <probe ID> [--out FILE]
  schedule-text version [v1|v2] | status   version of the schedule task texts (v1 is the current text; v2 is the new text, set to v2 only after the paid replay passes)
  schedule-text replay [--approved] [--approve-more TOKENS] [--foreground N] [--planner N] [--baseline all|effect] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait]   paired paid replay of schedule texts v1/v2 (1 million tokens approved; more needs the user's separate approval via --approve-more; one replay's budget (the unspent allowance plus it) is at most 8 million, and the plan fills only 90% of the budget; without --approved it only previews; --baseline effect sends lasting requests only under v2, saving about 30%)
  schedule-text cancel | report <replay ID> [--out FILE]
  maintenance prune [--dry-run] [--json] [--state PATH]  clean old recovery points and run bundles by the retention policy
  maintenance compact-journals [--dry-run] [--remove-backups] [--json] [--state PATH]
                              while the service is stopped, merge the verbatim stream events in old session journals; the original files are kept until --remove-backups
                              app maintenance is separate from project evolution versions; waits when busy and does not interrupt existing work
                              after waiting up to 30 seconds, keep watching with status; a dropped connection is not resent, quitting the CLI does not cancel
                              a restore replaces the local app state and credentials; project directories and remote memory are not rolled back; emergency stop after a restore
  config | providers             show the redacted configuration and the model catalog
  web-config [--enabled true|false] [--provider fastcrw|firecrawl|tavily|brave|zhipu|bocha]
             [--endpoint URL] [--api-key-env NAME] [--timeout-ms MILLISECONDS]
  web-config --file <JSON file> | web-test
                              global web settings and connection check; keys are not accepted in plain text on the command line
                              choosing another search service switches to its address; the saved key is not carried over
  model-default <provider ID> <model ID> [reasoning level]
  model-set <session ID> <provider ID> <model ID> [reasoning level]
  provider-add --file <JSON file> | provider-test <provider ID>
  provider-auth catalog | status <provider ID>
  provider-auth start <provider ID> [--method browser|device_code] [--wait]
  provider-auth complete <provider ID> --attempt <flow ID> --callback-file <file>
  provider-auth cancel <provider ID> [--attempt <flow ID>] | logout <provider ID>
  memory-config [--backend openviking|embedded] [--endpoint URL] [--api-key-env NAME] [--auto-recall true|false] [--context-budget tokens]
  memory <project ID> list|health|initialize
  memory <project ID> search <text> [--level L0|L1|L2]
  memory <project ID> browse [URI] | read <URI> [--level L0|L1|L2]
  memory <project ID> write --file <file> [--title TITLE] [--uri URI] [--mode create|replace|append|upsert]
  doctor [project ID]              check the background service, the Rna model configuration, the project memory connection, the last 7 days of experience and the evolution state
  run <session ID> <text> [--jsonl] [--timeout SECONDS]
  watch <session ID> [--jsonl]     subscribe to a session over SSE, no polling
  questions <session ID>           list interaction IDs, questions and option IDs, and answer states
  answer <session ID> <interaction ID> --answers-file <JSON file> [--request-id ID]
                              file: {"answers":[{"id":"question ID","selected":["option ID"],"custom":"addition"}]}
  cancel-question <session ID> <interaction ID> [--request-id ID]
  permissions <project ID>
  permissions-set <project ID> --workspace read|write|execute --background read|inherit
  frequency <project ID> [active|balanced|quiet]  show or set the proactive and evolution frequency
  retry <session ID>              retry the last failed real turn, keeping the original turn and the executed records
  recovery <session ID>           list the callKeys and tools waiting to be reconciled
  recovery <session ID> resolve <callKey> completed|not-executed|abandoned <reconciliation note>
                              abandoned keeps the result unconfirmed; reconciling does not execute, resume explicitly afterwards
  commands <session ID>           list the commands and whether each is currently available
  focus|feedback <session ID> <text>  save a project focus or feedback
  plan <session ID> plan|build    switch the actual read-only plan mode
  compact <session ID> [instructions] tidy earlier context with the current model
  attach <session ID> <file path>  upload an attachment (no size limit), returns the attachment ID
  export <session ID> <ZIP path>   export the redacted chat record, never overwriting an existing file
  files <project ID> [relative directory] | file <project ID> <relative file>
  preview <project ID> [status|start|stop] [HTML path or Vite directory] [--mode static|vite] [--session session ID]
                              static is the default; vite needs Vite installed locally, project execution permission and a project_exec allocation
  marketplace [catalog]
  schedule <project ID> [list|create|update|pause|resume|delete] [schedule ID] [--file JSON file] [--request-id ID]
  marketplace search <public capability keywords> [--provider skills-sh|skillsmp] [--limit 1–10] [--project ID]
  marketplace read skills-sh|skillsmp <search result ID> [--path path inside the package] [--project ID]
                              search first, then read a pinned Git commit; nothing is installed or granted; the keywords are sent to the public catalog
  mind <project ID>                read the project mind (experience, agenda, commitments, notes, learning state)
  mind reconcile <project ID> [--dry-run]
                              judge whether agenda items/commitments were already answered in the conversation or superseded by later work; --dry-run only previews
  evolution failures [project ID] | system | proposals [count] | resolve-proposal <ID> <addressed|rejected|proposed> [note] | propose-system [component] [note]
  evolution changelog|components|history|signals <project ID> [component key]
  evolution task-types <project ID> [research|coding|creative|design|analysis|writing|recurring|data…|auto]
                              evolution records, component history, real interaction signals and failure classes; system-level proposals are only written as pending records and never adopted automatically
  capabilities | project-capabilities <project ID>
  capability-inspect|capability-install|capability-assign|capability-remove <project ID> <JSON file>
  initiative-resolve <project ID> <action ID> --status completed|not-executed|cancelled --summary <reconciliation note>
                              reconcile a background action awaiting confirmation by hand; a plain "continue" does not clear it
  background <project ID> [list] [--json]
  background <project ID> pause|resume|stop <full action ID> [--json]
  background <project ID> steer <full action ID> --text <adjustment> [--json]
                              controls only the given background action; /stop in an ordinary session does not stop independent background research
                              pause/stop wait for the current tool batch to finish; a saved request does not mean it has already stopped
                              after a pause new automatic investigations wait; existing tasks and conversations continue, and the project's proactive ability stays on
                              --request-id ID --revision N retries the same submitted operation and keeps the original receipt
  capability-add skills|mcpServers <JSON file> (register an existing manifest)
  project-init <project ID>         retry model initialization
  genome <project ID> [version ID]      export the editable capability package and evaluation criteria
  evolve <project ID> [capability package JSON]  generate or evaluate a new version (runs in the background)
  projects | project <project ID>
  project-new <name> [description] [--demo] [--workspace directory]
  project-open <directory> [--project <earlier project ID>]
  sources <project ID> [--json]        list directory observation sources (read-only)
  source <project ID> workspace pause|resume [--json]
                              only pauses/resumes change collection; chat and schedules continue, resuming does not backfill the paused period
  observe <project ID> <type> <text>   context|ci_failure|ci_recovered|preference|research_result|note|conversation
  initiative <project ID> on|off|mute|unmute|quiet|resume
  versions <project ID> [--json]   a concise list by default; --json returns the full machine record
  version <project ID> <version ID> [--json]  show the evaluation stage, usage and verification scope
  version <project ID> <version ID> trial|rollback|adopt  the original version controls
  check <project ID> [true|false true|false true|false]
                              the default simulated check is signal=true / revision=false / smoke=false
  sessions | new [title] [--project <project ID>] [--workspace directory] | demo
  chat [session ID] | chat --workspace <directory>
                              interactive chat, reconnects automatically and keeps receiving proactive findings
  chat --project <project ID>       start a new session inside a project
  history <session ID>
  send|steer|followup <session ID> <text> [--attachment <attachment ID>]
  pause|resume|interrupt <session ID>
  withdraw <session ID> <queued message ID>
  status | events
  budget <daily simulated USD> [simulated token budget]
  stop | reset                 global emergency stop and its release
Legacy Goal scheduling, kept for compatibility (not the entry to the project's proactive ability):
  autonomy [simulated budget USD] | goals | goal <goal ID>
  goal <goal ID> pause|resume|cancel|advance|signal
  goal <goal ID> budget <simulated USD> [max turns]
Legacy tasks, kept for compatibility:
  list | create <task title>
  pause|resume|cancel|delete <task ID>
  edit <task ID> <new title>
A project needs no Goal; --demo only injects project-context samples. quiet pauses proactive speech for 30 minutes, resume enables it again and clears the pause.
mute/unmute control only proactive messages, background work can still run. A model configuration is fixed when each turn starts; a non-demo provider calls the standalone Rna SDK.
OpenViking is the only memory backend; when it is offline the CLI says so clearly and does not fall back to a local one. For real projects the configured model judges proactively, and a candidate is evaluated against script checks and the frozen criteria.
Use an environment variable, the settings screen or the config file for API keys; they are never exposed as command-line arguments or config output.`;
const chatHelp = {
  zh: 'chat [会话ID] | chat --project <项目ID> | chat --workspace <目录>\n与桌面共用状态，Tab 补全，/help 显示交互命令，/quit 仅断开。\n/model 查看模型，/model <供应商ID> <模型ID> 切换后续轮次；/attach 添加附件，/send 仅发送附件。',
  en: 'chat [session ID] | chat --project <project ID> | chat --workspace <directory>\nShares state with the desktop, Tab completes, /help lists the interactive commands, /quit only disconnects.\n/model shows the model, /model <provider ID> <model ID> switches later turns; /attach adds an attachment, /send sends only the attachments.'
};
/** Prints a help topic in the interface language (the daemon is asked for it only here, never for a command that prints JSON). */
export async function printCliHelp(topic) {
  if (topic && topic !== 'all' && topic !== 'chat') throw cliError('帮助主题为 chat 或 all', 'The help topic is chat or all');
  await languageReady();
  if (!topic) console.log(say(overviewZh, overviewEn));
  else if (topic === 'all') console.log(say(fullHelpZh, fullHelpEn));
  else console.log(say(chatHelp.zh, chatHelp.en));
}
