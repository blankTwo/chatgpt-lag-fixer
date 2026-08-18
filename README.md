# ChatGPT 卡顿修复

一个 Chrome（MV3）扩展，用于解决 ChatGPT 长对话中的卡顿和冻结。它拦截 ChatGPT
网页应用拉取的对话数据，只在渲染树中保留最近的若干轮次，把更早的消息从数据里
丢弃，从而减少页面需要渲染的 DOM。

**纯静态实现**：不用任何打包器（放弃了早期的 Vite + crxjs 方案），`extension/`
目录可直接被 Chrome 加载。这样做是必需的——crxjs 会把 MAIN world 脚本包装成
`await import("chrome-extension://…")` 的动态导入，而 chatgpt.com 的严格 CSP 会拦掉
它，导致 fetch hook 根本装不上。改用原生的同步 IIFE 注入后彻底规避了这个问题。

完全本地运行。无账号、无 license 校验、无遥测、不向任何第三方发起网络请求。仅申请
`storage` 权限以及对 ChatGPT 源的访问权限。

## 加载扩展

```bash
npm install
npm run build     # 生成图标 + 同步 loader + 编译 wasm + 校验引用完整性
```

打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择
`extension/` 目录。

## 工作原理

- `extension/page-inject.js`（**isolated world**，document_start）：把 wasm URL 写到
  `<html>` 的 dataset 上，并把设置从 `chrome.storage.local` 镜像进页面 localStorage，
  供 MAIN world 同步读取；同时把状态转发回 storage 供 popup 使用。
- `extension/main-world.js`（**MAIN world**，document_start，纯 IIFE 无 import）：
  **同步**挂钩 `window.fetch`（抢在首屏拉对话之前），再异步加载 wasm。当 ChatGPT
  加载对话时，把 JSON 交给 wasm 裁剪核心，只保留最近 N 个可见轮次并重建响应。
- `extension/vendor/as-loader.js`：`@assemblyscript/loader` 的 UMD 版，作为普通脚本
  在 main-world.js 之前注入（挂到 `window.loader`），负责 wasm 字符串封送。
- `extension/trimmer.wasm`：由 `src/wasm/assembly/index.ts` 编译的 AssemblyScript
  裁剪核心。**保证裁剪后不产生悬空引用**：每个保留节点的 `children` 都过滤为已保留
  节点，父节点被裁掉的节点会重新挂到树根。
- `extension/ui.js`（isolated，document_idle）：有轮次被隐藏时显示"加载更早的消息"
  控件，其状态按**会话 id**（`/c/<id>`）记录，刷新时 query/hash 漂移不会丢失。
- `extension/popup/`：开关裁剪、设置保留轮数、显示实时状态。
- `extension/background.js`：安装时写入默认设置。

## 已知局限（重要）

诊断显示**当前的 ChatGPT 网页版很可能已自带 DOM 虚拟化**（长对话里 DOM 稳定维持在
约十几个 turn、几千个元素，滚动也不增长）。在这种情况下，"减少渲染的消息数量"这个
思路对卡顿的改善可能有限——卡顿更可能来自单条消息中的重型内容（超大代码块、长表格、
大量 KaTeX 公式）。本扩展修复了注入链路，能真正把 fetch hook 装上，但是否能改善某个
具体对话的卡顿，需要在真机上用 `tools/diagnose*.js` 进一步确认。

## 开发

```bash
npm test          # 编译 wasm 并运行裁剪正确性 + 端到端 loader 测试
npm run verify    # 校验 extension/ 内 manifest 引用的文件是否齐全
```

## 项目结构

```
extension/                可直接加载的 MV3 扩展（构建产物 + 静态源）
  manifest.json
  page-inject.js          isolated：wasm URL + 设置镜像 + 状态转发
  main-world.js           MAIN：同步 fetch hook + 裁剪
  vendor/as-loader.js     @assemblyscript/loader UMD（构建时同步）
  trimmer.wasm            裁剪核心（构建时编译）
  ui.js                   加载更早控件
  popup/                  弹窗界面
  background.js           安装时写默认设置
  icons/                  图标（构建时生成）
src/wasm/assembly/index.ts  AssemblyScript 裁剪核心源码
scripts/                    gen-icons / sync-loader / verify-extension
test/                       trim.test.mjs（核心）+ e2e.test.mjs（端到端）
tools/diagnose*.js          真机诊断探针
```
