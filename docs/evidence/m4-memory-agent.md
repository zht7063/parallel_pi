# M4d：运行时自动记忆与 MCP

应用在每次真实 pi RPC 运行中加载工作区记忆桥接扩展。已有 `.mwf/config.json` 时使用固定版原生 bootstrap，并提供绑定当前真实工作区的 `parallel_mwf` MCP 服务；未初始化工作区不创建目录、不安装项目扩展。模型上下文说明记忆是数据，用户指令和项目规则优先。

已有 native bootstrap 仅在生成模板、路径和配置匹配时复用；否则应用桥接负责当前工作区上下文。已知 MWF custom message 只将当前最新 bootstrap 送入模型，原生 JSONL 不改写。已有 MCP adapter 通过其公开运行时注册事件复用；缺少时安装应用实例，不覆盖用户 MCP 配置。原生服务负责拒绝其他根目录请求。

可见原生 custom message 现在进入应用持久 notice 事件。会话的“运行通知”在执行结束和页面刷新后仍显示；隐藏 bootstrap 不展示。配置检查加载 eager MCP 扩展后显式退出 worker，现有监督器收束子进程后再释放分支维护占用。

## 可复现证据

- `tests/memory-agent.test.ts`：受控 provider 驱动真实 pi 工具循环；原生 bootstrap、MCP recall/add、跨根拒绝、另一 worktree 不隐式初始化、已有 adapter 复用且只有一个 mcp 工具、原生兼容 bootstrap 去重、带旧绝对路径的嵌套目录扩展过滤、原生历史保留、损坏配置的可见通知。配置检查真实加载 eager MCP 并完成收束。
- `tests/memory.spec.ts`：先恢复记忆冲突后保留的暂停分支，再发送真实运行；等待终态后验证 bootstrap 错误通知，刷新后保留，390px 不横向溢出。不会以加长页面断言替代真实运行完成。
- `npm run check`：41 项 Node 测试、架构、类型和格式检查通过。`npm run build` 通过。运行时依赖调整未改变锁文件中的任何包版本。
- 完整浏览器回归：8 个场景通过。已查看 `test-results/memory-notice-narrow.png`，390px 通知可滚动阅读、无横向溢出，输入与发送可达。
- UI strict：0 errors / 0 warnings；DESIGN lint：0 errors / 1 项既有无 YAML warning。

## 证据边界

provider 是本地确定性 fixture；这里证明真实 pi/MWF/MCP 集成，不证明外部模型质量或真实外部服务连接。原生 bootstrap 失败按原生语义通知并继续模型，不能虚报加载成功。应用显式关键记忆保存仍由持久任务负责暂停和重试；任意 agent 工具调用沿用原生结果语义。

过滤已知 bootstrap 消息不是任意扩展的安全沙箱，用户已有 MCP 服务仍保留。Linux 监督器负责进程收束；macOS 本机 Linux 打包、Git diff/提交、备份/手动升级和完整 M5 验收仍待完成。本段不代表完整 MVP。
