# V01–V04 技术探针

这些是隔离实验，不是应用实现。所有 Git、会话和记忆写入都发生在临时目录；不使用用户项目或真实凭据。版本见 `versions.json`。

## V01

```sh
node probes/setup-pi.mjs
node --test probes/v01.test.mjs probes/v01-upgrade.test.mjs
```

`setup-pi.mjs` 核对 pi 子模块提交，恢复已校验的公开模型目录快照，再执行 `npm ci --ignore-scripts` 和上游离线构建。模型快照来自上游 `hydrate:model-data`，保留上游 manifest 和逐文件 hash，许可证沿用 `vendor/pi/LICENSE`。重新下载目录会得到不同数据，不能悄悄替换本快照。

V01 使用真实 pi RPC、原生持久化、Bash 工具、扩展 UI 和上游 faux provider。它证明协议与执行链路，不证明真实 provider 的视觉理解或模型质量。结果见 [验证报告](../docs/validation.md)。

`probes/.cache/`、`node_modules/` 和 `probes/results/local/` 为本地生成物，已忽略。可审查的脱敏验证记录放 `probes/results/`；用户凭据、会话原文和临时工作区不进入 Git。

## V02

```sh
node --test probes/v02.test.mjs
```

`coordinator.mjs` 是 SQLite 持久队列实验，用真实 worktree 和 pi 进程验证崩溃窗口。它保守阻止未核验恢复，不提供生产级进程树监督。

## V03

```sh
node --test probes/v03.test.mjs
```

使用固定 pi 的原生设置/认证存储和真实 RPC。配置修订包装器的内部路径依赖见验证报告。

### V01 旧版本与真实模型

`fixtures/pi-0.84.1-session.jsonl` 由真实旧版 SessionManager 生成；测试只重定位 fixture 的 cwd，其他历史条目保持不变。重新生成时，在 `probes/.cache/pi-previous` 安装精确版本 `@earendil-works/pi-coding-agent@0.84.1`（`--ignore-scripts`），核对 metadata 中的包完整性值，再运行 `node probes/generate-previous-session.mjs`。

真实模型验证需在本地设置 `PARALLEL_PI_PROVIDER`、`PARALLEL_PI_MODEL` 和该 provider 的原生凭据环境变量，然后执行 `node --test probes/v01-live.test.mjs`。它会执行 4 次真实提示（文字、工具、图片、恢复），可能消耗额度；没有配置会明确失败，不会把跳过当通过。测试使用临时 HOME 与 agent 目录，不读取其他 harness 的凭据。不要把密钥写入命令记录或仓库。
