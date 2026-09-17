# 本机备份、恢复与手动升级

此流程适用于 Linux 后端所在环境，保留原机器上的绝对路径。macOS 使用本机 Linux 环境时，应在该 Linux 环境内执行。备份不是跨机器迁移包，不会自动重映射 Git worktree、会话路径或凭据。

## 创建备份

先在界面完成或取消排队任务，处理待保存记忆和待核对提交，恢复核验异常分支。退出后端并等待它正常结束，同时停止原生 pi、编辑器自动写入和其他会修改相关仓库/配置的工具。备份命令不会取消任务或替用户处理不确定结果。

```sh
python3 scripts/backup.py create /absolute/backups/parallel-pi-before-upgrade \
  --data-dir /absolute/parallel-pi-data \
  --agent-dir /absolute/pi-agent
python3 scripts/backup.py verify /absolute/backups/parallel-pi-before-upgrade
```

也可省略两个目录参数，沿用启动时的 `PARALLEL_PI_DATA_DIR`、`PARALLEL_PI_AGENT_DIR`；原生配置目录还识别 `PI_CODING_AGENT_DIR`。务必与实际后端配置一致。未设置时使用开发文档中的默认目录。输出目录必须不存在，且与所有备份源互不包含；不能放在用户项目中。

命令获取与后端相同的 SQLite 实例独占锁，拒绝 queued/活动运行、pending/uncertain 操作、未处理记忆和待核对提交。每个监督操作还须释放进程锁且具有 settled 证据。遇到拒绝应重新启动应用处理原因，再正常退出；不要删除锁或监督证据来绕过检查。

备份包含整个应用数据目录、原生 agent 目录、登记项目的工作目录、Git common directory，以及所有已绑定 worktree。未跟踪和忽略文件也保留，因此目录可能较大。数据库 WAL、原生 JSONL、图片、交接、Git 提交回执、`.pi` 与 `.mwf` 都随所在目录保留。没有初始化记忆的项目不会因备份被初始化。

外部符号链接保留链接本身；存在的目标若不在备份源内，命令拒绝并提示用重复的 `--include /absolute/path` 纳入。配置以普通字符串引用的外部扩展、模型脚本、Git alternates、外部 hooksPath 或其他资源无法通用推断，也必须由使用者通过 `--include` 纳入。环境变量和系统密钥环不在目录归档内，恢复时需重新提供。断开的符号链接原样保留。

输出为权限受限的目录（0700）、`files.tar.gz` 和 `manifest.json`（0600），包含源路径、固定依赖版本、应用 commit、依赖锁文件摘要、SQLite schema、条目列表和归档 SHA-256。manifest 最后写入；复制中断或源目录发生可检测的变化不会产生成功结果。失败会清理本次新建目录；强杀遗留的无完整 manifest 目录不能用于恢复。应用使用正式提交构建时，commit 才对应准确发布版本；本地未提交源码需自行保留。

归档含凭据与全部本地项目内容，保持在本地受限位置，不放进 Git。SHA-256 用于发现意外损坏，并非抵御能同时改写归档和清单的攻击者。

## 恢复演练与实际恢复

先运行 `verify`。然后解包到**全新、空的暂存目录**，不要直接覆盖真实根目录：

```sh
mkdir -m 700 /absolute/restore-staging
tar -xzf /absolute/backups/parallel-pi-before-upgrade/files.tar.gz \
  -C /absolute/restore-staging
```

归档条目去掉开头 `/`，例如 `/home/me/project` 位于暂存目录的 `home/me/project`。查看 manifest 的 roots，核对会话、附件、仓库和记忆内容。归档只应来自可信的本地备份。暂存解包仅用于检查；数据库中的路径仍指向原位置，**不能在暂存副本上直接启动应用**。

实际恢复时，停止后端及所有外部写入者，先保留当前数据和升级后新工作的独立副本。逐项选择需要恢复的根目录，将现存目录移到另一个保留位置，再把对应暂存副本放回原绝对路径并保留权限/符号链接。若原启动路径使用目录别名或符号链接，恢复其原映射。不要把旧数据库合并进现有目录，也不要只替换 app.sqlite 而留下另一时点的 WAL、session 或回执。

应用目录包含受管理 worktree；这些与外部 Git common directory、工作目录和 `.mwf` 可能相互引用，须按同一备份时点协调恢复。**恢复代码工作区会替换后续修改，必须明确选择并先保存新工作**。命令不自动恢复任何目录，也不自动 reset Git。只回退应用代码、只恢复元数据和完整恢复项目是不同操作，不能互相替代。

用备份清单对应的应用/内核版本启动，观察恢复结果；核对项目路径、分支 HEAD、会话历史、附件、草稿、记忆和凭据。异常分支按应用核验流程处理，恢复队列需明确操作。首次开放新任务前，做一次真实继续会话和记忆读写验证。

## 手动检查与升级

1. 手动查看 pi/MWF 上游变更、许可证与接口差异，在独立升级分支或独立检出目录进行；不直接改变运行中应用的 vendor 或构建产物。
2. 更新固定 gitlink、`probes/versions.json` 和实际受影响的锁文件/适配代码。检查 `docs/native-contracts.md` 的内部接口依赖，不以系统任意版本替换固定内核。
3. 在隔离测试数据上构建候选版本，执行 `npm run check`、`npm run build`、`npm run test:browser`，并执行 `node --test probes/v01-upgrade.test.mjs` 验证旧原生样本。应用旧会话测试可单独运行 `node --test --test-name-pattern="application upgrade opens" tests/harness.test.ts`，覆盖旧会话打开、继续、分叉及既有 MWF 的召回/写入；`tests/memory-agent.test.ts` 另验证实际原生 MCP 工具链。探针本身不能替代这些应用级验收；固定样本边界与结果见 M5 验收矩阵。
4. 处理生产应用尚未启动的队列，不让它们在升级时悄悄换用另一内核。停止应用、等待进程收束，按上文创建并校验完整备份。
5. 切换到已验证候选构建。若引入数据迁移，迁移须有独立测试和回退说明；当前 schema=1 的备份工具拒绝未知 schema，不擅自降级。
6. 启动并检查恢复、旧会话、Git/MWF 与模型可用性，再开放任务。失败时先保存候选版已写入数据；仅在确认兼容时回退代码，否则按备份清单明确恢复数据，不能自动覆盖升级后新工作。

当前没有后台更新检查、自动升级、自动恢复或跨机器同步。Linux 备份测试证明实例锁、归档内容、恢复副本数据库和损坏检测；完整升级验收及 macOS 本机 Linux 运行打包的证据独立记录，不以本说明代替实测。
