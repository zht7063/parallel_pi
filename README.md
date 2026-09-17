# parallel_pi

基于原版 pi 的本地单用户可视化 agent harness，按 Git 分支组织开发，以 session 地图呈现对话与思路分叉。

MVP 已完成：分支工作区与队列、真实 pi 执行/停止/崩溃恢复、会话地图与接续/fork、模型配置、文件记忆、Git diff/提交、备份及 Linux/Lima 运行交付均已实现。67 项 Node 测试、12 项浏览器测试、独立运行包验收及真实 DeepSeek Flash 应用验收通过，详见 [完成报告](docs/evidence/mvp-completion.md)。

前端采用 Vue 3 + TypeScript，后端为本地 Node.js + SQLite。当前验证环境为 Linux；macOS 已确定通过本机 Linux 环境（Docker Desktop/Lima）运行后端与工具，启动方式见下方运行文档，macOS 实机验证按用户决定后置。原版 pi 与 MWF 使用固定版本，手动检查上游更新，omp 暂缓。真实 DeepSeek Flash 已通过应用文字、工具、图片及后端重启后继续会话验收；与受控 provider 测试分别记录。

- [实施里程碑](docs/milestones.md) · [本地开发与验证](docs/development.md)
- [Linux 运行包与 macOS 本机 Lima](docs/linux-runtime.md)
- [本机备份、恢复与手动升级](docs/backup-upgrade.md)
- [MVP 实施交接与遗留任务](docs/implementation-handoff.md)
- [技术验证记录](docs/validation.md) · [运行探针](probes/README.md)
- [已确认技术架构与验证计划](docs/architecture.md)
- [交互式项目结构图](docs/visualization/project-structure.html) · [结构说明](docs/visualization/README.md)
- [MVP 设计规格](docs/mvp-spec.md)
- [页面线框图册](docs/design/README.md)
- [设计评审与阶段交接](docs/design-review.md)
- [全部设计与研究文档](docs/README.md)

核心约定：同一 Git 分支内串行、不同分支之间并行；思路分叉只影响对话上下文，使用当前代码；文件记忆沿用 Memory with Files 的设计。
