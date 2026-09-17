# M2 执行与恢复闭环：阶段证据

2026-09-17，Linux、Node.js 26.8.2、npm 11.19.1。固定 pi 与 MWF 版本见 `probes/versions.json`。下列是正式应用证据；真实 pi 使用可控 provider，不声称是本轮真实外部模型验证。

| 门槛 | 已实现的行为与证据 | 后续义务 |
| --- | --- | --- |
| I02 进程收束 | `tests/platform.test.ts`：正常退出、double-fork/setsid、后端 SIGKILL、延迟启动 tombstone、PID 世代和无回执保守阻止；信号之间插入调度延迟，确认不会先唤醒等待中的 shell。`tests/harness.test.ts`：等待提问时停止、清除问题、暂停后项并明确恢复 | macOS 本机 Linux 启动打包；M5 完整环境验收 |
| I03 pending 与恢复 | `tests/harness.test.ts`：原生 session 已落盘但应用 pending 的对账；`tests/git.test.ts`：真实 worktree 产物及歧义保护；`tests/recovery.test.ts`：完整后端崩溃、工具 PID 收束、queued 保留、无重发、明确恢复 | M3 fork 意图与对应崩溃窗口 |
| I04 模型与配置 | `tests/engine.test.ts`：精确模型不可用拒绝；`tests/harness.test.ts`：入队固定模型、更新 session 不改变旧 run；图片持久化与模型能力校验 | M4 原生凭据/配置编辑、信任与修订冲突 |
| I05 关键保存 | 应用交接文件与执行结果分离，原子发布、同内容幂等、不覆盖冲突；真实文件故障后暂停，重启只重试存储。原生 MWF add/propose 通过应用保存任务调用，固定 request_id，丢失确认后重放同一原生回执，不新增模型调用；候选、来源、worktree 隔离、明确继续均在 `tests/harness.test.ts`；浏览器验证失败、刷新与重试 | M4 初始化选择、agent 召回、锁内修订和完整记忆面板；不能将此阶段等同 A12 全部通过 |
| I06 固定入口契约 | `docs/native-contracts.md` 登记 pi RPC/构建入口、session v3 header、MWF CLI 及 Linux ABI；真实适配测试锁定当前行为 | 配置认证、fork、MWF 修订内部接口实际接入时追加契约；M4/M5 完整升级步骤 |
| I07 UI 贯通 | `tests/browser.spec.ts`：真实项目→会话→图片/文本→持久化→刷新；草稿、丢失确认重试无重复、提问、停止/恢复、窄窗口、键盘、交接/MWF 保存失败恢复。受控挂起旧 activity 请求后，新 run 仍显示工具活动 | M3 完整地图/导航/多项目，M5 全键盘与更完整状态矩阵 |

退出命令：`npm run check`（25 项 Node 测试，另含架构/类型/格式）、`npm run build`、`npm run test:browser`（3 个场景；环境参数见 development.md）。UI strict 审查结果存于 `m2-ui-audit.json`。浏览器截图/trace 为本机忽略产物，验收可按测试重现。

实现限制：SQLite 元数据为单 JSON 文档，命令重写开销随元数据增长；事件独立追加。交接观察文本最多 20,000 字符，截断显式标记，完整事件和原生会话另存；它不是自动生成的经验证长期结论。监督器自身被 SIGKILL 且没有收束回执时保持 recovering，不能用 PID 消失或超时假报安全。

M2 完成仅证明上述纵向闭环，不宣称完整 MVP 或 A01–A16 全部通过。M3、M4、M5 仍须按原规格实施，不删减地图、fork、远端分支、模型配置、记忆纠正、diff/提交、备份/升级或 macOS 启动交付。
