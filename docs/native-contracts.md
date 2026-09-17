# 原生依赖与升级契约

版本权威：`probes/versions.json`。本表记录应用当前实际依赖；探针专用包装器不算正式应用实现。

| 依赖入口 | 固定基线 | 实际使用及边界 | 应用回归证据 |
| --- | --- | --- | --- |
| pi 构建入口 `packages/coding-agent/dist/rpc-entry.js` | commit `6671c604766b3670ed95f405aa7856835d0ca702` / 0.85.1 | 由 infra-pi 启动；构建路径不是稳定公共包导出。每 run 单独进程，`--offline --session` 指定原生文件 | `tests/engine.test.ts`、`tests/harness.test.ts` |
| pi RPC 命令与事件 | 同上 | `get_state`、`get_available_models`、`set_model`、`get_entries`、`get_fork_messages`、`prompt`、`abort` 和 extension UI 请求/响应；JSON 形状仅在 infra-pi 内解释 | 文字/图片/工具/提问/精确模型拒绝/旧会话继续；`tests/engine.test.ts` |
| pi SessionManager `dist/core/session-manager.js` | 同上 | 仅 infra-pi 的受监督 fork worker 使用 `open/getEntry/createBranchedSession/newSession/getHeader/getEntries`，分叉在选中用户消息之前；完整原生快照先写不可变回执，再无覆盖发布到目标文件。补齐原生无 assistant 时延迟落盘的边界；不执行扩展、工具或模型。应用层不接触原生 JSON | `tests/engine.test.ts` 首条/中间/图片分叉及源保护；`tests/harness.test.ts` 草稿、幂等、丢失确认恢复 |
| pi `dist/core/auth-storage.js` / `dist/config.js` | 同上 | infra-pi 使用 `FileAuthStorageBackend.withLock` 与 `getAgentDir`；全局 settings/auth 编辑共享原生文件和锁。首次写入以 wx 创建，锁内核对进程级 HMAC 修订，保留未知字段；读取只取元数据，不解析或执行 key 命令；错误不回显文件正文 | `tests/configuration.test.ts`、`tests/settings.spec.ts` |
| pi `agent-session-services` / `settings-manager` / `project-trust` / `trust-manager` / CLI 参数与 trust context | 同上 | 工作区配置检查在分支维护锁内，由受监督 worker 使用与原生 RPC 相同的 services 和 trust resolver；保留父目录/全局信任与全局扩展钩子的原生优先级。不创建 session 或发送 prompt。检查意图持久化，重启只收束并暂停，不自动重载扩展 | `tests/configuration.test.ts` 原生 RPC 与检查一致；`tests/harness.test.ts` 互斥、丢失确认与关闭等待；`tests/project-settings.spec.ts` |
| pi `dist/core/model-runtime.js` | 同上 | 全局目录查询在受监督 worker 中调用 ModelRuntime，离线目录刷新并投影 provider/model/视觉/凭据可用性；不复制模型注册表。包括内置与 models.json，扩展注册模型仍可显式填写 ID，执行时 RPC 重新校验 | `tests/configuration.test.ts` 原生自定义模型及凭据变化；`tests/settings.spec.ts` 实际列表选择 |
| pi session JSONL header | schema version 3，同上 | 创建意图对账核对 header 类型、版本和工作区；不接受未知格式，不能以文件存在代替创建成功 | `tests/harness.test.ts` 原生创建意图恢复；`tests/recovery.test.ts` 后端 SIGKILL |
| MWF 构建入口 `packages/mwf/dist/cli.js` | commit `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` / 0.1.0 | infra-mwf 调用 add/propose；稳定 request_id、私有输入文件、原生锁/请求回执；候选不提升为正式规则；不自动初始化项目 | `tests/harness.test.ts` 原生失败与回执恢复；`tests/browser.spec.ts` 保存失败后重试 |
| Linux 监督 ABI | 当前 Linux 环境；Python 3 | prctl subreaper、pidfd、`/proc` starttime、boot ID 与 flock；未知世代或缺少清理证据时不解锁 | `tests/platform.test.ts`，包含脱离进程组、后端 SIGKILL 与延迟启动 |

