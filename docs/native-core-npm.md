# 原生服务核心与 npm 交付里程碑

分支：`codex/native-core-npm`，基线：`ea812ac`（main MVP）。

## 已确认目标

同一个 npm 产品包提供独立服务核心和内置 Web 页面。前端管理核心所在机器的仓库、文件及工具。首版原生支持 macOS 与 Linux，不要求 Lima，不要求用户克隆源码或构建；Windows 后置。保留 MVP 功能与现有数据，默认 loopback，本阶段不开放未经认证的远程监听。先提供前台服务，系统常驻服务后置。正式 registry 名称、账号和发布权限在安装候选验收后决定；本阶段交付可本地安装的 npm tarball，不发布 registry。

## 里程碑与提交边界

每个里程碑完成后记录实际验证结果并独立提交；失败和未验证内容不得记为通过。必要时将较大里程碑拆成独立、可验证的子项提交。

- [x] N0：记录范围、里程碑与验收门槛。
- [ ] N1：验证并实现原生平台监督。保留 Linux 行为，提供 macOS 的启动、取消、子进程清理及恢复；普通退出、setsid/double-fork、后端被杀、监督器被杀、PID 复用和重启恢复必须有明确保证。不能以进程组清空或轮询未发现进程代替完整清理证据。无法证明时保持 recovering，不自动恢复工作区执行。
- [ ] N2：独立核心 CLI。提供 serve、版本及帮助，验证端口配置、退出信号、资源定位、任意工作目录启动、平台预检与独立数据目录；前端随核心服务，不更改已有 API/业务语义。
- [ ] N3：npm 成品构建。编译所有运行时 TypeScript 和 worker，包含 Web、pi、MWF 与必要资源，明确平台原生依赖策略；发布清单排除密钥、用户数据和开发缓存。安装无需源码 checkout、开发依赖或构建。
- [ ] N4：安装与兼容验收。从 tarball 在源码外安装，执行真实核心/Web/pi/MWF/Git 路径，停止与重启，验证旧数据、升级保留数据与卸载保留数据。运行架构、类型、后端、浏览器及打包回归。macOS 与 Linux 分别记录证据，不能用 Linux 测试替代 macOS 实机验收。
- [ ] N5：交付文档。更新安装、运行、管理、备份升级与平台支持说明，记录已验证版本/架构及剩余限制；完成最终逐项审计与提交。

## 实施约束

- 保留业务层和 HTTP/SSE，系统差异集中在平台适配层。
- npm 安装目录不保存会话、凭据或工作区，不隐式开启 VM 或后台服务。
- 现有 Linux 数据路径兼容；macOS 默认路径的选择不得让已有数据悄然失联。
- macOS 缺乏可用验证环境时，继续所有可独立完成的实现与验证，明确记录实机门槛待验，不宣布跨平台交付完成。
- 真实付费模型测试需沿用明确授权；常规验收采用已有受控模型，不依赖用户秘密。

## 进度与证据

### N0

已核对当前分支和干净工作区，确认现有运行入口强制 Linux，监督器依赖 /proc、pidfd 与 subreaper，后端直接运行 TypeScript。上述限制分别归入 N1 与 N3。

### N1 调查：macOS 不能套用 FreeBSD 子进程跟踪

Apple XNU 的 `filt_procattach` 对 `NOTE_TRACK | NOTE_TRACKERR | NOTE_CHILD` 返回 `ENOTSUP`，单纯 kqueue 监听不能提供自动追踪所有后代的保证。来源：[Apple XNU kern_event.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_event.c)。因此不以 kqueue/轮询方案冒充 Linux subreaper 的等价实现。原生 macOS 监督仍在调查，Linux 平台保护尚未解除。

### N2a 已完成：独立 CLI 入口（Linux 已验证）

新增 `parallel-pi serve`、`doctor`、`--help` 和 `--version`，支持端口、数据目录及 agent 目录，复用现有运行预检。保留 `npm start` 与旧环境变量，默认仅 loopback。信号关闭增加重复调用保护。

验证：`node --test tests/cli.test.mjs` 两项通过，实际从源码外目录启动，访问 Web 与带 session 的状态 API，SIGTERM 正常退出且数据保留；错误参数在启动前拒绝。类型和架构检查通过。当前 bin 仍为源码运行入口，npm 安装后的编译入口由 N3 完成；N2 整体仍待平台支持与后续集成验收。

