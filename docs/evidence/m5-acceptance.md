# M5 完整验收工作表

本表依据 `docs/mvp-spec.md` 的 C01–C14/A01–A16 和 `docs/implementation-handoff.md` 的 I01–I07。现有阶段测试只是证据入口，必须核对实际断言与完整行为，不能因标题相似就关闭条目。当前不是 MVP 完成报告。

| 条目 | 完整通过条件 | 现有证据入口 | M5 状态 / 待核对 |
| --- | --- | --- | --- |
| A01 | dirty 项目、另一分支 worktree，保留原修改且不搬运 | git.test.ts、harness.test.ts、browser.spec.ts | 待最终复核 |
| A02 | 远端分支本地化、名称冲突不覆盖、不自动 merge | harness.test.ts 的 branch intentions、map.spec.ts | 待最终复核 |
| A03 | 单/双击不漂移，浮层/返回恢复视口，不启动运行 | map.spec.ts | 待键盘与完整浏览器复核 |
| A04 | 继续/接续/独立/fork、来源、图边、当前代码语义 | harness.test.ts、engine.test.ts、map.spec.ts | 待失败/取消后的历史边界和来源复核 |
| A05 | 同列互斥、跨列并行、默认并发 2 且可配 | domain.test.ts、harness.test.ts | 待最终复核；M5a 补齐元数据检查占用 |
| A06 | 等待持有名额、失败暂停、其他列继续 | harness.test.ts、browser.spec.ts | 待失败后原生历史与持久状态核对 |
| A07 | 收束前不解锁、取消暂停、修改保留、不假报超时成功 | platform.test.ts、harness.test.ts、recovery.test.ts | 待完整进程边界复核 |
| A08 | 切项目/刷新/关闭网页保持草稿历史和后台任务，重连不重跑 | browser.spec.ts、map.spec.ts、http-workspace.test.ts | 待最终复核 |
| A09 | 重启中断准确，残留收束后明确恢复，不重放 | recovery.test.ts、harness.test.ts、git-commit.test.ts | M5a 已补真实仓库检查 SIGKILL；Git 提交期间真实后端强杀组合仍待补强 |
| A10 | 模型改变范围明确，排队选择冻结，无静默替换 | configuration.test.ts、project-settings.spec.ts、harness.test.ts | 待最终复核及真实外部模型应用调用 |
| A11 | 图片可预览移除、真实送达、不支持时明确阻止 | browser.spec.ts、engine.test.ts、harness.test.ts | 待最终复核 |
| A12 | 来源/scope、并发纠正、失败暂停、同请求重试或明确继续 | memory.test.ts、memory-agent.test.ts、memory.spec.ts、harness.test.ts | 待完整应用验收归档 |
| A13 | dirty diff、明确范围提交、运行互斥、钩子失败、不 push/merge/扩大暂存 | git.test.ts、git-commit.test.ts、git-commit.spec.ts | 待与 A09 的提交故障组合、确认丢失边界复核 |
| A14 | 项目顺序、切换不重排、草稿状态隔离 | map.spec.ts、browser.spec.ts | 待最终复核 |
| A15 | 升级后的旧会话打开/继续/fork，MWF 召回/写入 | probes/v01-upgrade.test.mjs、原生契约表 | 必须补应用级旧会话升级验证，探针不替代 |
| A16 | 键盘替代双击、窄窗口、空/错/加载、错误可恢复、不虚报进度 | 全部浏览器 spec、DESIGN.md | 待完整复核、未绑定检查在刷新后的恢复提示及最终截图审查 |

C01–C14 的追踪映射沿用规格第 11 节；I01 的依赖方向/公开入口/循环检查继续作为必过检查。I02/I03 的恢复覆盖本轮 M5a 的新增问题；I04/I05/I06 与 A10/A12/A15 对齐；I07 需真实 UI 与内核贯通。固定版本、外部模型和确定性 provider 证据分开记录。

## 本轮发现与修复

### M5a：仓库元数据检查绕过进程监督

真实复现命令：`node --test --test-name-pattern='metadata inspection reaps' tests/git.test.ts`。修复前返回 `Missing expected exception: metadata reads must not leave hook descendants alive`：原生 Git status 调用 fsmonitor，后者启动脱离进程组的 sleep，inspect 已返回但子进程仍存活。

根因是 inspect/validate/reconcileWorktree 直接调用主进程的 execFile 辅助函数；之前只覆盖了变更预览和写操作。当前仓库检查与创建分支的前置解析整体由 repository-worker 执行，沿用 Linux 监督器的 ECHILD 收束证据。绑定核验只查询所需身份，不再无谓触发完整 dirty 扫描；原生 Git 的 fsmonitor/过滤器配置没有被禁用或改写。

应用先保存 inspect-repository 操作，再启动 worker。尚未登记项目时 laneId=null；运行中读取不会被并发添加项目误判为遗留检查。重启只收束旧检查，不自动重做；未确认的无分支检查会阻止新操作，用户可通过明确重试添加项目再次核对，证据未齐不绕过。项目已登记而分支列尚未写入时，刷新仍可重建分支。

项目添加全过程参与关闭等待；项目刷新与该项目的执行/维护互斥。重复添加已有仓库别名只做身份核对，不在正在运行的仓库上额外触发 dirty 扫描。分支检查、创建、worktree 对账及运行前后核验均走持久操作。

新增真实证据：

- Git fsmonitor 脱离后代在 inspect 返回前消失。
- 两个项目并发添加时互不误取消；重复添加正在检查的仓库明确拒绝；关闭等待已接受的检查完成。
- 未绑定检查在启动时不重放，收束未证实时拒绝，明确重试在证据齐全后恢复。
- 后端在 fsmonitor 中被 SIGKILL，重启时脱离子进程已消失；未登记的项目不被误报成功；只有明确重试才再次运行钩子；代码和索引保持原样。

原始专项与最终生命周期专项已通过。`npm run check` 全部 61 项测试及架构/类型/格式检查通过，构建与完整 10 项浏览器测试通过。最终审查补上 worker 切换 cwd 前解析相对路径：回归先出现 `Git operation failed`，修正后完整 6 项 Git 测试及类型/格式检查通过。M5a 只关闭这个具体缺口，不代表 A01–A16 全部完成。
