# parallel_pi 设计方向

状态：MVP v0.1 的三张静态 SVG 线框已获用户接受；M1–M3 应用骨架、真实执行与共享关系地图已接入；M4 配置/成果界面和 M5 全量验收尚未完成。

前端技术基线已确认：Vue 3 + TypeScript。分层与依赖规则见 [技术架构](docs/architecture.md)；地图使用原生 SVG + HTML 自动布局，不引入地图组件依赖，架构确认不表示线框视觉细节已冻结。

## 产品与布局

本地单用户开发工具。页面主要任务是查看 Git 分支及会话地图，并进入指定 session 持续工作。用户提出的布局与行为记录在 [地图与会话交互](docs/ui-interaction.md)，领域规则见 [MVP 讨论](docs/mvp-discussion.md)。

全局视图以地图为主体，右侧为可展开详情，左下角为 pi 配置入口，其上方为项目切换区；新添加项目紧邻设置按钮，旧项目向上移动。专注会话时对话成为主体，地图缩为左上角导航入口；单击查看地图面板，双击返回全局。

## 设计约束

- 保留用户指定的两层浏览方式，不以普通列表或固定多栏聊天替代地图。
- 思路节点表示 session，颜色以外还须有文字状态。
- 预览、进入会话与实际执行任务区分清楚。
- 已确认预览与会话工作分离、地图使用应用内浮层、返回恢复地图位置、切换会话保留草稿与后台任务，以及双击与显式按钮并存。
- 项目切换保留各项目浏览位置与草稿，不停止原项目任务；项目入口显示运行中、等待回答或失败状态。
- 其余交互补充标为建议，不能自动视为用户已确认。

## 设计产物与行为归属

- [MVP 设计规格](docs/mvp-spec.md) 为本版产品与行为契约：C 是已确认边界，D 是本版建议默认值，V 是技术验证项。
- [静态线框图册](docs/design/README.md) 展示全局地图、专注会话和地图浮层。
- 规格第 3、6、7 节分别维护导航、执行和配置行为，不另复制一份 UX-CONTRACT 以免漂移。

## 本版线框视觉提案（D）

产品界面以分支轨道和 session 关系图为特征；高信息密度集中在地图，对话阅读区保持清楚的层次。建议以偏冷的浅色工作面搭配蓝色选择态，色彩不代替运行状态文字；不采用营销式大标题与装饰卡片墙。

| 角色 | 线框使用值 |
| --- | --- |
| 页面底色 | `#F3F5F8` |
| 内容面 | `#FFFFFF` |
| 边框与连线 | `#CAD3DF` |
| 主要文字 | `#202D42` |
| 次要文字 | `#526278` |
| 选中/主操作 | `#315AA8` |
| 选中底色 | `#EAF0FC` |

字体暂用系统中文无衬线回退，建议技术标识最终使用等宽字。SVG 使用 1440×900 评审画布，不是固定窗口要求；尺寸、字体、颜色仍可修改。应用初始沿用已评审配色；运行时 token 的唯一入口是 `apps/web/src/style.css`，组件通过 CSS 变量消费，不复制字面颜色。

## 尚未确定的视觉细节

本版已给出线框配色与布局提案；最终字体、间距、圆角、图标、动效和断点待评审。当前已建立基础控件样式与连接状态；地图/会话共享组件随里程碑实施，并按交互验收覆盖键盘、窄窗口、加载和错误状态。

## 运行时映射与 UI 归属

本项目是简体中文本地开发工具，界面文案与辅助标签使用 zh-CN；技术标识保留原文。没有日本市场专属流程。视觉特征沿用分支轨道和 session 关系，不增加营销式视觉结构。现有行为契约为 `docs/mvp-spec.md`，不另建重复的 UX-CONTRACT。

| 角色 | 唯一运行时入口 / 消费者 |
| --- | --- |
| 七项已评审配色 | `style.css` 的 background/surface/border/text/muted/primary/selected 变量；全局控件与各视图消费 |
| 滚动条 | `style.css` 全局 scroll-thumb/track/hover/active；高对比模式采用系统颜色 |
| 字体 | 根节点 system-ui + 中文回退；技术标识 ui-monospace；正文 15px / 1.6 |
| 基础交互状态 | 全局 button、focus-visible、disabled 样式；不在各页面重复定义 |
| 连接反馈 | `App.vue` 的状态区域与持久错误；重试按钮忙碌时禁用 |

当前已实现项目/会话表单、地图与会话执行界面、草稿冲突和图片输入。选择器采用原生 select，接受系统弹层外观；地图浮层按规格为非模态。模态表单采用共享 AppDialog 组件，行为跟随规格。

### Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Scrollbar | apps/web/src/style.css | DESIGN.md 运行时映射 | 全局默认 / forced-colors 系统颜色 | tests/browser.spec.ts computed style 与窄窗口 |
| Form | apps/web/src/components/AppDialog.vue 与 Composer.vue | docs/mvp-spec.md §3/4/7 | 模态创建 / 会话输入 / 原 run 回复 | tests/browser.spec.ts |
| Select/Listbox | Conversation.vue / App.vue 的原生 select | docs/mvp-spec.md §5；DESIGN.md | native，接受系统弹层外观 | tests/browser.spec.ts；选择型提问待 M5 补测 |
| CRUD | App.vue 与 workspace.ts | docs/mvp-spec.md §3 | 添加项目后进入地图；创建 session 后进入会话；首版不提供删除 | tests/browser.spec.ts |


### 执行界面的新增语义 token

运行时仍由 `apps/web/src/style.css` 统一拥有：warning-bg `#FFF5DC`、warning-text `#775015`、error-text `#A12835`、success-text `#27724E`。警告用于暂停/恢复/草稿冲突，错误用于保留输入的失败；均辅以文字。通用控件圆角 `--radius: 6px`。地图轨道沿用原主色，技术标识采用等宽字体。

弹层由原生 dialog 提供模态焦点和 Esc，AppDialog 负责标题和关闭后焦点恢复；会话预览为非模态。按钮/字段/滚动条共享 style.css。状态反馈采用就地持久文本，不引入第二套 toast。消息与工具输出均按不可信纯文本呈现。草稿本地缓存是临时副本，只有修订保存确认后显示“草稿已保存”。

历史消息分叉复用 AppDialog；只在原生用户消息位置提供入口。弹层展示来源、继承边界、图片数量及当前代码语义；新会话将选中内容作为草稿，确认创建不等于发送。

### M3 地图与导航的共享归属

`ProjectMap.vue` 拥有全局和会话浮层的关系图、远端分支、预览与视口操作；`map-layout.ts` 根据真实来源边做确定性森林布局，不改写路径 ID。连线同时用文字和线型区分接续/分叉；`MapThumbnail.vue` 复用布局，高亮当前会话。原有配色仍由 style.css 唯一拥有。

全局与浮层按项目分别保存视口、选择和预览；Enter 立即预览，指针单击延后展开以保留双击目标。非模态地图位于缩略图下方，Esc 先关闭预览，再关闭地图并恢复焦点。窄窗口项目导航改为可展开入口；项目顺序与后台任务不变。窗口缩小仍保留坐标，通过定位按钮找回当前/选中会话。会话消息与地图节点分批显示，Conversation 保存每个会话的阅读位置。

### M4 设置表单的共享归属

`SettingsDialog.vue` 复用 AppDialog、全局字段/按钮/反馈样式和既有颜色，不引入新的视觉 token。全局模型、凭据、执行名额分别保存；更新一类配置不自动接受另一类草稿的外部修改。错误就地显示、重新读取保留输入以便对照；API key 默认遮罩，组件关闭后清除，不写前端持久存储。移除凭据展示对象和影响；有未保存输入时关闭须明确放弃。证据入口为 `tests/settings.spec.ts`。

工作区配置入口位于每个分支列，`ProjectSettingsDialog.vue` 显示实际 worktree 路径、原生信任判定与字段来源。默认模型、信任选择分别保存；修改一类不自动接受另一类的修订。`ModelPicker.vue` 复用原生 select 和共享请求客户端，按需查询原生目录，不自动替换当前选择。会话换模位于会话标题区，说明仅影响后续发送。未保存退出保护现在由 AppDialog 的 dirty 变体统一拥有，包含浏览器卸载提示和继续编辑焦点。视觉 token 保持原值；新增行为证据为 `tests/project-settings.spec.ts` 与 `tests/settings.spec.ts`。

`ConnectionSettings.vue` 是设置面板内的自定义连接表单，继续消费现有样式和 token。连接独立读取/保存，不接受其他配置文件的修订；读取失败可就地重试，冲突重新读取保留输入，退出保护由父 AppDialog 统一处理。连接切换前保存或明确放弃草稿；移除显示 provider、模型与内联认证影响。地址中私密部分不回显，已有高级参数保留。浏览器证据为 `tests/connections.spec.ts`。

`MemoryDialog.vue` 复用 AppDialog、原生 select、共享 resize-none 文本域和就地反馈。入口按分支工作区提供；初始化展示 track/ignore 与文件影响，默认 track，已有策略保留。列表按原生分类/状态展示，候选不等于确认规则；可按关键词/路径召回并查看来源、scope 与正文。纠正遇到冲突保留输入并要求对照已保存版本；未确认保存作为可见待办，重试沿用原意图，暂不重试须说明不会回滚文件。证据入口为 `tests/memory.spec.ts`。


会话中的原生扩展可见消息归入 `Conversation.vue` 的“运行通知”区域，消费现有 warning 与 message-text 样式，不增加 token 或 toast。通知绑定当前/最近运行的持久事件，结束与刷新后仍可查看；隐藏的 bootstrap 内容不展示。证据入口为 `tests/memory.spec.ts`。
