# V01–V04 技术验证记录

2026-09-16。本文件记录实际实验，设计文档中的验收范围仍然有效。

最终从锁文件和固定快照重新安装、构建后，`npm run probe` 的 Linux 全套 **32 项通过，0 失败、0 跳过**。环境、命令和源文件 SHA-256 见 [验证清单](../probes/results/linux-verified.json)，逐项输出见 [TAP 记录](../probes/results/linux-verified.tap)。该结果不包含真实模型与其他平台。

## 环境与边界

- Linux；Node.js v26.8.2、npm 11.19.1。
- pi `6671c604766b3670ed95f405aa7856835d0ca702`，包版本 0.85.1；MIT；未修改上游跟踪文件。
- 安装按上游锁文件，禁用生命周期脚本；构建通过。源码不包含完整模型目录，因此单独固定公开数据快照及 SHA-256，保留其原生 manifest。
- 真实 pi 进程加可控 provider；尚未调用真实模型服务。macOS 没有运行证据。

## V01：RPC 核心路径与旧版本会话

命令：`node probes/setup-pi.mjs`；`node --test probes/v01.test.mjs probes/v01-upgrade.test.mjs`。Linux 2 项集成场景通过。

已通过：

- JSONL 消息流，包括 Unicode 行分隔字符；真实 Bash 工具开始/结束事件；会话树、增量条目游标及无效游标拒绝。
- 会话文件落盘，关闭进程后重新打开，原会话与分叉会话互不串写。
- 用户消息 fork 创建新会话：选中消息作为待编辑文字返回，不进入继承历史；保留当前代码。
- 图片内容经过 RPC 进入原生消息记录；可控 provider 接收上下文。
- 扩展提问按 question ID 回答，扩展收到预期内容。
- 清空内核队列后 abort，内核回到 idle，未执行工具的后续写入。

阶段判断：继续采用 RPC 进行后续实验，暂未发现需要 SDK worker 的已确认需求缺口。并非 V01 全量验收通过。

补充已通过：真实旧版 pi 0.84.1 的 SessionManager 生成样本，新版可打开、继续并分叉。样本保留 SHA-256 和官方包完整性标识，消息为合成数据；它不代表所有历史版本或真实 provider 上下文升级都已验证。

启动/恢复延迟记录在 TAP 中，为此机器单次样本（约 1 秒，包含扩展加载），不是性能基准；暂维持每 run 一个进程的架构默认值。发送接受后的崩溃窗口见 V02。

待补：真实 provider 图片/文本/工具调用与 macOS。`v01-live.test.mjs` 已准备并检查语法，但未执行真实模型调用。只检查了本机 pi 配置是否存在及常见 provider 环境变量名称，没有输出密钥；没有发现可用配置或凭据。

## V02 首轮：工作区、持久队列与进程故障

命令：`node --test probes/v02.test.mjs`。Linux 14 项实验通过，记录见 `probes/results/v02-linux.tap`。

- 真实 Git 仓库的两个 worktree 与真实 pi 进程：同分支串行、不同分支运行区间重叠；符号链接别名映射到相同 lane；重复请求返回原记录，内容变化报冲突。
- SQLite 排他实例锁拒绝第二个协调器及真实第二后端进程；队列状态和事件一起落盘。
- 等待真实扩展问题时继续占并发名额；正确回答后才继续。按 lane 最近获准执行次序选择，避免一个分支的积压占满其他就绪分支的机会。
- 正常停止清理工具，保留 dirty 修改并暂停该列；排队项保留，明确恢复后才启动。等待回答时先发 abort，再取消匹配的扩展 question ID，验证不会卡在扩展对话等待中。
- 外部切换 Git 分支时启动前核验失败，暂停该列，不启动模型。
- 真实 SIGKILL 覆盖启动意图后、spawn 后但 PID 未落盘、prompt 接受后三个窗口：重启标记 interrupted/recovering，不自动补发，不放行原队列。
- 原生会话创建、fork 文件落盘、Git worktree 创建后，应用操作仍 pending 时重启：保留产物与操作意图，阻止该列继续，等待对账；fork 文件保留真实 parentSession。
- 只杀后端：此版本 pi 因 stdin EOF 清理活动 Bash。先冻结后端再强杀 pi：Bash 的独立进程组仍然存活；探针显式清理测试工具，未发生后续写入。
- 协调器仍在运行时强杀 pi：不把进程退出当作收束证明，run 标 interrupted，lane 留 recovering，禁止直接 resume。

**架构落点：仅杀 pi PID 或进程组不足以实现强制收束。** 正式平台监督实现必须追踪工具归属并确认残留进程；无法核验时保持 recovering。当前实验用 fixture 的工具 PID 做清理，不把它当成生产级进程发现方案。原生 RPC 正常取消可用，硬终止缺口位于平台监督层，尚无理由改用 SDK。

