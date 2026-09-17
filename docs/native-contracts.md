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

尚未接入正式应用的内部依赖：MWF 锁内修订包装器。对应探针仅用于实施参考，落地时必须补入本表及应用测试。MWF 固定 commit 为 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` / 0.1.0，pi-mcp-adapter 为 2.32.1；应用交接记录与已接入的 MWF 长期记忆保存保持独立，不冒充 MWF schema。

升级必须先停止接收新运行并收束活动进程，处理待保存及排队项，在静止状态备份应用数据、原生会话和相关配置。更改固定版本后重跑上述真实应用契约，再补齐受影响的配置、fork 和记忆场景；不能只通过编译或探针就替换正在使用的内核。完整手动升级清单由 M4/M5 交付。

用户于 2026-09-17 接受 macOS 在本机 Linux 环境（Docker Desktop/Lima）运行后端和工具。沿用 Linux 监督器；不实现或宣称 macOS 原生 subreaper。容器启动打包及挂载约定在 M4/M5 完成，macOS 实机验证仍按既定决定后置。

配置限制：文件锁只能协调遵守原生锁协议的写入者，无法防止外部编辑器在锁内强行覆写或删除文件；写入仍沿用原生后端的原地保存语义，不宣称跨文件事务或断电原子性。外部已完成修改由字节修订检测，损坏文件不自动重置。工作区设置已提供原生默认模型与信任修改。provider 自定义连接编辑仍待 M4；已有 OAuth 凭据沿用原生机制，当前 UI 提供 API key 编辑与凭据移除，不宣称提供 OAuth 登录向导。

配置检查会加载用户的原生全局扩展及获准的项目资源，扩展可执行本机代码，因此不能当作无副作用文件读取。应用为检查占用分支维护名额并记录监督操作，未核验收束前不释放分支。原生全局信任钩子可能覆盖或记住用户保存的 trust.json 选择；界面展示实际 resolver 结果，应用不强行传 CLI 信任覆盖。没有项目资源时，原生可以返回无需确认的允许状态；它不等于应用新写入了信任记录。
