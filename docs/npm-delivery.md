# npm 安装候选

本说明对应 `codex/native-core-npm` 的开发候选，不是已发布产品。当前候选仅验证 Linux，macOS 原生监督仍待完成；不使用 Lima 作为最终安装方案。

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

## 构建内容

应用 TypeScript 与 worker 预编译为 JavaScript，内部包引用转换为包内路径。Web 静态资源、Python 监督器及备份脚本随包提供；固定 pi、MWF、MCP adapter 的生产依赖随包捆绑，安装不执行依赖构建脚本。第三方许可证随各依赖保留。构建文件清单排除应用未跟踪文件、Git 元数据和 Python 缓存。

当前构建按本机构架收集已安装原生依赖，不能把 Linux x64 候选当作 macOS/arm64 包。跨平台成品布局还需随 N1 的平台实现确定。`build-info.json` 记录平台、架构、源码提交、原生版本和依赖锁摘要，供预检及备份使用。

## 验收与管理

```sh
npm run test:npm
```

专项测试在源码之外构建和离线安装 tarball，检查发布清单，启动 Web/API，操作真实 Git、pi 和 MWF，执行包内备份并验证重新安装/卸载保留用户数据。测试使用确定性模型，不调用付费模型。

升级前停止服务并备份，之后安装新的候选版本。`npm uninstall --global parallel-pi` 只移除程序；数据、凭据和项目由用户独立管理。重新安装同版本验证不等于已经证明所有旧版本升级兼容性，旧 MVP 数据及跨版本升级仍属于 N4 验收门槛。
