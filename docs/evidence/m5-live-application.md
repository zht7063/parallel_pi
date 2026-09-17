# M5k：真实 DeepSeek Flash 应用验收

2026-09-17，在用户配置的本地 `.env` 下执行：

```sh
node --env-file=.env --test tests/live-application.mjs
```

固定原生 provider `deepseek`、model `deepseek-flash`，使用原生 DeepSeek 接口；没有加载测试 provider 或夹具扩展。真实 API 由用户授权，密钥只从本地环境加载，不进入本报告或 Git。

1 项测试通过，0 失败、0 跳过，用时 17.96 秒。独立临时 Git 仓库、应用 SQLite、原生 agent 目录与附件区执行结束后清理。生产 `createBackend` 与 HTTP 命令用于项目添加、会话创建、发送、查询历史；图片通过应用 upload 接口进入真实附件存储。测试的源码 SHA-256 为 `f4cc3d9ca6f39190a160c7461ef61ba34019651507cdc6dff0a5be4528caa8c9`。

| 检查 | 实际通过证据 |
| --- | --- |
| 文字 | 真实回复包含本轮合成标记；相同 HTTP request_id 重试返回同一 run |
| 工具 | 模型实际调用 Bash，原生持久历史的 tool 消息包含 `parallel-app-live-tool` |
| 图片 | 实际回复识别图片主色为 red；持久用户消息保留上传的同一图片字节 |
| 后端重启 | 关闭完整 backend 后用相同数据目录重新创建，原历史 ID 全部保留，仍只有原三个 run |
| 继续会话 | 第四个 run 在重启后正确返回此前标记，实际 provider/model 未替换 |
| 工作区 | 未提交的合成文件内容未改变；最终恰好四个 run，没有自动重放 |

该测试默认不进入离线 `npm test`，必须显式执行，可能产生 API 费用。它验证一次真实供应商应用贯通，不是可靠性、模型质量或性能基准。图片预览/移除、非视觉拒绝和浏览器交互由独立浏览器及应用测试证明。

本次新增验收脚本的类型/格式检查通过。日志 `/tmp/parallel-pi-m5k-live.log`；归档文档只保留结果，不复制模型原文、HTTP 请求头或凭据。
