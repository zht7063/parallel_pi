# 本地开发与验证

当前实现阶段见 [里程碑](milestones.md)。M1/M2 已完成，真实项目/session 执行与恢复已贯通；后续继续 M3–M5，当前不是完整 MVP。

## 环境与运行

现有验证环境：Linux、Node.js 26.8.2、npm 11.19.1。此运行时沿用探针基线，不声称长期支持承诺。后端直接运行可擦除类型的 TypeScript；前端由 Vite 构建。

```sh
npm ci --ignore-scripts
node probes/setup-pi.mjs
node probes/setup-mwf.mjs
npm run build
npm start
```

在浏览器打开终端输出的 `http://127.0.0.1:4317`。仅监听 loopback，Host 必须使用该地址。通过 `PARALLEL_PI_PORT` 修改端口。`npm run dev` 监听后端改动；修改前端后重新运行构建。

后端当前依赖 Git、Python 3 和提供 pidfd 的 Linux 内核。Python 监督器负责接管脱离进程组的工具并核验收束。macOS 用户已接受本机 Linux 环境（Docker Desktop/Lima）路线；启动打包尚待 M4/M5 完成，直接以 macOS Node 启动仍会拒绝，实机验证后置不代表当前已经验证可运行。

`node probes/setup-pi.mjs` 初始化固定版本子模块并离线构建 pi；`node probes/setup-mwf.mjs` 获取固定 MWF 源码并构建其 CLI；首次安装 npm 依赖仍需网络。版本依据是 `probes/versions.json`，不能换成系统任意版本 pi。原生凭据沿用 pi 的配置目录，`PARALLEL_PI_AGENT_DIR` 可指定隔离目录；不要把凭据写入项目文件或提交。

`PARALLEL_PI_DATA_DIR` 可指定应用私有数据目录，默认 `$XDG_DATA_HOME/parallel_pi`（未设置时为 `~/.local/share/parallel_pi`）。其中 SQLite 保存元数据、待写意图和事件，`sessions/` 保存原生会话，`attachments/` 保存图片，`handoffs/` 保存每次运行的独立交接记录，`supervision/` 保存进程收束证据。不要在运行中移动或删除这些目录。

交接保存失败会暂停该分支。可以重试保存，或明确暂不保存后恢复队列；这些动作不会重跑原任务。不能核验进程收束时保持 recovering，必须先恢复核验。完整备份/升级流程和 MWF 配置界面仍待 M4/M5 完成。

## 检查

```sh
npm run check
npm run build
npm run test:browser
```

`check` 包括分层依赖/公开入口/循环检查、领域独立类型检查、应用及 Vue 类型检查、Node 测试和格式检查。浏览器测试使用 Playwright Chromium，首次可运行 `npx playwright install chromium`；Linux 需具备对应浏览器系统库。浏览器环境依赖不属于应用运行依赖。

在当前精简 Linux 环境，系统缺少 libatk 等库，已有临时运行库时的实测命令是：

```sh
FONTCONFIG_FILE=/tmp/parallel-pi-browser-fonts/fonts.conf \
LD_LIBRARY_PATH=/tmp/dayweave-browser-libs/root/usr/lib/x86_64-linux-gnu npm run test:browser
```

字体配置引用解包于 `/tmp/parallel-pi-browser-fonts/root/usr/share/fonts` 的 Ubuntu fonts-noto-cjk，防止精简环境以方框替代中文。上述绝对路径只记录本次验证环境，不作为安装脚本或其他机器的前置假设。测试截图和 trace 位于被 Git 忽略的 `test-results/`。

## 分层

- `packages/domain` 不依赖 Node、浏览器或外部包，当前包含运行状态迁移、模型选择与公平调度规则。
- `packages/application` 协调用例；通过自己拥有的能力接口注入适配器，不能导入基础设施实现。
- `packages/contracts` 是公共 DTO；`packages/transport` 负责 HTTP、会话校验和静态 UI 服务。
- `apps/server` 装配；`apps/web` 仅消费公共协议。现已接入 infra-storage、infra-git、infra-platform 和 infra-pi；infra-mwf 已接入原生 add/propose 保存；初始化、召回和修订配置仍待实现。
- workspace 只通过包公开入口访问；`scripts/check-architecture.mjs` 检查所有 src 的静态/动态字面导入与类型导入、禁止跨包相对路径和循环。

## 固定版本契约

应用实际依赖的内核路径、协议及升级门槛见 [原生依赖契约](native-contracts.md)。真实内核测试采用固定 pi 加可控测试 provider；它们证明协议和恢复行为，不等同于真实外部模型或全部 provider 的兼容验收。
