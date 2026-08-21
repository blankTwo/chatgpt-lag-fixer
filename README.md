# ChatGPT 长对话优化

![ChatGPT 长对话优化](./ChatGPTImage.png)

一个面向 ChatGPT Web 的 Chrome MV3 扩展，通过在历史会话数据进入 React 渲染层之前裁剪旧消息，降低长对话页面的 DOM、内存与渲染负载。

## 功能

- **历史会话裁剪**：只保留最近 N 个可见轮次。
- **WASM 裁剪核心**：使用 AssemblyScript 编译的 WebAssembly 处理会话树。
- **兼容新旧会话接口**：支持 `conversation/<id>` 的 mapping 结构和 `conversations/<id>` 的 `messages[]` 结构。
- **加载更早**：需要查看旧内容时，可以临时扩大窗口重新加载。
- **运行期安全收窗**：继续聊天时允许少量缓冲，稳定后安全刷新回设定窗口。
- **不直接删除 React DOM**：避免破坏 React Fiber 与真实 DOM 的一致性。
- **调试日志**：可在 Popup 中开启，查看裁剪结果和运行状态。

示例：设置保留最近 4 个可见轮次时，长会话可以从：

```text
119 个可见轮次 → 4 个可见轮次
185 条 messages → 5 条 messages
```

实际数量会随会话中的 system、tool、hidden message 等结构而变化。

## 安装

### 方式一：本地构建

```bash
git clone git@github.com:blankTwo/chatgpt-lag-fixer.git
cd chatgpt-lag-fixer
npm install
npm run build
```

然后打开 Chrome：

1. 访问 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目中的 `extension/` 目录

### 方式二：直接加载已有构建产物

如果仓库中已经包含完整的 `extension/` 构建文件，可直接在 `chrome://extensions` 中加载该目录。

## 使用

点击浏览器工具栏中的扩展图标：

- **启用裁剪**：开启或关闭长对话优化。
- **保留最近轮数**：设置页面保留的最近可见轮次数量，默认 15，最低 4。
- **调试日志**：开启后可在 ChatGPT 页面 DevTools Console 中查看 `[CLF]` 日志。

修改设置后按 Popup 中的「刷新页面」使当前会话重新按新窗口加载。

## 工作原理

```text
ChatGPT 历史会话请求
        ↓
MAIN world fetch hook
        ↓
识别当前会话响应结构
        ↓
旧接口 mapping ─────────────┐
                            ├→ WASM 裁剪最近 N 个可见轮次
新接口 messages[] → 临时树 ┘
        ↓
映射回原始响应结构
        ↓
React 只接收到裁剪后的历史数据
```

### 新版接口

当前 ChatGPT 历史会话主要通过：

```text
GET /backend-api/conversations/<id>?include_has_versions=true&num_turns=...
```

返回扁平的 `messages[]` 和 `current_node`。扩展会优先使用消息自身的 parent/children 信息构造临时树；如果缺少树关系，则退化为顺序链，再交给同一套 WASM 裁剪核心。

裁剪成功后会阻止 ChatGPT 自己通过 `page_info.has_previous_page` 自动把旧历史重新加载回来；更早的历史由扩展自己的「加载更早」入口控制。

### 旧版接口

旧的：

```text
GET /backend-api/conversation/<id>
```

返回 `mapping + current_node`，可直接交给 WASM 裁剪。

### 可见轮次

WASM 只把以下消息计入窗口预算：

- `user`
- `assistant`
- 未标记 `is_visually_hidden_from_conversation`

system、tool、隐藏消息仍可作为结构节点保留，但不占用可见轮次数量。

## 运行期策略

首屏历史完全依赖数据层裁剪，不修改 ChatGPT 已经渲染出来的历史 DOM。

继续聊天后：

```text
keepTurns + 5 个 turn 临时缓冲
        ↓
等待 streaming 结束
        ↓
等待 DOM 稳定
        ↓
确认输入框没有未发送草稿
        ↓
安全刷新
        ↓
重新按 keepTurns 裁剪历史
```

没有 iframe 休眠、`content-visibility`、DOM detach/remove 等实验性渲染优化。

## 权限

扩展使用：

- `storage`：保存启用状态、保留轮数和调试设置。
- `activeTab`：从 Popup 刷新当前页面。
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## License

MIT
