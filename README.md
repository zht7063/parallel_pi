# parallel_pi

基于原版 pi 的本地单用户可视化 agent harness。按 Git 分支组织工作区和执行队列，用会话地图查看对话、接续和思路分叉，通过 Memory with Files 管理文件记忆。

**MVP 已完成。** Linux 上已通过 67 项 Node 测试、12 项浏览器测试、独立运行包验收，以及真实 DeepSeek Flash 的文字、工具、图片和后端重启后继续会话验收。完整范围与证据见 [MVP 完成报告](docs/evidence/mvp-completion.md)。

## 原生服务与 npm（开发中）

当前分支 `codex/native-core-npm` 正在把 MVP 整理为“服务核心 + 内置 Web 页面”的 npm 产品。已有 Linux npm 安装候选，支持 `parallel-pi serve` 和 `parallel-pi doctor`；构建与安装步骤见 [npm 安装候选](docs/npm-delivery.md)。尚未发布 npm registry。

**macOS 原生支持尚未完成。** 最终方案不要求用户使用 Lima；平台监督机制及实机验证进展见 [本轮里程碑](docs/native-core-npm.md) 和 [macOS 监督探针](docs/darwin-supervision.md)。下面的 MVP/Linux 使用说明仍有效，历史 Lima 文档不代表本轮的最终 Mac 安装方案。

## 主要能力

- **分支与工作区**：添加本机 Git 仓库，保留已有未提交修改；管理 worktree、创建分支、将远端分支拉取到本地。
- **会话地图**：全局地图、专注会话和地图浮层；支持独立会话、接续与原生 fork，保留来源、草稿和视口。
- **执行与恢复**：同分支串行，跨分支并行；默认全局并发 2，可调整。支持排队、工具调用、回答运行中的提问、停止及崩溃恢复。
- **模型与图片**：原生 provider/凭据配置、项目和会话模型选择、图片预览与移除；入队时固定模型，不可用时明确报错。
- **文件记忆**：MWF 初始化、召回、查看和修订；冲突不盲覆盖，关键保存失败可重试或明确继续。
- **开发成果**：查看分支工作区 diff，明确选择整文件提交；支持钩子状态、提交恢复、停机备份与手动升级。

思路分叉只改变对话上下文，始终使用分支当前代码。关闭网页不停止后台任务；停止或失败后，该分支暂停，未启动任务需明确恢复。执行完成与记忆保存结果分别显示。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 后端系统 | Linux，支持 pidfd/subreaper；启动时自动预检 |
| Node.js | **26.8.2**，当前固定版本 |
| npm | 验证版本 11.19.1 |
| Git | 2.43 或更新版本 |
| Python | 3.11 或更新版本 |
| macOS | 在本机 Linux 环境运行后端；已提供 Lima 配置，macOS 实机验证后置 |

前端采用 Vue 3 + TypeScript，后端为 Node.js + SQLite，通过 HTTP + SSE 通信。pi、MWF 和 MCP adapter 的固定版本见 [版本清单](probes/versions.json)。

## 从源码启动

在项目目录内安装并构建；首次安装需要网络：

```sh
npm ci --ignore-scripts
npm run setup:probes
npm run build
```

`setup:probes` 会初始化固定 pi 子模块并构建 pi/MWF 运行依赖。

已在 pi 原生配置中保存凭据，或准备通过界面配置时：

```sh
npm start
```

使用项目本地 `.env` 时，配置示例如下；已有文件只需核对，无须覆盖：

```dotenv
DEEPSEEK_API_KEY=填写你的密钥
PARALLEL_PI_PROVIDER=deepseek
PARALLEL_PI_MODEL=deepseek-flash
```

显式加载 `.env` 启动：

```sh
node --env-file=.env scripts/runtime.mjs
```

`.env` 已被 Git 忽略，不随运行包分发。`npm start` 不会自动加载该文件；`PARALLEL_PI_PROVIDER` / `PARALLEL_PI_MODEL` 供真实模型验收使用，应用中仍需在模型选择处指定 `deepseek` / `deepseek-flash`。

打开终端输出的 **http://127.0.0.1:4317**，添加本机 Git 仓库，选择分支并创建会话即可发送文字或图片。服务仅监听本机 loopback，使用输出中的地址访问。停止服务时按 Ctrl+C，等待后端和工具进程退出。

已有 Linux 运行包的安装、摘要校验及 macOS Lima 启动方式见 [运行与部署说明](docs/linux-runtime.md)。

## 数据与配置

| 配置 | 用途 |
| --- | --- |
| `PARALLEL_PI_PORT` | HTTP 端口，默认 `4317` |
| `PARALLEL_PI_DATA_DIR` | 应用私有数据目录；默认 `$XDG_DATA_HOME/parallel_pi`，未设置 XDG 时为 `~/.local/share/parallel_pi` |
| `PARALLEL_PI_AGENT_DIR` | 指定原生 pi agent 配置目录；未设置时沿用 pi 默认目录 |

应用数据目录保存 SQLite 元数据、原生会话、图片、交接记录和进程收束证据；长期记忆位于各 worktree 的 `.mwf/`。备份与升级前先停止服务，按 [备份、恢复与手动升级](docs/backup-upgrade.md) 操作。

## 开发与验证

```sh
npm run check          # 架构、类型、Node 测试和格式检查
npm run build          # 前端构建
npm run test:browser   # 浏览器交互验收
npm run test:package   # 独立运行包验收，包含完整依赖打包
```

浏览器测试需要 Playwright Chromium 及对应系统库，首次可运行 `npx playwright install chromium`。`npm run dev` 监听后端代码变化；前端修改后需重新构建。详细环境说明见 [本地开发与验证](docs/development.md)。

真实模型验收需配置有效 `.env`，会实际调用 API 并产生费用，默认不包含在常规测试中：

```sh
node --env-file=.env --test tests/live-application.mjs
```

该场景使用隔离临时仓库，覆盖 HTTP 请求去重、文字回复、真实 Bash 工具、图片理解、后端重启后的历史和上下文恢复。验证范围见 [真实 DeepSeek Flash 验收](docs/evidence/m5-live-application.md)。

## 文档入口

- [完成报告](docs/evidence/mvp-completion.md) · [完整验收矩阵](docs/evidence/m5-acceptance.md) · [实施里程碑](docs/milestones.md)
- [Linux / Lima 运行](docs/linux-runtime.md) · [备份与升级](docs/backup-upgrade.md) · [本地开发](docs/development.md)
- [产品规格](docs/mvp-spec.md) · [技术架构](docs/architecture.md) · [原生依赖与升级契约](docs/native-contracts.md)
- [交互式项目结构图](docs/visualization/project-structure.html) · [页面线框](docs/design/README.md)
- [全部文档](docs/README.md) · [历史实施交接](docs/implementation-handoff.md) · [早期探针](probes/README.md)

本次验证范围为 Linux；macOS 实机按约定后置。升级兼容证据限于已验证的 pi 0.84.1 → 0.85.1 样本。项目采用固定原生版本和手动升级，不包含云端多用户服务或自动更新。
