# parallel_pi

基于原版 pi 的本地单用户可视化 agent harness，按 Git 分支组织开发，以 session 地图呈现对话与思路分叉。

当前已完成 M1 应用骨架、M2 执行恢复和 M3 地图与会话：真实 pi、图片/队列/停止、崩溃恢复、共享关系地图、接续/fork、远端分支、历史分页和跨项目浏览恢复已贯通。M4 配置、记忆纠正、diff/提交与交付打包及 M5 最终验收仍在后续，不是完整 MVP。

前端采用 Vue 3 + TypeScript，后端为本地 Node.js + SQLite。当前验证环境为 Linux；macOS 已确定通过本机 Linux 环境（Docker Desktop/Lima）运行后端与工具，启动打包待后续交付，实机验证按用户决定后置。原版 pi 与 MWF 使用固定版本，手动检查上游更新，omp 暂缓。早期 DeepSeek 真实模型验证与本阶段可控 provider 应用测试分别记录，不互相替代。

- [实施里程碑](docs/milestones.md) · [本地开发与验证](docs/development.md)
- [MVP 实施交接与遗留任务](docs/implementation-handoff.md)
- [技术验证记录](docs/validation.md) · [运行探针](probes/README.md)
- [已确认技术架构与验证计划](docs/architecture.md)
- [交互式项目结构图](docs/visualization/project-structure.html) · [结构说明](docs/visualization/README.md)
- [MVP 设计规格](docs/mvp-spec.md)
- [页面线框图册](docs/design/README.md)
- [设计评审与阶段交接](docs/design-review.md)
- [全部设计与研究文档](docs/README.md)

核心约定：同一 Git 分支内串行、不同分支之间并行；思路分叉只影响对话上下文，使用当前代码；文件记忆沿用 Memory with Files 的设计。
