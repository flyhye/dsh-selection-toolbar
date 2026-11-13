# dsh-selection-toolbar

DeepSeek Harness 客户端插件：对话中划词后浮出小工具条，可「添加到对话」——以编号引用芯片（`#1`、`#2`…）插入输入框，发送时自动展开为 `[#编号] (第 N 轮) 原文`；或「侧边讨论」——分叉出当前会话，在右侧栏开一个独立对话。

A floating text-selection toolbar for the DeepSeek Harness Web UI: quote a transcript selection into the composer as a numbered reference chip that expands on send, or fork the Session into a side conversation in the right sidebar.

## 功能

- **划词浮条**：跟随选区定位，上方空间不足自动翻转到下方，不遮挡内容
- **添加到对话**：插入编号引用芯片，输入框只显示 `#N 摘要…`，保持简短
- **发送展开**：模型收到 `[#N] (第 T 轮) 原文`，既知道编号，也知道这段话出自哪一轮
- **原文溯源**：引用携带轮次标记，模型可定位「第 3 轮说的那句」；跨轮次的选区不带标记，避免误标
- **侧边讨论**：分叉当前会话（带历史）到右侧栏，主对话不受打扰；同一个分叉重复打开复用同一标签页
- **超长保护**：单条引用超过 1500 字自动截断并提示，截断在写入前完成，不会静默丢内容
- **编号复用**：同一段文字重复引用复用同一编号；插入失败自动回滚编号，不产生跳号
- **中英双语**：文案跟随界面语言；样式全部使用宿主主题 token，明暗主题自适应

## 安装

从 GitHub 安装（推荐）：

```sh
dsh plugin --profile <profile> add github:flyhye/dsh-selection-toolbar
```

例如 Web 端：`dsh plugin --profile web add github:flyhye/dsh-selection-toolbar`。

也可以从本地目录安装（适合开发调试）：将本仓库目录传给插件管理器（Desktop 在插件页面选择本地目录；CLI 用 `dsh plugin --profile <profile> add <目录路径>`——`plugin` 子命令把参数原样转发给 pnpm，动词是 `add`）。

本地目录安装以目录链接（junction）形式落地，此后修改仓库内文件即对插件生效；重新安装仅在 `package.json` 变更（如版本号、`dsh.client.inject`）时需要。

## 使用限制

- 轻量版设计：引用原文随消息一起发送，长文会整段进入模型上下文
- 单条引用上限 1500 字，超出部分截断并以 `…[+N]` 标出；截断会即时提示
- 溯源标记取自宿主聊天行的 `data-chat-turn`；选区跨越多个轮次时不做标注
- 侧边对话需要会话已有已完成的回合（宿主限制）；首个回复尚未结束时会提示稍后再试
- 分叉出的会话与宿主原生分支一样保留在会话列表中
- 编号计数与复用映射存于浏览器 `localStorage`：更换浏览器或清除站点数据后编号从 1 重新开始，同一会话可能出现重复编号（不影响功能）
- 引用芯片的外观由宿主编辑器渲染，本插件不改变其样式

## 兼容性

面向 DeepSeek Harness `0.2.x` 的 Web 与桌面客户端。插件使用了以下内部扩展点，宿主升级后可能需要适配：

- `shell.overlay` 槽位
- `ctx.inputTriggers.registerSource`（引用序列化 codec）
- `slash/input-insert-reference` 作用域事件
- `conversation.input` 每会话输入 facade
- `data-conversation-*` 与 `data-chat-turn` DOM 标记（选区归属与轮次溯源判定）
- `ctx.sessions.fork` / `ctx.uiConversation`（侧边对话分叉与轮次定位）
- `ctx.resources` 资源协议注册 + `ctx.sidebarRightTabs` 右侧栏标签页类型
- `ctx.sidebarRight.openResource` / `openTabs`（打开与验证侧栏标签）
- `ctx.slots` 的 `spec` / `subscribe`（子槽位等待注册）

## License

[MIT](./LICENSE)
