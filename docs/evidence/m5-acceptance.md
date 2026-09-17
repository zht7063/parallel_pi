# M5 完整验收工作表

本表依据 `docs/mvp-spec.md` 的 C01–C14/A01–A16 和 `docs/implementation-handoff.md` 的 I01–I07。现有阶段测试只是证据入口，必须核对实际断言与完整行为，不能因标题相似就关闭条目。当前不是 MVP 完成报告。

| 条目 | 完整通过条件 | 现有证据入口 | M5 状态 / 待核对 |
| --- | --- | --- | --- |
| A01 | dirty 项目、另一分支 worktree，保留原修改且不搬运 | git.test.ts、harness.test.ts、browser.spec.ts | 待最终复核 |
| A02 | 远端分支本地化、名称冲突不覆盖、不自动 merge | harness.test.ts 的 branch intentions、map.spec.ts | 待最终复核 |
| A03 | 单/双击不漂移，浮层/返回恢复视口，不启动运行 | map.spec.ts | 待键盘与完整浏览器复核 |
| A04 | 继续/接续/独立/fork、来源、图边、当前代码语义 | harness.test.ts、engine.test.ts、map.spec.ts | M5b 已验证失败/取消/重启历史及取消点分叉；来源与完整 A04 待最终复核 |
| A05 | 同列互斥、跨列并行、默认并发 2 且可配 | domain.test.ts、harness.test.ts | 待最终复核；M5a 补齐元数据检查占用 |
| A06 | 等待持有名额、失败暂停、其他列继续 | harness.test.ts、browser.spec.ts | M5b 已补失败部分回答与持久历史；完整 A06 待最终复核 |
| A07 | 收束前不解锁、取消暂停、修改保留、不假报超时成功 | platform.test.ts、harness.test.ts、recovery.test.ts | 待完整进程边界复核 |
| A08 | 切项目/刷新/关闭网页保持草稿历史和后台任务，重连不重跑 | browser.spec.ts、map.spec.ts、http-workspace.test.ts | 待最终复核 |
| A09 | 重启中断准确，残留收束后明确恢复，不重放 | recovery.test.ts、harness.test.ts、git-commit.test.ts | M5a/M5d 已补仓库检查及 pre/post-commit 真实后端 SIGKILL；完整恢复条目待最终汇总 |
| A10 | 模型改变范围明确，排队选择冻结，无静默替换 | configuration.test.ts、project-settings.spec.ts、harness.test.ts | 待最终复核及真实外部模型应用调用 |
| A11 | 图片可预览移除、真实送达、不支持时明确阻止 | browser.spec.ts、engine.test.ts、harness.test.ts | 待最终复核 |
| A12 | 来源/scope、并发纠正、失败暂停、同请求重试或明确继续 | memory.test.ts、memory-agent.test.ts、memory.spec.ts、harness.test.ts | 待完整应用验收归档 |
| A13 | dirty diff、明确范围提交、运行互斥、钩子失败、不 push/merge/扩大暂存 | git.test.ts、git-commit.test.ts、git-commit.spec.ts | M5d 已补后端强杀与浏览器 HTTP 确认丢失重试；完整 Git 条目待最终汇总 |
| A14 | 项目顺序、切换不重排、草稿状态隔离 | map.spec.ts、browser.spec.ts | 待最终复核 |
| A15 | 升级后的旧会话打开/继续/fork，MWF 召回/写入 | harness.test.ts 的 application upgrade、memory-agent.test.ts、memory.test.ts、原生契约表 | M5c 应用级固定样本通过；支持声明限于已验证的 0.84.1 → 0.85.1，最终回归仍须包含此项 |
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


### M5b：失败、取消和重启后的原生历史

最小复现命令：`node --test --test-name-pattern='failed native turns' tests/harness.test.ts`。固定 provider 驱动真实 pi 保存用户消息与失败回答；修复前应用 history 返回空，断言为 `undefined`，预期 `probe-failed-turn`。文件已实际保存这两条内容，排除了原生未落盘；成功路径以外没有更新应用缓存是直接原因。

现在在监督器证明写进程收束后，以固定 pi 的只读解析和内存 SessionManager 重建缓存。启动时补齐静止会话历史，恢复中的分支先核验全部遗留进程。读取不会打开模型、扩展或工具，不写原生文件、不重放提示。读取失败保留已有缓存、将分支置为 recovering；修复原文件后通过既有恢复核对入口转为 paused，再由用户明确恢复队列。运行结果与历史恢复状态分离，不把已完成的模型运行改报失败。

专项 `failed and cancelled native turns survive restart, fork and explicit recovery` 覆盖真实模型错误的部分回答、真实 Bash 中途取消、旧空缓存重建、读取前后原生文件字节不变、从取消提问之前分叉（原问题进入草稿）、损坏 header 保留缓存、修复后继续时模型收到此前提问。真实 backend SIGKILL 测试新增 HTTP history 断言，证明重启后中断提问和工具调用可见且未重复。浏览器主闭环新增取消后刷新仍显示该提问、排队项仍未启动的断言。