范围限制：协调器是实验实现，没有正式应用分层、通用进程身份核验或自动对账；没有 macOS 证据。不能据此宣称全部 A01–A16 已通过。

## V03：配置、模型固定与凭据

命令：`node --test probes/v03.test.mjs`。Linux 6 项实验通过，见 `probes/results/v03-linux.tap`。

- 真实双 worktree 的 `.pi/settings.json` 独立覆盖全局设置；原生 SettingsManager 可分别读取配置来源。
- RPC 对未信任项目忽略项目配置；只在隔离测试项目显式 `--approve` 后加载该项目设置。应用需要保留原生项目信任边界，不应对所有目录静默批准。
- session 显式切换模型；持久队列保存指定模型，默认值变化不影响已入队 run。
- **CLI 可以构造目录中不存在的模型 ID**；仅核对 `get_state.model.id` 不足以证明可用。实验协调器现在在 prompt 前核对 `get_available_models` 的精确 provider/model 成员资格，缺失时暂停，不替换。
- RPC `set_model` 只查已认证的可用模型，缺少凭据也可能返回 Model not found；直接启动该模型后，prompt 明确报 No API key。适配层需结合凭据/目录事实解释错误。
- 原生设置保存保留外部编辑的无关字段，但同字段旧编辑会覆盖新值。实验包装器在原生 FileSettingsStorage 锁内检查完整文件修订，旧修订被拒绝；损坏 JSON 保留原文件并报告错误。
- AuthStorage 的 locked modify 回调可比较预期凭据再修改；保留其他 provider，文件创建权限为 0600。测试仅使用假的本地凭据。

限制：配置包装器使用固定 pi 的内部路径，应保留升级契约测试；非合作外部编辑器不遵守原生文件锁，尚不能声称任意编辑器的检查/写入竞态都已解决。没有真实 provider 或 macOS 结果。

## V04：记忆、适配、失败恢复与修订

命令：`node --test probes/v04.test.mjs probes/v04-adapter.test.mjs probes/v04-jobs.test.mjs`。Linux 10 项实验通过，见 `probes/results/v04-linux.tap`。

固定 MWF 源码 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef`（包版本 0.1.0）、pi-mcp-adapter 2.32.1。MWF 当前没有可用 npm 发布包，使用单独缓存中的固定源码及其 package-lock 构建；没有初始化本项目 `.mwf/` 或修改用户技能仓库。

- bootstrap、按需 recall、写入、相同 request_id 幂等重试与不同内容冲突通过。
- 原生事务 prepared、部分落位和清理前中断可恢复；另直接运行固定 MWF 官方 SIGKILL writer 测试，证明真实进程死亡后锁可释放、日志和回执可恢复。
- 四个真实 CLI 进程同时写入同一个 request_id，只产生一条记录，其余返回 replayed；原生 doctor 校验通过。
- 外部编辑与恢复日志冲突时，保留用户内容与待恢复日志，明确报错。
- 真实 pi loader 加固定 MCP adapter 注册工具，实际调用 MWF bootstrap；首次上下文注入、同 session 不重复注入、resume 后重新注入通过。
- 真实成功 run 与关键记忆保存失败分离；SQLite 保留待写输入，暂停 lane；重启后同 request_id 重试只完成保存，不重新启动 run。
- 真实双 worktree 继承已提交记忆，但之后写入不自动共享；track/ignore 与 local 排除策略符合原生行为。

**修订缺口及可行适配：** 原生 CLI/MCP update 没有 expected_revision 字段，旧 UI 更新会覆盖较新的内容。实验 `memory-revision.mjs` 复用原生 withProjectLock、Transaction、schema 和 operate，在同一个临界区核对完整记录哈希后写入；旧修订与事务中外部编辑均被拒绝，无新 MWF schema。它使用固定版本内部路径，不伪装成原生公开能力。此修订入口不提供原生 request_id 回执，重试须由应用保存意图对账；不能把原生 add 的幂等保证直接推广到此入口。

## 当前结论与剩余门槛

Linux 上的可控 provider 探针支持继续采用 **pi RPC + 独立子进程**；暂未发现必须引入 SDK worker 的产品能力缺口。上述通过包括“验证并记录已知缺口”的检查，不表示所有生产实现已完成。

以下仍不满足全量验收：

1. **真实 provider**：当前无 pi 配置/凭据；真实文字、工具、图片理解和恢复脚本待运行。
2. **macOS**：需要实际 macOS 主机运行同一套安装与验证命令，不能用 Linux 结果替代。
3. **应用落地门槛**：平台监督的通用进程归属/收束，以及 pending 操作对账后的安全解锁尚未实现。实验当前保守停留 recovering，不自动重发或放行。后续纵向闭环需要实现这些能力。
4. **升级约束**：配置和记忆修订包装器依赖固定上游内部接口；旧版本会话只验证了所附 0.84.1 合成样本。

这些是明确剩余项，不应把测试数量或绿灯描述为 V01–V04 全平台最终验收通过。
