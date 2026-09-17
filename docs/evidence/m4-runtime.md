# M4g：Linux 运行包与本机 Lima 启动配置

`npm start` 经过 `scripts/runtime.mjs` 检查 Linux、固定 Node 26.8.2、Git ≥ 2.43、Python ≥ 3.11、pidfd/subreaper 和构建文件。运行包还验证自身平台/架构与逐文件摘要、符号链接，拒绝混用平台或缺失/改动的文件。Python 预检不依赖可被 PYTHONOPTIMIZE 禁用的 assert。

`scripts/package-runtime.py` 收集 Git 跟踪源码和明确的已构建依赖目录，保留相对 workspace 链接，拒绝非便携链接与错误原生版本。默认要求跟踪文件已提交；开发候选明确标记。包不包含 .git、用户数据或全局凭据，归档附带 SHA256SUMS。完整依赖约 188 MB 压缩大小；暂不裁剪开发依赖，平台之外的 libc 兼容性不作泛化承诺。

## 实际验证

`npm run test:package` 已通过（约 193 秒），在独立临时目录：

1. 制作并校验归档，解包后确认应用和 pi 没有 .git。
2. 从源码目录之外执行包内启动预检；故意改变架构和静态文件均被拒绝。
3. 用独立数据/凭据目录启动包内后端，HTTP 静态页面可用，未登录快照和外部 Origin 被拒绝。
4. 添加真实 Git 仓库，调用包内固定 MWF 初始化，运行包内真实 pi 与确定性测试 provider，得到 succeeded 和持久消息。
5. SIGTERM 后正常退出；包内备份命令归档应用、配置、项目和所引用运行包，从 manifest 读取应用版本，不依赖原源码 checkout。

`npm run build` 通过，前端构建 hash 与前一阶段一致。最终 PythonOPTIMIZE 预检通过，Python 编译检查通过；完整 `npm run check` 的 57 项测试以及架构、类型、格式检查通过。本阶段未修改 UI；不以静态页面 HTTP 200 代替浏览器交互验收，M5 仍需完整复验。

## Lima 验证与边界

从官方 GitHub Release 下载 Lima 2.2.0 Linux x86_64 CLI，按官方 SHA256SUMS 核对归档，再执行 `limactl validate --fill deploy/lima.yaml`，结果 OK。检查展开后的配置，仅声明宿主 `~/parallel-pi-projects` → guest `/workspaces` 的可写挂载；只把 127.0.0.1:4317 转发到宿主相同 loopback 端口，其余端口转发忽略。

源码/Node/依赖、SQLite、监督锁、原生配置和受管理 worktree 留在 guest 自身磁盘。后端仍只监听 loopback，未放宽 Host/Origin 校验。Linux 当前环境没有 Lima VM 运行环境；该证据是官方 schema 校验和 Linux 包运行，不是 macOS VZ/virtiofs 实测。macOS 实机验证继续遵守此前明确后置决定。

安装、启动、挂载、停止、备份与升级路径见 `docs/linux-runtime.md`。相关上游依据为 [Lima 安装](https://lima-vm.io/docs/installation/)、[挂载](https://lima-vm.io/docs/config/mount/) 和 [端口转发](https://lima-vm.io/docs/config/port/)。完整 A01–A16、外部模型应用验收、旧版本应用会话升级及已知故障组合继续在 M5 核对，不因本阶段结束缩减范围。
