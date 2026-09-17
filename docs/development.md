# 本地开发与验证

当前实现阶段见 [里程碑](milestones.md)。M1 是可运行骨架，尚不具备项目/session 执行能力。

## 环境与运行

现有验证环境：Linux、Node.js 26.8.2、npm 11.19.1。此运行时沿用探针基线，不声称长期支持承诺。后端直接运行可擦除类型的 TypeScript；前端由 Vite 构建。

```sh
npm ci --ignore-scripts
npm run build
npm start
```

在浏览器打开终端输出的 `http://127.0.0.1:4317`。仅监听 loopback，Host 必须使用该地址。通过 `PARALLEL_PI_PORT` 修改端口。`npm run dev` 监听后端改动；修改前端后重新运行构建。

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
- `apps/server` 装配；`apps/web` 仅消费公共协议。适配器在 M2/M4 实际接入时建立。
- workspace 只通过包公开入口访问；`scripts/check-architecture.mjs` 检查所有 src 的静态/动态字面导入与类型导入、禁止跨包相对路径和循环。