本项不扩大为任意旧 pi 版本或任意损坏文件修复承诺；原生解析沿用其对不完整/无法解析 JSONL 行的处理，应用不重写源文件。A15 的 0.84.1 旧会话应用兼容由后续 M5c 独立验收。

验证结果：`npm run check` 62 项 Node 测试、架构、类型及格式检查全部通过；`npm run build` 通过；完整 10 项浏览器测试通过。日志 `/tmp/parallel-pi-m5b-check.log`、`/tmp/parallel-pi-m5b-build.log`、`/tmp/parallel-pi-m5b-browser.log`。本段独立提交，M5 全部条目的最终验收仍未结束。


### M5c：应用旧会话升级与记忆契约

命令：`node --test --test-name-pattern='application upgrade opens' tests/harness.test.ts`。测试使用真实 pi 0.84.1 SessionManager 生成的已归档样本，先核对原始 SHA-256，再仅调整 header 的 cwd 到隔离工作区；历史条目的原始字节保留。消息内容为合成样本，执行模型为受控 provider，不能作为真实外部模型证据，也不代表所有历史版本兼容。

应用先创建真实项目、会话元数据和原生 MWF 记录，然后停机关闭 SQLite，把会话文件替换为上述旧格式样本，重开磁盘数据库并初始化当前 0.85.1 应用。此设置模拟持久应用引用旧原生日志；没有捏造历史 run，也不宣称运行了旧版 parallel-pi 应用。

明确断言：

- 应用 history 打开原来的四条消息，原生文件字节不变，无 run 被自动创建。
- 明确继续后，真实当前 pi 收到旧的两条用户上下文及新提问；旧消息的 ID/内容/分叉属性保持一致。
- 从旧的第二条提问分叉，只复制该提问之前的两条消息，提问进入子会话草稿，来源关联保存；子会话执行只收到原第一条提问和新的分叉输入，源文件保持不变。
- 升级前的 MWF 记录按 code 路径仍可召回，文件字节不变；升级后从子会话及其 run 保存新记录成功，两条记录均可召回，新记录保留来源。原 dirty 工作文件保持原样。

补充契约命令：`node --test tests/memory.test.ts tests/memory-agent.test.ts probes/v01-upgrade.test.mjs`。现有原生 MCP 实际工具调用覆盖 agent bootstrap、召回、写入、worktree 根隔离和已有 adapter 复用；记忆修订契约覆盖原生锁、修订冲突、请求回执与失败重试。固定 MWF 版本未改变，本阶段不声称完成 MWF 跨版本迁移。

验证结果：应用升级专项 1 项通过，原生/MWF 补充契约 4 项通过，类型与格式检查通过。日志 `/tmp/parallel-pi-m5c-upgrade.log`、`/tmp/parallel-pi-m5c-contracts.log`。本段仅新增测试与文档，生产实现沿用已完成完整回归的 M5b；未重复整个浏览器或打包测试。


### M5d：真实后端提交强杀与确认丢失

`tests/recovery.test.ts` 新增 pre-commit、post-commit 两个参数场景。通过真实 HTTP 预览与确认提交，钩子启动后持久快照显示对应 hook；此时接收同分支排队 run，强杀实际后端进程，使原 HTTP 请求断连，再以同一磁盘数据重启。

明确验证：

- 钩子及 sleep 子进程均消失，延迟写入未发生，应用持有的 index.lock 已处理。
- pre-commit 中断未创建提交，原 HEAD 与原索引字节保留；post-commit 中断找回已创建的 commit ID，只包含所选文件，并保留 `post-commit was interrupted` 警告。
- 未选文件的 staged/unstaged 两份内容都保留，所选文件工作区内容也保留。
- 重启后队列仍 paused，原排队项仍 queued；相同 HTTP 意图重试和显式核对均返回原任务，不新增提交或重跑钩子。只有明确恢复队列后，原排队 run 才执行完成。

`tests/git-commit.spec.ts` 另覆盖浏览器真实确认丢失：route.fetch 将确认送到实际后端，确认返回 committed、SSE 快照已展示 commit ID 后仅丢弃该 HTTP 响应。重试按钮可用后点击，比较两次完整请求完全一致，提交数只增加一次，钩子只执行一次，未选部分暂存保持原样。该场景与原有失败保留输入、钩子进度刷新及外部 Git 核对场景一起通过。

最初浏览器测试在请求仍忙时就检查 HEAD，提前失败；改为等待同请求重试按钮 enabled 后再断言。这是测试同步修正，未改变生产实现。命令与日志：`node --test tests/recovery.test.ts`（`/tmp/parallel-pi-m5d-recovery.log`），`npx playwright test tests/git-commit.spec.ts`（`/tmp/parallel-pi-m5d-browser.log`）。

验证结果：完整后端故障 4 项通过，扩展后的 Git 浏览器专项 1 项通过，类型/格式检查通过。本段仅新增回归和证据，最终 M5 仍需真实外部模型、完整规格/UI 复核和最终运行包验证。
