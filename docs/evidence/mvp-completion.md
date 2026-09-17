# MVP 完成与交付

2026-09-17，M0–M5 已完成。完成范围为既定 C01–C14、A01–A16 及 I01–I07，平台为 Linux；macOS 通过本机 Linux 的方案及配置已交付，实机验证按用户明确决定后置。

## 验收依据

逐条行为与测试位置见 [完整验收矩阵](m5-acceptance.md)。I01 的依赖方向、公开入口和循环检查通过；I02/I03 的进程收束、崩溃窗口、pending 对账与明确恢复对应 A05–A09；I04 配置/模型/凭据对应 A10/A11；I05 保存失败、修订冲突与重试对应 A12；I06 固定内部契约、原生旧会话升级对应 A15；I07 真实 UI、HTTP/SSE、本地校验、SQLite、pi 和附件闭环对应 A01/A08/A09/A11/A16。C01–C14 沿用规格的完整映射，没有缩减范围。

- Node 常规套件：67 项通过，无失败或跳过；架构、类型、格式检查通过。
- 最终前端构建通过；完整浏览器 12 项通过，含键盘、窄窗口、关闭网页后后台完成和重开恢复。
- 完整独立运行包测试通过：实际 pi/MWF、HTTP 校验、正常退出与包内备份。
- 真实 DeepSeek Flash 应用验收通过：文字、Bash、图片、后端重启和继续会话，见 [M5k 证据](m5-live-application.md)。
- 原生升级声明限于真实 0.84.1 样本到固定 0.85.1 的打开/继续/fork；不宣称任意历史版本兼容。

最终产品代码自 `9154eaa82c29cefa4077974b7e78502bd0925dec` 未变化，后续仅有验收测试和交付文档；已核对 apps/packages/scripts、依赖锁文件、deploy 与原生版本清单无差异。因此 [保留运行包](m5-runtime-candidate.md) 是本次交付的产品版本，归档摘要不变，无须因报告提交重复打包。

## 使用

归档 `/tmp/parallel-pi-mvp-9154eaa/parallel-pi-linux.tar.gz`，SHA-256 `1758e5f91b151c8621b8ae6dac36309ef0c76823a9a336031ed45f0ca083050d`。该路径属于当前环境，清理环境前应复制到持久位置。安装/启动/平台依赖见 [Linux/Lima 运行](../linux-runtime.md)，数据保全及手动更新见 [备份升级](../backup-upgrade.md)。

源码启动可使用 `node --env-file=.env scripts/runtime.mjs`，在界面选择 `deepseek` / `deepseek-flash`；`.env` 为本地忽略文件，不包含在运行归档或 Git 中。新机器需要自行配置凭据。此启动方式加载凭据；测试用的 `PARALLEL_PI_PROVIDER/MODEL` 不代替应用界面的模型选择。

所有阶段已分别本地提交，没有推送或外部发布。当前已无 MVP 阻塞项；macOS 实机、其他 CPU/libc 组合和任意旧版本兼容不属于本次已验证结论。