MWF 锁内修订包装器已在 M4c 接入，内部入口与应用证据见下文。MWF 固定 commit 为 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` / 0.1.0，pi-mcp-adapter 为 2.32.1；应用交接记录与已接入的 MWF 长期记忆保存保持独立，不冒充 MWF schema。

升级必须先停止接收新运行并收束活动进程，处理待保存及排队项，在静止状态备份应用数据、原生会话和相关配置。更改固定版本后重跑上述真实应用契约，再补齐受影响的配置、fork 和记忆场景；不能只通过编译或探针就替换正在使用的内核。手动升级清单见 [备份与升级](backup-upgrade.md)，完整 A15 应用验收仍由 M5 记录。

用户于 2026-09-17 接受 macOS 在本机 Linux 环境（Docker Desktop/Lima）运行后端和工具。沿用 Linux 监督器；不实现或宣称 macOS 原生 subreaper。已交付 Linux 运行包及 Lima VM 挂载/loopback 转发配置，见 [运行交付](linux-runtime.md)；macOS 实机验证仍按既定决定后置。

配置限制：文件锁只能协调遵守原生锁协议的写入者，无法防止外部编辑器在锁内强行覆写或删除文件；写入仍沿用原生后端的原地保存语义，不宣称跨文件事务或断电原子性。外部已完成修改由字节修订检测，损坏文件不自动重置。工作区设置已提供原生默认模型与信任修改。provider 自定义连接编辑已在 M4b 接入；已有 OAuth 凭据沿用原生机制，当前 UI 提供 API key 编辑与凭据移除，不宣称提供 OAuth 登录向导。

配置检查会加载用户的原生全局扩展及获准的项目资源，扩展可执行本机代码，因此不能当作无副作用文件读取。应用为检查占用分支维护名额并记录监督操作，未核验收束前不释放分支。原生全局信任钩子可能覆盖或记住用户保存的 trust.json 选择；界面展示实际 resolver 结果，应用不强行传 CLI 信任覆盖。没有项目资源时，原生可以返回无需确认的允许状态；它不等于应用新写入了信任记录。

### 原生自定义连接编辑（M4b）

`infra-pi` 额外允许固定版 `core/model-config.js` 与 `utils/json.js`：使用 `ModelConfig.load/getProviderIds/getProvider/getError` 校验不可变配置快照，使用原生 `stripJsonComments` 处理 JSONC。应用输入只修改已声明连接字段；原文 HMAC 在 native 文件锁内复核，保留其他配置，错误不透传原生解析片段。校验不创建 ModelRuntime、不解析凭据命令；读取目录仍沿用已有独立监督 worker。临时私有校验快照与强杀遗留限制见 `evidence/m4-connections.md`。升级时重跑连接文件与浏览器契约测试。

### MWF 查看与带修订号的纠正（M4c）

`infra-mwf/src/worker.mjs` 在独立监督进程内使用固定 MWF `core.js` 的 `config/operate/schemas`、`storage.js` 的 `canonicalRoot/hash/recover/Transaction/withProjectLock/MWFError` 及 `protocol.js` 的 `validRecords/TYPES/boundaries/requireSafe`。应用不复制 MWF 的状态转换、索引或记录渲染逻辑。原生候选可被 recall 返回，界面保留 candidate 状态与未确认提示；失效状态遵循原生 active 规则。

原生 update 的公开 CLI 没有比较修订号后再写入的接口。本适配在相同项目锁内比较原记录 hash，再调用原生 update，将结果回执写入 `.mwf/local/parallel-pi/<request-id>.json`，与记录和索引共用同一可恢复文件事务。重试先验证请求指纹/回执，不因旧修订号再次覆盖当前记录。初始化同样保存回执，并保留已存在的 git_mode。受监督子进程收束后才释放分支维护占用；SQLite 仅保存待写意图与结果，不作为记忆正文的第二份权威来源。

查看每页 20 条，召回沿用原生最多 100 条限制；worker 仍扫描原生文件，不建独立索引。读取未初始化工作区不创建 .mwf。M4c 的证据范围是 UI 与命令 API 的原生召回和纠正；自动 agent 接入见下文 M4d。


### 自动 agent 记忆接入（M4d）

`infra-mwf/src/extension.mjs` 通过 pi 的显式扩展参数加载，调用固定版 MWF `pi-adapter.js` 的 `createAdapter`。仅已有 `.mwf/config.json` 的工作区启用 bootstrap/MCP；发送消息不会初始化记忆或安装项目资源。每次 RPC 运行重新绑定当前真实 worktree 路径。

已有项目扩展只有在路径、生成模板和内嵌配置均匹配时才复用其 bootstrap。模型 context 只保留当前适配器的最新 bootstrap；Git 跟踪扩展残留的旧绝对路径及历史 bootstrap 不进入当前模型输入，原生 JSONL 历史保持原样。该过滤仅处理已知 MWF custom message，不构成任意用户扩展的安全沙箱。

固定版 `pi-mcp-adapter` 2.32.1 已是 infra-mwf 运行时依赖。通过公开 `MCP_RUNTIME_REGISTER_EVENT` / `MCP_RUNTIME_REGISTER_VERSION` 复用已有 adapter，注册当前根目录的 `parallel_mwf` 服务；没有 adapter 时用 `createMcpAdapter` 安装应用实例。服务调用原生 MWF MCP CLI，跨根请求由原生 `ROOT_NOT_ALLOWED` 拒绝。已有用户 MCP 配置与工具保留；注册冲突显示错误，不覆盖同名服务。原生工具写入失败遵循原生 tool result；应用显式关键保存的持久化待办与暂停机制仍由 M4c 负责。

配置检查加载资源后显式结束 worker，由现有监督器收束扩展启动的 MCP 子进程后才释放维护名额。可见原生 custom message 通过 RPC notice 进入应用事件记录与会话通知，刷新后可恢复。升级契约新增 `tests/memory-agent.test.ts` 和 `tests/memory.spec.ts`，前者使用受控 provider 驱动真实 pi/MWF/MCP，并非外部模型质量验证。

### Git 提交事务基础（M4e2）

`infra-git` 增加实际提交树预览及受监督 commit/recover worker。原生 `--only`、私有 `GIT_INDEX_FILE`、`--pathspec-from-file`/NUL 路径和 `reference-transaction` 是新契约；当前在 Git 2.43.0 验证。临时钩子启动器不改写原钩子，调用原钩子时恢复原先的 `GIT_CONFIG_PARAMETERS`，使其内部 Git 命令继续读取原配置。原生消息钩子可以规范提交消息，树守卫只允许批准的文件内容。

调用方须先核验旧 worker 已收束，才能对账本地事务目录并修复 index；恢复不重放钩子。外部 index/branch 变化或未知锁归属返回 uncertain，不能自动覆盖。核心阶段测试边界见 `evidence/m4-git-commit-core.md`；应用入口已在下述 M4e3 接入。Git 预览修订现在同时绑定原始状态和实际显示的 diff；选择后的提交预览另绑定原生过滤后的树。


### Git 应用任务与外部核对（M4e3）

SQLite 原子保存提交意图和第一项操作，HTTP 重试沿用原请求身份并校验完整意图。实际树预览、提交、恢复与明确外部核对使用受监督 worker；恢复时的仓库身份检查也在该 worker 内完成。同分支所有旧操作均已收束后才允许事务恢复，不以 HTTP 连接或页面生命周期判断提交结束。

外部核对仅在用户明确确认后记录 reviewed 回执，移除仍属于原事务的索引锁，保留当前 ref/index/工作区和原不确定原因；未知归属的锁仍拒绝处理。后续恢复读取该回执，不再自动修复索引。此流程不声明原提交成功，分支保持暂停直到用户明确恢复。应用测试和浏览器证据见 `evidence/m4-git-commits.md`。
