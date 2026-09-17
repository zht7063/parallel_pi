# Linux 运行包与 macOS 本机 Lima

后端需要 Linux、Git ≥ 2.43、Python ≥ 3.11，以及固定 Node.js 26.8.2。`npm start` 先检查运行时、pidfd/subreaper 能力和构建文件，运行包还检查平台/架构、文件摘要及符号链接。`node scripts/runtime.mjs --check` 只做检查，不启动服务。

## 从已构建源码制作运行包

在目标 Linux 架构上按 [开发说明](development.md) 安装固定依赖并构建，完成回归和阶段提交后：

```sh
python3 scripts/package-runtime.py /absolute/releases/new-release
```

目标目录必须全新且在源码目录之外。默认拒绝未提交的跟踪文件变更，pi/MWF 必须匹配 `probes/versions.json`；`--development` 只用于明确标记的候选包。源文件按 Git 清单收集，新文件必须先纳入 Git。打包期间停止源码/构建产物写入，归档成功后仍须执行下述解包验证。

输出 `parallel-pi-linux.tar.gz` 和 `SHA256SUMS`。包内保留应用源代码、前端构建、固定 pi/MWF 构建、已安装 npm 依赖及其许可文件、版本和逐文件摘要。没有 `.git`、应用数据、全局凭据或未跟踪的项目文件。包内备份命令从运行清单读取应用版本，不要求存在源码 Git 仓库。

当前为完整依赖包，含构建工具，Linux x64 候选约 188 MB 压缩大小；不做依赖裁剪。它不内置 Node、Python、Git，不保证不同 libc/系统版本的二进制兼容。推荐在实际目标 Linux/架构上构建，或者使用与构建环境匹配的 Linux；Apple Silicon 的 Lima 应在 guest 内构建 arm64 包，不能使用 x64 包。首次安装依赖需要网络，解包运行无需再次 npm install。

在 Linux 的新目录中解包：

```sh
cd /absolute/releases/new-release
sha256sum -c SHA256SUMS
mkdir -m 700 /absolute/apps/release-directory
tar -xzf parallel-pi-linux.tar.gz -C /absolute/apps/release-directory
cd /absolute/apps/release-directory/parallel-pi
node scripts/runtime.mjs --check
PARALLEL_PI_DATA_DIR=/absolute/private/parallel-pi-data \
PARALLEL_PI_AGENT_DIR=/absolute/private/pi-agent npm start
```

打开输出的 `http://127.0.0.1:4317`，在界面添加真实 Git 仓库，并配置模型/凭据。停止使用 Ctrl+C 或向 Node 进程发送 SIGTERM，等待进程实际结束；升级不能直接覆盖正在运行的包。数据和凭据应位于运行包目录之外，以便独立备份和切换版本。自定义端口使用 `PARALLEL_PI_PORT`，浏览器必须使用匹配的 `127.0.0.1` 地址。

## macOS：启动本机 Linux

