# parallel_pi

基于原版 pi 的本地单用户可视化 agent harness，按 Git 分支组织开发，以 session 地图呈现对话与思路分叉。

当前已完成 MVP 设计基线，技术架构已确认，前端采用 Vue 3 + TypeScript，已开始 V01–V04 技术探针，尚未开始应用开发。首版优先支持 Linux 和 macOS，手动检查上游更新；omp 支持暂缓。原版 pi 已通过 Git 子模块固定接入；RPC 核心路径首轮验证通过，完整兼容结论仍待后续实验。

- [技术验证记录](docs/validation.md) · [运行探针](probes/README.md)
- [已确认技术架构与验证计划](docs/architecture.md)
- [交互式项目结构图](docs/visualization/project-structure.html) · [结构说明](docs/visualization/README.md)
- [MVP 设计规格](docs/mvp-spec.md)
- [页面线框图册](docs/design/README.md)
- [设计评审与阶段交接](docs/design-review.md)
- [全部设计与研究文档](docs/README.md)

核心约定：同一 Git 分支内串行、不同分支之间并行；思路分叉只影响对话上下文，使用当前代码；文件记忆沿用 Memory with Files 的设计。
