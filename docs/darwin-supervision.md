# macOS 进程监督：候选机制与实机探针

状态：机制调查与探针已交付，尚未在 macOS 执行，生产适配器没有启用。本文件不构成 macOS 支持声明。

## 必须保留的行为

工具退出或取消后，后端只有在获得完整进程清理证据时才释放工作区。setsid/double-fork、后端崩溃、监督器崩溃及 PID 复用不得被当成普通退出。Linux 现有 subreaper/pidfd 实现继续保留。

## 已排除的直接替换

Apple XNU 的 [kqueue 实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_event.c) 在 `filt_procattach` 中拒绝 `NOTE_TRACK`、`NOTE_TRACKERR`、`NOTE_CHILD`。所以不能把 FreeBSD 的自动后代跟踪当作 macOS 可用功能。

仅扫描父子关系或终止 POSIX 进程组都不能证明脱离的后代已经退出。直接由普通进程创建资源组也不可假定可用：[coalition syscall](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c) 对创建/销毁操作要求调用者属于特权 coalition。

## 待验证候选

利用临时用户 launchd job 获得独立的内核 resource coalition（资源组，不是 POSIX process group）。如果 fork/setsid 后的全部后代仍属于该组，则可以用内核 `tasks_started - tasks_exited` 核验组内是否仅剩监督器，而不以用户态枚举结果作为清理证据。

Apple 提供了 [resource usage 包装函数](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/coalition.c) 和 [计数结构](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h)。这些源码说明接口的实现，但不证明目标 macOS 版本上普通用户可用，也不证明 launchd 一定分配独占资源组。

PID 信号路径另验证 `PROC_INFO_CALL_SIGNAL_AUDITTOKEN`。Apple 的 [proc_info 实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c) 通过 audit token 传递进程世代，[private header](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h) 定义了查询结构与调用编号。普通 PID 的“查询后 kill”有竞态，不能作为不支持该接口时的静默回退。这些接口的目标系统兼容性仍需实测，不能仅凭当前 XNU main 源码决定支持版本。

## 运行探针

在普通 macOS 用户会话中，使用 Python 3.11+：

```sh
python3 probes/darwin-supervision.py
```

脚本创建一个临时用户 launchd job，以及一个有超时上限的 detached double-fork 测试进程；只写临时目录，不需要 sudo、不安装常驻服务、不操作用户项目。结束时移除临时 job。失败以非零状态退出，不会改用较弱方式报告成功。

检查项目：

1. 当前用户能读取 coalition 与进程世代信息。
2. launchd 分配了不同于调用者、最初仅含监督器的资源组。
3. 错误世代的 signal 0 被内核以 ESRCH 拒绝，正确世代可访问。
4. 脱离进程组并 double-fork 后仍属于该资源组。
5. 杀死该测试后代后，内核计数回到只剩监督器。

通过后输出系统/Python 版本及各项结果，同时明确 `productionAdapterVerified: false`。本轮 Linux 仅验证了 Python 语法与非 macOS 拒绝路径，未执行上述 Darwin 检查。

## 通过探针后仍需完成

- 确认 fork/exec/posix_spawn 继承和计数的生命周期语义，尤其 zombie/corpse 和内核计数更新时间。
- 设计 launchd job 与核心的 stdin/stdout/stderr 桥接、环境传递及启动登记事务，避免将凭据写入 launchd plist。
- 校验正常完成、取消、执行期间后端 SIGKILL、监督器 SIGKILL、重启、睡眠唤醒及 PID 世代变化。
- 工作区解锁以明确内核证据为准；临时 job 不存在、读取失败或超时都不能直接推导任务安全结束。
- 验证不依赖管理员权限及额外系统授权；如失败，再调整候选机制，不能用生产代码掩盖未解决的平台限制。
