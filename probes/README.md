# V01–V04 技术探针

这些是隔离实验，不是应用实现。所有 Git、会话和记忆写入都发生在临时目录；不使用用户项目或真实凭据。版本见 `versions.json`。

## V01

```sh
node probes/setup-pi.mjs
node --test probes/v01.test.mjs
```

`setup-pi.mjs` 核对 pi 子模块提交，恢复已校验的公开模型目录快照，再执行 `npm ci --ignore-scripts` 和上游离线构建。模型快照来自上游 `hydrate:model-data`，保留上游 manifest 和逐文件 hash，许可证沿用 `vendor/pi/LICENSE`。重新下载目录会得到不同数据，不能悄悄替换本快照。

V01 使用真实 pi RPC、原生持久化、Bash 工具、扩展 UI 和上游 faux provider。它证明协议与执行链路，不证明真实 provider 的视觉理解或模型质量。结果见 [验证报告](../docs/validation.md)。

`probes/.cache/`、`node_modules/` 和 `probes/results/local/` 为本地生成物，已忽略。可审查的脱敏验证记录放 `probes/results/`；用户凭据、会话原文和临时工作区不进入 Git。