本方案交付 Lima 配置，不要求同时安装 Docker。使用 macOS 13+ 的 VZ/virtiofs 路线，官方支持的挂载和转发行为见 [Lima 文件系统挂载](https://lima-vm.io/docs/config/mount/) 与 [本地端口转发](https://lima-vm.io/docs/config/port/)。macOS 实机验证仍按已确认决定在 MVP 后执行；Linux 运行包验收和 YAML 校验不等于已完成 macOS 实测。

在 macOS 安装 Lima 2.2 或更新的兼容版本（本配置使用官方 2.2.0 CLI 验证），例如按 [官方安装说明](https://lima-vm.io/docs/installation/) 使用 Homebrew：

```sh
brew install lima
mkdir -p ~/parallel-pi-projects
limactl validate deploy/lima.yaml
limactl start --name=parallel-pi deploy/lima.yaml
limactl shell parallel-pi
```

首次启动会下载 Ubuntu 24.04 镜像并安装 Git、Python、证书、curl 和 xz。模板仅声明 `~/parallel-pi-projects` 为可写宿主目录，映射为 guest 的 `/workspaces`；需要其他目录时先编辑该 location，且在首次绑定项目后保持挂载路径稳定。应用中添加的是 `/workspaces/...`，不是 macOS 的 `/Users/...`。不在宿主和 guest 同时启动同一项目的执行者。

应用数据、原生 agent 配置、受管理 worktree、Node 和 npm 依赖留在 Linux guest 自己的磁盘，避免将 SQLite WAL 与监督锁放在共享文件系统上。共享工作区中的 `.git` 和 `.mwf` 由 Linux 后端操作；受管理 worktree 的绝对路径属于 guest，在宿主 Git 中不保证可直接访问。宿主可编辑共享主工作区文件，Git 操作与 agent 执行需要协调。VM 不构成应用工具的权限沙箱。

在 guest 中安装固定 Node（以下校验值取自 [官方 v26.8.2 发布清单](https://nodejs.org/dist/v26.8.2/SHASUMS256.txt)）：

```sh
cd "$HOME"
case "$(uname -m)" in
  x86_64) pi_node_arch=x64; pi_node_sha=40e1d3225c1c9ae9a2671c98ecb9857e4d5555026394f348645676798840d5c5 ;;
  aarch64) pi_node_arch=arm64; pi_node_sha=81d8f0fdea9dcd3bfdcfeafc5f8359c151f097e9880b0007c0645ca670d07971 ;;
  *) echo 'Unsupported Node architecture'; exit 1 ;;
esac
pi_node_archive="node-v26.8.2-linux-${pi_node_arch}.tar.xz"
curl -fLO "https://nodejs.org/dist/v26.8.2/${pi_node_archive}"
printf '%s  %s\n' "$pi_node_sha" "$pi_node_archive" | sha256sum -c -
mkdir -p "$HOME/.local/share"
tar -xJf "$pi_node_archive" -C "$HOME/.local/share"
export PATH="$HOME/.local/share/node-v26.8.2-linux-${pi_node_arch}/bin:$PATH"
node --version
```

将最后的 PATH 配置保存到 guest 自己的 shell 配置，供之后登录使用。源码安装在 guest home 下进行；不要把 macOS 的 node_modules 复制进 Linux。已有运行包可通过 `limactl copy` 复制到 guest，再按前文校验和解包。源码检出则使用已交付的 Git commit 和固定子模块，按开发文档安装构建；不要把未经提交的宿主源码当作已验证发布版本。

启动应用后，在 macOS 浏览器打开 `http://127.0.0.1:4317`。模板仅把 guest 的这个 loopback 端口转发至宿主相同 loopback 端口，忽略其他自动转发；后端 Host/Origin 校验保持启用。两端端口必须一致，端口冲突时先停止占用者，或同时修改 YAML 的 guestPort/hostPort 与 `PARALLEL_PI_PORT`。不要改成 `0.0.0.0` 来绕过连接问题。

停止顺序：先在运行终端 Ctrl+C，等待后端和工具收束，再在宿主运行 `limactl stop parallel-pi`。重新运行使用 `limactl start parallel-pi` 和 guest 内原启动命令。VM 删除会丢失其中的数据；[备份](backup-upgrade.md) 在 guest 内生成，再通过 `limactl copy` 复制到宿主受限目录保存，不以整个 VM 的存在代替数据备份。

## 发布验证

`npm run test:package` 在全新临时路径制作并解包候选，检查摘要、架构拒绝和文件修改拒绝，然后启动包内服务，通过真实 HTTP 执行固定 pi 和 MWF 初始化，退出后运行包内备份命令。该测试单独运行，避免压缩全部依赖干扰普通并行测试的时限。

每次发布还需 `npm run check`、`npm run build` 和 `npm run test:browser`。Lima 配置改变时运行 `limactl validate --fill deploy/lima.yaml` 并核对最终挂载/端口；此命令不启动 VM。M5 的完整应用验收另行记录。
