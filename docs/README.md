# parallel_pi MVP 设计与讨论

设计阶段基线已完成。优先阅读 [MVP 设计规格 v0.1](mvp-spec.md)、[页面线框图册](design/README.md) 和 [设计评审与交接](design-review.md)。规格区分用户已确认约束 C、建议默认值 D、技术验证项 V；下方文档保留讨论与研究依据。

- [MVP 可行性与设计讨论](./mvp-discussion.md)：双分支模型、内核集成、MVP 范围、风险和待定问题。
- [地图与会话交互](./ui-interaction.md)：全局地图、右侧详情、专注会话和 pi 配置入口。
- [领域术语](./CONTEXT.md)：已确认的 Git 分支与思路分支定义。
- [pi / omp 选型分析](./engine-comparison.md)：基于官方接口、MWF 适配和源码构建的选型依据；已确认采用原版 pi。
- [文件记忆设计](./memory-design.md)：memory-with-files 调研与 parallel_pi 适配建议。

已确认：思路分支只分叉对话上下文，使用所在 Git 分支当前代码，不对应代码版本；后续会话通过固定目录选择性读取文件记忆，项目偏好与结论管理沿用 Memory with Files 的设计思路。执行模式为同一 Git 分支内串行排队、不同 Git 分支之间并行。MVP 为本地单用户 Web UI，管理本机 Git 项目。其余标为“建议”的内容尚未定案。已完成线框与关键默认行为评审；本次仅提交设计，内核已选定原版 pi，提交不包含子模块；具体版本和接入方式留待下一阶段验证。
