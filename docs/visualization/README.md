# parallel_pi 项目结构说明

[打开交互式架构图](project-structure.html) · [图表源文件](project-structure.architecture.json)

依据 2026-09-16 工作区中的 [已确认架构 v0.3](../architecture.md)、[MVP 规格](../mvp-spec.md) 和 [领域术语](../CONTEXT.md)。当前仓库只有设计文档和静态线框，尚无应用实现、pi 子模块或探针结果。图中组件均为计划结构；五层职责、具体分层、依赖与技术组合已确认，前端采用 Vue 3 + TypeScript。架构确认不表示已实现或已通过技术探针。

## 怎么读这张图

主线为浏览器展示层 → HTTP/SSE 传输层 → 应用用例 → Engine Interface → Pi Adapter / pi 子进程。箭头表示运行时调用或通信关系，不表示源码 import。适配器与其访问的资源合并显示，以保持总览清晰。

应用层调用领域规则，并通过自己声明的 Interface 使用外部能力。基础设施实现这些 Interface；应用层不导入基础设施实现。`apps/server` 负责创建与注入对象、启动和关闭，不承载业务规则。`contracts` 只定义可传输的请求、响应与事件，Web 和 Transport 共同使用。

源码依赖方向：

```text
web ───────────────────→ contracts
transport ─────────────→ contracts + application
application ───────────→ domain
infra-* ───────────────→ application 的 ports + domain
server ────────────────→ transport + application + infra-*
```

五层不对应五个进程。建议部署形态是浏览器、一个本地后端和受监督的 pi 子进程。应用层、领域层、传输层和适配器位于后端；图中 Pi 节点合并了进程内适配器与进程外内核。平台监督由应用协调，Pi Adapter 使用注入的监督 Interface，不导入 `infra-platform` 实现。

## 计划目录与职责

下列路径尚未创建；它们来自架构草案，而不是现有工程清单。

| 计划路径 | 职责 |
| --- | --- |
| `apps/web/` | 全局地图、会话、表单、草稿与视口交互 |
| `apps/server/` | 唯一装配入口；配置依赖、启动与关闭 |
| `packages/contracts/` | 公共请求、响应与事件 schema |
| `packages/transport/` | HTTP/SSE、输入与会话校验、错误及协议映射 |
| `packages/domain/` | Session / Run / Lane、状态迁移、模型与调度规则；无 I/O |
| `packages/application/` | execution、workspace、session、configuration、memory 用例与 ports |
| `packages/infra-pi/` | pi 协议、事件转换、原生会话及配置接入 |
| `packages/infra-git/` | Git CLI、仓库身份、worktree、index 与提交 |
| `packages/infra-storage/` | SQLite 事务、附件文件、数据迁移 |
| `packages/infra-mwf/` | MWF runtime、修订检查及错误映射 |
| `packages/infra-platform/` | Linux/macOS 进程监督、路径与实例锁 |
| `vendor/pi/` | 后续引入并锁定 commit 的原版 pi 子模块 |
| `probes/` | V01–V04 真实集成验证 |

## 数据与执行边界

| 信息 | 权威归属 |
| --- | --- |
| 项目、会话图、队列、Run 状态、操作意图 | 应用 SQLite（建议） |
| 模型上下文、原生会话树 | pi 原生会话文件 |
| 代码、HEAD、index、当前工作区 | Git / worktree |
| 长期知识与偏好 | 每个 worktree 的 MWF 文件 |
| provider 凭据与内核配置 | pi 原生机制；应用不复制凭据 |
| 草稿、视口、附件、逐 Run 交接记录 | 应用本地数据区；浏览器缓存对账 |

一个 Project 包含多个 BranchLane；一个 Lane 包含多个 Session；一个 Session 可执行多个 Run。SessionEdge 表示同一 Lane 内的接续或分叉关系，不能跨 Git 分支创建思路边。

同 Git 分支内串行、不同 Git 分支之间并行。Session 的思路分叉只分出对话上下文，使用该 Git 分支的当前代码，不恢复历史文件。停止或重启后，必须核验旧进程已收束才能释放工作区；不能自动重放模型任务。

主图省略了内核到工作区与 MWF 的具体访问边：pi 在已核验 cwd 中执行工具，MWF 扩展也可从 pi 内调用；UI 记忆纠正走应用层与 MWF Adapter。两条记忆写入路径必须遵守共同的写入协调与修订检查。执行成功与记忆保存成功是独立状态。

## 尚待验证的选择

- V01：固定 pi 版本，验证恢复、分叉、图片、提问、取消；据实选择 RPC 或独立 SDK worker，以及每 Run 进程或复用方式。
- V02：真实 worktree 与队列、幂等、崩溃窗口和进程收束；Linux/macOS 分别验证。
- V03：模型、认证及多 worktree 的配置来源和写入语义。
- V04：MWF 召回、保存、修订冲突、幂等重试及交接入口。

Vue 3 / TypeScript / Node.js / SQLite / HTTP+SSE 为已确认组合，具体库与版本尚未锁定。手动检查上游更新、优先 Linux/macOS 已确认；omp 暂缓。此图没有将已确认架构标为已实现或将探针标为已通过。

## 交付记录

图表类型：`architecture`。静态验收：showcase 9/9，0 错误、0 警告。源文件与 HTML 的 SHA-256、字节数见 [交付回执](delivery-receipt.json)；浏览器结果见 [浏览器回执](project-structure.visual-check.json)。浏览器验收与视觉复核不等于项目功能验收。

浏览器验收通过：1440×900、1600×1000、1920×1080、2048×1320 均无页面溢出，浅深色端点截图已生成。目视复核因截图读取工具不可用而跳过；不声称视觉复核通过。完整状态见 [复核记录](review-receipt.json)，截图见 [截图图册](project-structure.visual-check.html)。