### N3a 已完成：Linux npm 成品与源码外安装验收

新增 `npm run build:npm` 和 `npm run test:npm`。构建预编译应用与 worker，保留相对资源布局，固定生产依赖随包捆绑；原生依赖遵循自身 npm 文件清单，应用源文件限定为 Git 跟踪清单，安装无需执行构建脚本。候选按构建平台/架构标记，`private: true` 防止误发布 registry。包内预检及备份读取独立发布元数据，不依赖源码 Git 和锁文件位置。

验证证据：

- 最终依赖布局从零构建的 `npm run test:npm` 通过，约 218 秒。真实 tarball 在源码外离线全局安装，从生成的命令入口启动，Web/本机会话保护、Git 项目登记、MWF 初始化和真实 pi 受控模型运行通过。
- 包内备份命令成功，版本与构建元数据一致；重新安装同版本及卸载保留独立数据、agent 设置和项目文件。此项不代替旧 MVP 数据跨版本升级验收。
- `npm run check` 通过：69 项 Node 测试、架构、类型及格式检查。最后补充开发候选标记后的 CLI 专项 2 项再次通过。
- 初始候选压缩约 69 MB，未压缩约 226 MB；体积仅供参考，不是发布体积承诺。候选不含 TypeScript 编译器，应用与 worker 不在安装时运行源码 TypeScript。

操作说明见 [npm 安装候选](npm-delivery.md)。macOS 原生监督及对应架构成品尚未验证，因此 N1/N3/N4 整体仍待完成，不宣称跨平台交付已经完成。

### N1a：监督机制调查与独立实机探针

已交付 [macOS 监督调查](darwin-supervision.md) 和 `probes/darwin-supervision.py`。候选路径为临时用户 launchd job 的独立 resource coalition 加内核计数，以及 audit-token 信号的世代校验。探针检查脱离进程组的 double-fork 后代，不将普通进程组或用户态扫描当成完整清理证据。

Linux 上 Python 语法与非 macOS 拒绝路径已验证；macOS 实际 API 可用性、临时 job 隔离、内核计数和信号行为均待实机验证。生产平台限制保持，N1 尚未完成。

### N4a 已完成：真实 MVP 数据升级与 Linux 浏览器回归

专项安装测试改为从固定 MVP `ea812ac` 的归档应用生成真实会话、运行和知识正文。旧应用使用该 MVP 同版本的固定 pi/MWF；业务模块从旧归档自身的 workspace 解析，不使用当前分支业务模块。关闭并移除旧应用目录后，npm 安装版打开相同数据，保留原会话/运行 ID 并继续发送；旧知识正文和未提交工作文件保留。

最终 `npm run test:npm` 通过，约 203 秒：独立空 npm 缓存离线安装、发布清单、MVP 升级、原会话继续、旧知识正文读取、编译后的 Git inspect/preview/commit worker、真实 pre-commit 钩子、MWF 读取、包内备份、重新安装后两次运行不重放，以及卸载保留数据/配置/未提交文件。测试只操作临时仓库与临时用户数据。

`npm run build` 通过，12 项浏览器测试全部通过（约 3.4 分钟）。首次浏览器启动失败原因是精简环境缺少 libatk 等系统库，随后按 development.md 复用已有 FONTCONFIG_FILE/LD_LIBRARY_PATH 配置完成回归；未修改 UI 或浏览器测试来绕过失败。

兼容声明仅覆盖上述固定 MVP 与当前候选，未覆盖任意历史版本、其他原生版本或 macOS。N4 的 Linux 部分已有直接证据，跨平台验收仍待 N1 实现及 Mac 实机环境。

### N5a 已完成：候选交付说明与状态入口

根 README 和文档索引现在明确区分已完成的 Linux MVP/npm 候选与未完成的原生 Mac 支持，链接当前里程碑和探针。安装包 README 改为直接附带 npm 交付说明，避免只提供依赖未随包发布的源码文档链接的 README。该变更仅替换文档复制来源；构建脚本语法、格式及 diff 检查通过。

