# M5j：保留的 Linux 交付候选

应用提交：`9154eaa82c29cefa4077974b7e78502bd0925dec`。这是包含 M5a–M5i 修复和验收的 Linux x64 候选；真实外部模型应用验收仍待完成，因此本文件不是 MVP 全部完成声明。

## 产物

- 归档：`/tmp/parallel-pi-mvp-9154eaa/parallel-pi-linux.tar.gz`
- 摘要文件：`/tmp/parallel-pi-mvp-9154eaa/SHA256SUMS`
- SHA-256：`1758e5f91b151c8621b8ae6dac36309ef0c76823a9a336031ed45f0ca083050d`
- 已验证解包：`/tmp/parallel-pi-mvp-9154eaa-unpacked/parallel-pi`
- manifest：Linux/x64、上述完整应用提交、`development: false`、31,638 个文件/链接条目。

归档保留于本次环境的临时目录，应在清理环境前复制到用户选择的持久位置。未上传到外部托管，也未推送 Git。

## 验证

`npm run build` 通过；完整 `npm run test:browser` 12 项通过（2.8 分钟，包含关闭最后网页后后台工具完成及重开场景）。日志分别为 `/tmp/parallel-pi-m5j-build.log` 和 `/tmp/parallel-pi-m5j-browser.log`。

在源码干净且原生依赖匹配时，执行 `python3 scripts/package-runtime.py /tmp/parallel-pi-mvp-9154eaa`，未使用 `--development`。`sha256sum -c SHA256SUMS` 通过。解包到独立新目录后，从源码目录之外运行包内 `scripts/runtime.mjs --check`，运行时、所有文件摘要/链接、平台/架构及固定版本检查通过，输出提交号与清单相同。

此前 M5h 的完整包测试验证独立启动、HTTP 本地校验、真实 pi/MWF、正常退出和包内备份；M5i 只改变浏览器测试与文档，本轮未改变产品代码，构建资产 hash 相同。完整 Node 67 项及架构/类型/格式检查的适用证据见 [M5 验收工作表](m5-acceptance.md)。不以静态启动预检代替这组实际执行证据。

安装及 macOS 本机 Lima 路径见 [运行说明](../linux-runtime.md)。该归档为 Linux x64，不适用于直接在 macOS 运行或直接用于 arm64 guest；macOS 实机验证按用户确认后置。
