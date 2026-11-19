# 调研：右侧栏 Agent 浏览器，GitHub 上已经有什么

调研时间 2026-11-18。结论先行：**这个需求在 DSH 生态里已经有人实现过**，所以 WebPilot 不是从零造，
而是挑一个已解决硬问题的实现做 vendored fork（MIT），把力气花在它没做的部分——视觉与特效。

## 1. 已有的同类实现

| 项目 | 许可证 | 它已经解决 | 它没做 |
|---|---|---|---|
| [imroc/dsh-embedded-browser](https://github.com/imroc/dsh-embedded-browser)（v0.3.0，原名 dsh-browser-panel） | MIT | 每会话一个 tab、共享持久 profile（登录一次到处可用）、10 个 `browser_embedded_*` 工具、`ask_human` 阻塞等人（扫码/2FA/CAPTCHA 的落点）、CDP screencast→canvas、输入回灌、后台 tab 用截图轮询兜底 | 视觉朴素、没有操作特效 |
| [chendefine/dsh-sidebar-cdp-browser](https://github.com/chendefine/dsh-sidebar-cdp-browser)（npm 0.1.2） | MIT | 投射层工程最完整：单 CDP 连接、帧背压（512KB 软限丢帧/4MB 硬限断流）、一次性 ticket、输入白名单、IME | 没有持久 profile/登录态、**没有任何模型工具**、无特效 |
| [runzhliu/deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) 的 `dsh-browser-desktop` | MIT | Xvfb + x11vnc + websockify + noVNC，用官方 playwright-mcp provider `mode: attach` 接同一 Chromium | 传整个桌面像素、noVNC 无鉴权、部署重 |

DSH 本体相关的底座：
- `@deepseek-ai/dsh-client-ui-sidebar-right`：右侧栏的 tab 类型注册表（`sidebarRightTabs.register` + `sidebar.right.pane.tab` 槽位）——三个实现都挂在这上面。
- `@deepseek-ai/dsh-client-ui-sidebar-browser`：内置 iframe 浏览器 tab，**不暴露模型工具**，跨域读不到 DOM，不能作为 agent 的操作面。
- `@deepseek-ai/dsh-browser-use` / `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`：官方 browser provider（attach 到已有 Chromium）。

## 2. 为什么不用 iframe

实测 `github.com/login` 返回 `x-frame-options: deny`，`figma.com/login` 返回 `SAMEORIGIN`；
主流站点普遍用 XFO/CSP `frame-ancestors` 拒绝被嵌。即使放行，跨域也读不到 DOM、特效无处可画。
所以投射必须走 **CDP screencast → canvas**。

## 3. 关键技术取舍（实测/前车之鉴）

- **Chrome 只为当前活动 tab 推 screencast**：多会话必须让非活动 tab 走 `Page.captureScreenshot` 轮询（约 7fps 兜底）。
- **每个 target 创建时必须激活一次**，否则之后注入的输入事件会被静默丢弃（一次激活永久生效）。
- **ack 是硬流控**：不 ack 4 秒只出 3 帧；静止页面首帧后完全静默，所以面板重连/换尺寸时要主动补种一帧。
- **背压优于追帧**：上屏后再 ack（28fps、零丢帧、CPU 更低）好过立即 ack（75–86% 废帧）。
- **Chrome 153 的 headless UA 仍带 `HeadlessChrome`**，需要显式覆盖 UA + `--disable-blink-features=AutomationControlled`；
  交互式 Turnstile 在 canvas 上由人点击可以通过，但静默 managed 挑战（如 zh.minecraft.wiki）是硬阻断。
- **登录态靠持久 `--user-data-dir`**，不要搬 `storageState`：设备绑定凭据、指纹、WebAuthn 搬不过去；扫码登录本质就是「人看着画面自己点」。
- **特效画在前端 overlay canvas**，不注入被访问页面：不污染站点、不受 CSP 限制、导航不丢，还能跨域工作。

## 4. 参考的工具 schema 来源

- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)：`target` ref + `element` 描述分离、`snapshot{boxes}` 给元素框。
- [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)：`uid` 来自 a11y 快照、`includeSnapshot` 顺带回传新状态。
- [browser-use/browser-use](https://github.com/browser-use/browser-use)：`highlight_actions` 的「操作目标外框高亮 1 秒」是特效层的直接先例。

## 5. 本项目的定位

WebPilot = `dsh-embedded-browser` 已被验证的**能力闭环**（持久 profile + 每会话 tab + 10 工具 + ask_human）
\+ `dsh-sidebar-cdp-browser` 的**投射工程质量**（背压/丢帧/ticket/输入白名单思想）
\+ **cyber-spider 视觉与操作特效层**（本项目原创）。