剩余主要门槛：Mac 实机执行独立监督探针并确定可用机制，完成生产 macOS 适配与对应原生依赖构建，再在 Mac 验证启动/取消/崩溃恢复/升级/安装。当前会话为 Linux，尚未获得可用 Mac 或探针结果，因此不能宣布 N1–N5 跨平台目标完成。

### N1b：用户 Mac 探针通过与正式适配候选

2026-09-19 用户截图确认 macOS 26.6.2 arm64 / Python 3.11.14 探针通过。修复 gui 加载域与 SIGCONT 参数，细节见 darwin-supervision.md。原生适配候选已接入平台选择、CLI 预检和目标平台 npm 清单；使用临时 launchd job、私有 socket 环境/IO 桥接、持久 owner/guard/cancel 与内核 coalition 清理证明。独立监督器失联没有证明时继续 recovering，重启机器后可核验旧 boot 已结束。

新增跨平台清理决策检查及 Mac 专属实际监督器死亡、等待 shell 取消场景；Linux 结果不代替 Mac。`scripts/verify-macos.sh` 准备匹配架构候选和日志，执行源码与安装后平台测试。N1/N3/N4/N5 仍未整体关闭：正式适配、原生依赖包、完整安装应用路径和睡眠唤醒必须等待 Mac 实测，当前环境只能制作 Linux tarball。

本候选 Linux 验证结果：`npm run check` 70 项通过、2 项 Darwin 专属用例跳过，架构/类型/格式通过；新增 Python 清理决策检查 6 项通过（由平台测试调用，不是额外的 Mac 实测）。最终类型、格式、Python/shell 语法及 diff 检查通过。Vite 构建通过；完整 12 项浏览器测试通过（约 3.3 分钟）；`npm run test:npm` 在候选目录上通过（约 209 秒），包括新增 Darwin 资源入包与目标 OS 元数据断言。Linux 候选位于 `/tmp/parallel-pi-darwin-linux-candidate`，是开发回归产物，不可用于 Mac。日志在本机 `/tmp/parallel-pi-darwin-{check,npm-test,browser}.log`。没有把 Mac 专属跳过计为通过，也没有关闭跨平台交付门槛。

### N1c：首次完整 Mac 日志与已复现修复

用户提供 macOS 26.6.2 / arm64 的 validation.log，对应 114cb6d：探针、依赖和构建通过；Node 验收 48 通过、14 失败、8 取消、2 个 Linux 专属跳过，未进入 npm 打包阶段。正式 Mac 验收未通过。

已在 Linux 使用显式目录 symlink 重现并修复：备份引用清单没有规范化而与归档名称不一致；会话工作区与会话父目录直接比较字符串而拒绝同一物理目录的别名。另以确定性决策测试重现内核计数已归零但直接子进程还没 waitpid 回收的窗口，清理现在额外等待直接子进程回收；此修复是否完全解释 Mac SIGKILL 断言仍待实机复验。测试临时根目录统一为 realpath，显式 symlink 回归保留，异工作区拒绝不放宽。

多项 RPC、启动及应用超时的根因仍未确认；不提高超时、不删除失败用例。Mac 脚本先运行平台专项作为门槛，再串行运行全部 Node 文件以排查跨套件负载影响（套件内部的业务并发测试保留）。桥接失败输出 launchd 生命周期字段、owner/result 存在性及原 worker 错误，不输出环境或凭据。串行成功也不等于并发压力验收通过。

N1c 本地验证：显式别名备份/会话测试与退出回收决策测试均先观察到失败，再修复通过。`npm run check` 71 通过、2 个 Mac 专属跳过（0 失败/取消），架构/类型/格式通过；Python 决策检查 7 项通过。以 symlink TMPDIR 模拟 Mac 路径别名的 CLI/配置/Git 四项专项通过；平台专项 7 通过、2 Mac 跳过。编译后 npm 候选的离线安装、真实 MVP 数据升级和包内备份验证通过（约 213 秒）。日志 `/tmp/pi-mac-fixes-check.log`、`/tmp/pi-mac-fixes-package.log`。这些均为 Linux 证据，等待用户重新执行 Mac 脚本，不宣称原 14 个 Mac 失败和 8 个取消已全部关闭。
