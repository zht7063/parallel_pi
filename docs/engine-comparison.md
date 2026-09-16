# pi 与 omp：MVP 内核选型分析

状态：用户已确认首版采用原版 pi；具体版本与 RPC / SDK 接入方式待集成验证。核查日期：2026-09-16。

## 结论

已确认采用上游原版 **pi**（earendil-works/pi，原 badlogic/pi-mono）作为 parallel_pi MVP 内核，通过 Git submodule 引入。理由是它已具备所需的会话持久化、分叉与流事件，当前 RPC 还直接提供完整树和增量条目读取；用户现有 Memory with Files 已有 pi 适配路径。此结论是接口和集成范围的判断，不代表运行速度、稳定性或模型效果的实测比较。

omp 同样可以实现本产品。若后续明确需要其内置 MCP、子 agent 管理或远程 host tool 协议，再评估迁移更合理。首版仅接入 pi，omp 比较保留为选型依据。

## 研究边界与固定版本

只阅读官方源码与文档，没有安装、构建、调用模型、运行兼容性测试或添加 submodule。Git HEAD 在本次研究中解析为：

- [pi：6671c604766b3670ed95f405aa7856835d0ca702](https://github.com/earendil-works/pi/tree/6671c604766b3670ed95f405aa7856835d0ca702)
- [omp：acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a](https://github.com/can1357/oh-my-pi/tree/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a)

以下结论针对上述版本；上游 main 会变化。集成前还需检查许可证、锁定依赖并运行验收。

## 与已确认需求的匹配

| 能力 | pi | omp | 对 parallel_pi 的影响 |
|---|---|---|---|
| 恢复已有会话 | SDK `SessionManager.open`；RPC `switch_session` | 同类 SDK 恢复接口；RPC `switch_session` | 两者都可作为历史会话继续执行的基础 |
| 从历史创建思路 | RPC `fork`、`get_fork_messages` | RPC `branch`、`get_branch_messages` | 名称不同；这些入口以历史用户消息为分叉点，不能假设任意图节点都可直接调用 |
| 完整会话树读取 | RPC `get_tree`、`get_entries`；SDK 也提供树读取 | 当前 RPC 命令联合类型未提供这两个命令；SDK `SessionManager.getTree/getEntries` 可用 | pi 的直接 RPC 更适合地图同步；omp 可走 SDK 或增加桥接 |
| 树内导航 | SDK `AgentSession.navigateTree` | SDK `AgentSession.navigateTree` | 两者当前直接 RPC 命令均未列出 `navigate_tree`，不能把“可读取树”等同于“可通过 RPC 任意导航” |
| 文本和工具流 | RPC JSONL；SDK `subscribe` | RPC JSONL；SDK `subscribe` | 两者都能支撑 Web 流式展示 |
| 停止执行 | RPC `abort` / SDK `abort`，另有 Bash、重试控制 | RPC `abort` / SDK `abort`，另有 `abort_and_prompt` 等 | 停止完成与排队任务调度必须由 harness 明确协调 |
| 多 Git 分支执行 | 给实例指定各自工作目录 | 给实例指定各自工作目录 | worktree 创建、分支队列与互斥由 parallel_pi 管理 |

接口证据：[pi RPC 类型][pi-rpc]、[pi RPC 实现][pi-rpc-mode]、[pi SDK][pi-sdk]、[pi AgentSession][pi-session]、[omp RPC 类型][omp-rpc]、[omp SDK][omp-sdk]、[omp AgentSession][omp-session]、[omp SessionManager][omp-manager]。

思路分支属于产品领域概念，不能机械照搬内核术语：原生会话文件、文件内部树节点、界面的会话卡片是三个层次。必须保存 `project → Git branch/worktree → thought/session → engine session/entry` 的映射。所有思路仍使用所属 Git 分支的当前代码，分叉不恢复代码版本。

## SDK 还是 stdio RPC

**建议优先以 pi stdio RPC 做最小验证，但接入方式保持待验证。**

| 接入方式 | 适用点 | 主要代价 |
|---|---|---|
| 原生 stdio RPC 子进程 | UI 后端不直接依赖内核对象；每个活跃 Git 分支可有独立进程与 cwd；pi 已提供地图所需读取接口 | 要实现 JSONL framing、关联请求、进程退出处理；原生协议不暴露所有 SDK 能力 |
| SDK 包装进独立 worker | 可直接调用完整树导航和会话管理；更适合精确控制上下文分叉语义 | 包版本和生命周期耦合更强，需要维护自己的窄桥接接口 |
| 所有 SDK 实例放主服务进程 | 少一层进程通信 | 扩展与运行时状态隔离需要额外验证；一个异常可能影响多个分支 |

以上是架构权衡，不是对 SDK 稳定性的实测结论。若 MVP 定义“思路分支 = 从用户消息 fork 成新会话文件，之后 switch_session”，pi 原生 RPC 已覆盖主要路径；若必须在同一内核树内任意节点导航，则应验证 SDK worker，不应为了沿用 RPC 而改变产品语义。[pi RPC][pi-rpc] [pi SDK][pi-sdk]

## 两个更具体的差异

### Memory with Files

用户现有技能仓库的 [setup.ts][mwf-setup] 已有 pi 注册逻辑：`.pi/mcp.json`、固定版本的 `pi-mcp-adapter` 及 `.pi/extensions/mwf.js`。[check-pi.ts][mwf-check] 还定义了 loader/runner 和 bootstrap/resume 验收流程。因此选 pi 可以复用已有适配经验。

但这些是已存在的实现和测试脚本，并非本次验证通过：其适配包含 `dist/core` 内部路径依赖，必须与选定 pi 提交核对。也不能因为 omp 源自 pi 就推断现有适配无需修改。技能本身的文件记忆设计仍可供两者采用。

### 功能范围和源码构建

omp 的 RPC 类型含子 agent 查询/订阅、host tool、URI scheme 等接口，SDK 文档也描述 MCP 发现；适合需要这些内置能力的宿主。[omp RPC][omp-rpc] [omp SDK][omp-sdk] 本 MVP 首先需要外层 Git 分支队列和对话地图，这些能力并不会替代产品调度。

pi 根 [package.json][pi-package] 要求 Node >=22.19，并使用 npm workspace 构建；不能把它描述成“纯 TypeScript、零原生依赖”。omp [README 的开发说明][omp-readme] 要求源码启动前执行 `bun setup`，构建 Rust/N-API addon。因此对于以 submodule 从源码跟进的方案，omp 多了一套需要管理的 Bun/Rust 构建链；不据此推断其运行性能或安装成功率。

## 无论选择谁，harness 都需要负责的部分

1. **分支级队列。** 每个 Git 分支同时只有一个思路执行；切换会话、压缩上下文和记忆写入等操作也应纳入状态约束。内核 steer/follow-up 队列不能替代跨会话调度。
2. **会话与代码绑定。** 启动、恢复时核对 cwd/worktree；不能让恢复旧会话悄悄指向别的工作区。
3. **持久化与恢复。** 保存产品映射、排队项和运行状态；内核保存模型对话，两者分工明确。请求被接受不等于任务完成，刷新后不能重复发送原任务。
4. **取消与进程退出。** 在停止完成、相关工具子进程已收束并确认工作区不再被写入后才释放执行权。pi 有独立 `clear_queue`；应用最好自行保管跨思路排队项，避免 abort 后内核队列继续执行。[pi RPC 实现][pi-rpc-mode]
5. **隔离边界。** 独立 worktree 隔离代码，不隔离端口、数据库、凭证或共享记忆文件；子进程也不等于安全沙箱。
6. **可控升级。** submodule 固定提交；更新提交前验证接口、事件及旧会话兼容性。不要把“及时更新”实现为每次启动自动拉取 main。

## 选型落地前的最小验收

以下是下一阶段建议，当前均未执行：

- 创建两个 worktree，运行两个 agent；验证一列排队、两列并行及 cwd 归属。
- 跑通 prompt、文本/工具流、完成/失败、取消；验证队列不会误启动。
- 从用户消息分叉并继续，验证地图父子关系，以及代码完全保留当前版本。
- 后端重启后恢复两条思路，验证旧记录、当前节点及待执行任务不会重复发送。
- 装载选定版本的 Memory with Files 适配，验证新会话按需召回与会话结束写入。
- 用上一固定版本的会话样本做升级兼容检查。

建议通过这些验收后再正式确定“pi + 原生 RPC”或“pi + SDK worker”。

[pi-rpc]: https://github.com/earendil-works/pi/blob/6671c604766b3670ed95f405aa7856835d0ca702/packages/coding-agent/src/modes/rpc/rpc-types.ts
[pi-rpc-mode]: https://github.com/earendil-works/pi/blob/6671c604766b3670ed95f405aa7856835d0ca702/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[pi-sdk]: https://github.com/earendil-works/pi/blob/6671c604766b3670ed95f405aa7856835d0ca702/packages/coding-agent/docs/sdk.md
[pi-session]: https://github.com/earendil-works/pi/blob/6671c604766b3670ed95f405aa7856835d0ca702/packages/coding-agent/src/core/agent-session.ts
[pi-package]: https://github.com/earendil-works/pi/blob/6671c604766b3670ed95f405aa7856835d0ca702/package.json
[omp-rpc]: https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/src/modes/rpc/rpc-types.ts
[omp-sdk]: https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/docs/sdk.md
[omp-session]: https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/src/session/agent-session.ts
[omp-manager]: https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/src/session/session-manager.ts
[omp-readme]: https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/README.md
[mwf-setup]: https://github.com/zht7063/skills/blob/7b8be0e59647c90227c0cb945b279d7fa7ab14ef/packages/mwf/src/setup.ts
[mwf-check]: https://github.com/zht7063/skills/blob/7b8be0e59647c90227c0cb945b279d7fa7ab14ef/packages/mwf/scripts/check-pi.ts
