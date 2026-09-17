# 原生依赖与升级契约

版本权威：`probes/versions.json`。本表记录应用当前实际依赖；探针专用包装器不算正式应用实现。

| 依赖入口 | 固定基线 | 实际使用及边界 | 应用回归证据 |
| --- | --- | --- | --- |
| pi 构建入口 `packages/coding-agent/dist/rpc-entry.js` | commit `6671c604766b3670ed95f405aa7856835d0ca702` / 0.85.1 | 由 infra-pi 启动；构建路径不是稳定公共包导出。每 run 单独进程，`--offline --session` 指定原生文件 | `tests/engine.test.ts`、`tests/harness.test.ts` |
| pi RPC 命令与事件 | 同上 | `get_state`、`get_available_models`、`set_model`、`get_entries`、`get_fork_messages`、`prompt`、`abort` 和 extension UI 请求/响应；JSON 形状仅在 infra-pi 内解释 | 文字/图片/工具/提问/精确模型拒绝/旧会话继续；`tests/engine.test.ts` |
| pi SessionManager `dist/core/session-manager.js` | 同上 | 仅 infra-pi 的受监督 fork worker 使用 `open/getEntry/createBranchedSession/newSession/getHeader/getEntries`，分叉在选中用户消息之前；完整原生快照先写不可变回执，再无覆盖发布到目标文件。补齐原生无 assistant 时延迟落盘的边界；不执行扩展、工具或模型。应用层不接触原生 JSON | `tests/engine.test.ts` 首条/中间/图片分叉及源保护；`tests/harness.test.ts` 草稿、幂等、丢失确认恢复 |
| pi session JSONL header | schema version 3，同上 | 创建意图对账核对 header 类型、版本和工作区；不接受未知格式，不能以文件存在代替创建成功 | `tests/harness.test.ts` 原生创建意图恢复；`tests/recovery.test.ts` 后端 SIGKILL |
| MWF 构建入口 `packages/mwf/dist/cli.js` | commit `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` / 0.1.0 | infra-mwf 调用 add/propose；稳定 request_id、私有输入文件、原生锁/请求回执；候选不提升为正式规则；不自动初始化项目 | `tests/harness.test.ts` 原生失败与回执恢复；`tests/browser.spec.ts` 保存失败后重试 |
| Linux 监督 ABI | 当前 Linux 环境；Python 3 | prctl subreaper、pidfd、`/proc` starttime、boot ID 与 flock；未知世代或缺少清理证据时不解锁 | `tests/platform.test.ts`，包含脱离进程组、后端 SIGKILL 与延迟启动 |

尚未接入正式应用的内部依赖：pi 原生配置/认证编辑、MWF 锁内修订包装器。对应探针仅用于实施参考，落地时必须补入本表及应用测试。MWF 固定 commit 为 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` / 0.1.0，pi-mcp-adapter 为 2.32.1；应用交接记录与已接入的 MWF 长期记忆保存保持独立，不冒充 MWF schema。

升级必须先停止接收新运行并收束活动进程，处理待保存及排队项，在静止状态备份应用数据、原生会话和相关配置。更改固定版本后重跑上述真实应用契约，再补齐受影响的配置、fork 和记忆场景；不能只通过编译或探针就替换正在使用的内核。完整手动升级清单由 M4/M5 交付。

用户于 2026-09-17 接受 macOS 在本机 Linux 环境（Docker Desktop/Lima）运行后端和工具。沿用 Linux 监督器；不实现或宣称 macOS 原生 subreaper。容器启动打包及挂载约定在 M4/M5 完成，macOS 实机验证仍按既定决定后置。
