# npm 安装候选

本说明对应 `codex/native-core-npm` 的开发候选，不是已发布产品。当前 Linux 候选已验收，macOS 原生监督候选已实现、底层探针已在用户 Mac 通过，完整适配和安装仍待实机验收；不使用 Lima 作为最终安装方案。

## 构建与安装

维护者先按源码开发说明准备固定 pi/MWF 依赖，然后运行：

```sh
npm run build:npm
npm pack ./dist/npm --ignore-scripts
npm install --global ./parallel-pi-0.2.0-dev.0.tgz
parallel-pi doctor
parallel-pi serve
```

`dist/npm` 必须不存在，构建不会覆盖已有候选。需要保存多个候选时，可以在 `npm run build` 后运行 `node scripts/build-npm.mjs /absolute/new-candidate`。

用户只需拿到匹配系统/架构的 tarball；不需要克隆源码或安装构建工具。仍需运行环境要求中的 Node、Git、Python。当前 Node 固定 26.8.2。候选的 `private: true` 防止误发布 registry，不影响本地 tarball 安装。正式包名和发布方式尚未确定。

```sh
parallel-pi serve --port 4317 --data-dir /absolute/private/data --agent-dir /absolute/private/agent
```

服务仅监听 `127.0.0.1`，前端管理服务所在机器的资源。Ctrl+C 停止，等待工具退出。保留现有 `PARALLEL_PI_*` 环境变量及默认数据路径；CLI 选项优先于环境变量。

## 临时文件与测试清理

服务启动时统一将 `TMPDIR`、`TMP`、`TEMP` 设置为 `<data-dir>/tmp`（目录权限 0700），在加载业务依赖之前生效。模型配置校验、Git 预览以及遵循这些变量的 Pi、Python 和工具子进程都使用此目录；原有操作结束自动清理逻辑保留。异常退出残留可在服务和子进程完全停止后清理 `tmp/`，不要删除用于恢复的 `supervision/`、`git-transactions/` 或会话、工作区数据。

测试时将 `--data-dir` 和 `--agent-dir` 指向同一个专用测试根目录下的 `data/`、`agent/`，项目也选用该根目录中的测试仓库，即可集中保留和清理测试数据。不要把真实项目作为可删除的测试目录。Mac 探针另使用仓库 `probes/.cache/darwin-supervision/`。

这不是文件系统沙箱：外部工具硬编码的路径、独立的 npm 缓存、浏览器存储和操作系统日志不受这些变量控制。源码测试仍遵循测试进程的系统临时目录设置；需要集中存放时，可先创建仓库 `.parallel-pi/tmp`，再用 `TMPDIR="$PWD/.parallel-pi/tmp" TMP="$PWD/.parallel-pi/tmp" TEMP="$PWD/.parallel-pi/tmp" npm test`。

## 构建内容

应用 TypeScript 与 worker 预编译为 JavaScript，内部包引用转换为包内路径。Web 静态资源、Python 监督器及备份脚本随包提供；固定 pi、MWF、MCP adapter 的生产依赖随包捆绑，安装不执行依赖构建脚本。第三方许可证随各依赖保留。构建文件清单排除应用未跟踪文件、Git 元数据和 Python 缓存。

当前构建按本机构架收集已安装原生依赖，不能把 Linux x64 候选当作 macOS/arm64 包。成品的 os/cpu 按构建机器标记，Mac 包必须在对应架构的 Mac 上构建。`build-info.json` 记录平台、架构、源码提交、原生版本和依赖锁摘要，供预检及备份使用。

## 验收与管理

```sh
npm run test:npm
```

专项测试在源码之外构建，并使用独立空 npm 缓存离线安装 tarball。测试从固定 MVP 提交 `ea812ac` 的真实应用生成会话和记忆，移除旧应用目录后，用 npm 版打开同一数据并继续原会话；同时检查未提交文件、记忆正文、Git 提交 worker/钩子、包内备份，以及重新安装/卸载后的数据保留。原生 pi/MWF 版本沿用该 MVP 的固定版本；测试使用确定性模型，不调用付费模型。

升级前停止服务并备份，之后安装新的候选版本。`npm uninstall --global parallel-pi` 只移除程序；数据、凭据和项目由用户独立管理。升级验证范围是固定 MVP `ea812ac` → 当前 npm 候选，以及候选同版本重新安装；不泛化为所有旧版本。macOS 平台兼容性仍属于未完成的验收门槛。

## macOS 候选验收（尚未通过）

需要桌面登录会话、Node 26.8.2、Git 2.43+、Python 3.11+。在当前分支仓库根目录运行 `bash scripts/verify-macos.sh`；使用 uv 管理 Python 时运行 `uv run --python 3.11 bash scripts/verify-macos.sh`。脚本准备固定依赖、构建、运行探针和后端套件，再离线安装 npm tarball，并对包内监督器重复正常退出、取消、后端崩溃和监督器崩溃测试。测试使用临时仓库和受控 provider，不需要模型密钥。源码外安装后的全应用/Web/真实模型验收与睡眠唤醒仍需单独完成，脚本不宣称覆盖这些项目。

脚本把当前已提交版本克隆到普通本地目录再构建，避免依赖 iCloud 工作目录；存在未提交的跟踪文件改动时会停止。产物、隔离源码与日志保存在新的 `~/parallel-pi-candidates/macos.XXXXXX/`，脚本会打印包、校验和、日志和启动命令，不覆盖旧候选、不修改全局 npm 安装。若任何步骤失败即停止，请保留 validation.log。初始 Node/Python 检查失败时直接显示错误，尚未生成日志。不要把 Linux tarball 当作 Mac 包安装。

Darwin 采用临时用户 gui launchd job；输入/输出及进程环境通过私有 Unix socket 转发，凭据不写进 plist。取消时冻结并核验工具状态后终止，以内核资源组计数为清理依据。监督器意外死亡且没有清理证明时保留 recovering；本候选只支持明确的重启机器后恢复，不把 job 消失或 PID 不存在当作工具已清空。
