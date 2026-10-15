# ChatGPT 下一问队列 / ChatGPT Prompt Queue

一个轻量级 Chrome / Microsoft Edge 浏览器扩展：**ChatGPT 正在回复时，可以继续输入下一个问题并排队，上一条回答结束后自动发送下一条。**

A lightweight, local-only browser extension that queues prompts while ChatGPT is answering and automatically sends them one by one after the current response finishes.

> 独立开源项目，与 OpenAI 无官方关联。基于网页 DOM 状态运行，并非官方 ChatGPT API。

## 功能

- **原生输入框排队**：ChatGPT 正在生成时，输入下一条问题并按 `Enter` 入队；`Shift + Enter` 仍然换行。
- **自动连续发送**：检测到当前回答结束，等待约 1.3 秒后发送队首问题，重复直到队列清空；兼容输入文本后才出现的发送按钮。
- **悬浮队列**：默认收起，点击右下角小按钮展开；可添加、排序、删除或清空问题。
- **主题同步**：面板随 ChatGPT 网页内的浅色／深色主题切换，采用简洁的中性色界面。\n- **安全暂停**：支持手动暂停；页面刷新或切换对话后自动暂停，避免误发。
- **本地存储**：每个浏览器标签页独立，按对话 URL 在该标签页 `sessionStorage` 保存队列。
- **最小权限**：不需要 OpenAI API Key、后端服务器、Cookie 访问权限或额外浏览器扩展权限。

## 安装（开发者模式）

1. 在 GitHub 仓库点击 **Code → Download ZIP**，解压；或使用 `git clone`。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序（Load unpacked）**，选择包含 `manifest.json` 的仓库根目录。
5. 刷新 `https://chatgpt.com`，右下角将显示收起的「队列」按钮。

安装后不需要启动任何后台服务。更新本地代码时，在扩展管理页点击该扩展的**重新加载**按钮，**再刷新 ChatGPT 标签页**。如果队列显示「已暂停」，点击「继续自动发送」恢复。

## 使用示例

1. 正常发送问题 A，等待 ChatGPT 开始回答。
2. 在 ChatGPT 原输入框输入问题 B，按 `Enter`，B 会加入待发队列。
3. 继续输入问题 C 并按 `Enter`。
4. A 结束后自动发送 B；B 结束后自动发送 C。

也可以展开右下角的「队列」面板，点击 **加入队列**，或使用 `Ctrl / ⌘ + Enter`。

**默认行为**：面板始终从收起状态启动；首次安装自动发送开启。刷新或切换对话后会暂停，需要在面板中点击「继续」。

## 安全和限制

- **仅纯文本**：不自动发送附件、图片、录音或未发送的输入框草稿；若检测到附件，将阻止自动发送。
- **通过 DOM 推断状态**：依赖 ChatGPT 网页中“停止生成”和“发送”按钮等元素。支持 ProseMirror、Lexical 和常见 textarea 变体；网站继续改版后仍可能需要更新 `content.js` 的检测逻辑。
- **保守确认**：提交后要确认输入框清空或检测到开始生成；不确定时暂停，尽可能防止重复发送。
- **切换对话保护**：切换对话时队列分开保留并暂停；在当前浏览器标签页刷新后，队列可能恢复但不会未经确认自动继续。
- **浏览器限定**：不适用于 ChatGPT 原生桌面应用。无法保证所有 ChatGPT 界面/账户版本都兼容，请先用简单的两条问题测试。
- **隐私**：没有网络请求逻辑，不向第三方服务器发送提问内容。浏览器扩展仅注入 `chatgpt.com` / `chat.openai.com` 页面。`sessionStorage` 存储在该站点的浏览器上下文中，网站自身的脚本可能访问其内容，因此不要把排队功能当作隔离式秘密存储。

## 无法自动发送时

1. 若面板显示「已暂停」，点击「继续」。
2. 若提示「输入框有未发送的草稿」，先手动清空 ChatGPT 原生输入框。
3. 若提示「发送按钮不可用」，重新加载扩展并刷新 ChatGPT 页面。
4. 仍无法使用时，可复制面板中的状态文字并提交 [Issue](https://github.com/Getting05/chatgpt-prompt-queue/issues)，附上操作步骤和 ChatGPT 页面语言（不要提供聊天隐私内容）。

### v1.0.2 界面更新

- 默认收起，旧版本保存过展开状态也不影响；不占据主要聊天空间。
- 浅色／深色模式跟随 **ChatGPT 页面设置**，而不是仅跟随操作系统。
- 精简为中性色面板、单行状态和必要的队列操作。
- 新增收起状态、主题切换和原有自动发送流程的回归测试。

### v1.0.1 修复

- 允许发送按钮在队列消息**写入编辑器后**才出现（修复此前自动发送可能永久卡住的问题）。
- 扩大对 ChatGPT Lexical、ProseMirror 编辑器与发送按钮的识别范围，忽略隐藏的旧停止按钮。
- 增加动态发送按钮、异步启用和失败后保留队列的模拟回归测试。

## 项目结构

```text
chatgpt-prompt-queue/
├── manifest.json          # Manifest V3 配置
├── content.js             # DOM 检测、队列、自动发送、悬浮 UI
├── icons/                 # 扩展图标（16 / 32 / 48 / 128）
├── tests/                 # Playwright 模拟 ChatGPT 页面测试
├── .github/workflows/     # GitHub Actions 检查
├── requirements-dev.txt   # 开发测试依赖
├── .gitignore
├── LICENSE
└── README.md
```

## 本地测试

需要 Python、Node.js、Chromium（或者 Playwright 自带 Chromium）：

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
node --check content.js
python -m json.tool manifest.json > /dev/null
pytest -q tests/
```

如要使用系统 Chromium：`CHROMIUM_EXECUTABLE=/usr/bin/chromium pytest -q tests/`。

这些测试使用**模拟网页**，不代表已完成对 ChatGPT 正式站点的端到端兼容测试。

## 开源许可

MIT，见 [LICENSE](LICENSE)。
