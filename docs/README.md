# parallel_pi MVP 设计与讨论

设计、架构及 Linux 探针阶段已具备进入 MVP 实施的基础，应用开发尚未开始。先阅读 [实施交接与遗留任务](implementation-handoff.md)。当前进度以 [V01–V04 验证记录](validation.md) 为准，运行方法见 [探针说明](../probes/README.md)。优先阅读 [MVP 设计规格 v0.1](mvp-spec.md)、[页面线框图册](design/README.md) 和 [设计评审与交接](design-review.md)。规格区分用户已确认约束 C、建议默认值 D、技术验证项 V；下方文档保留讨论与研究依据。

- [已确认技术架构](./architecture.md)：五层职责、模块与进程、内核适配、数据归属、执行恢复及升级策略；前端采用 Vue 3，尚未实现。
- [交互式项目结构图](./visualization/project-structure.html) 与 [结构说明](./visualization/README.md)：运行链路、目录映射与数据边界。
- [MVP 可行性与设计讨论](./mvp-discussion.md)：双分支模型、内核集成、MVP 范围、风险和待定问题。
- [地图与会话交互](./ui-interaction.md)：全局地图、右侧详情、专注会话和 pi 配置入口。
- [领域术语](./CONTEXT.md)：已确认的 Git 分支与思路分支定义。
- [pi / omp 选型分析](./engine-comparison.md)：基于官方接口、MWF 适配和源码构建的选型依据；已确认采用原版 pi。
- [文件记忆设计](./memory-design.md)：memory-with-files 调研与 parallel_pi 适配建议。

已确认：思路分支只分叉对话上下文，使用所在 Git 分支当前代码，不对应代码版本；后续会话通过固定目录选择性读取文件记忆，项目偏好与结论管理沿用 Memory with Files 的设计思路。执行模式为同一 Git 分支内串行排队、不同 Git 分支之间并行。MVP 为本地单用户 Web UI，管理本机 Git 项目。技术架构基线已确认，采用 Vue 3 + TypeScript；其余产品交互和视觉 D 项仍按原规格管理，技术 V 项已有 Linux 可控集成探针证据，并已补充 DeepSeek 真实模型验证，macOS 实机验证延后至 MVP 完成后在用户本地电脑进行，不阻塞当前开发。已完成线框与关键默认行为评审；设计阶段之后已接入固定 pi 子模块并提交技术探针；全量兼容门槛见验证记录。
