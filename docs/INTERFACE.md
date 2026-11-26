# dsh-webpilot —— 内部契约（Lead 定稿，改动需 Lead 同意）

WebPilot = DSH 右侧栏里的「Agent 浏览器」。宿主半（Node）驱动一只共享 Chrome，
每个会话一个 tab；客户端半（Web UI）把那个 tab 投射成画面，并在画面上叠加
cyber-spider 风格的操作特效。代码基线是 `imroc/dsh-embedded-browser` v0.3.0
（MIT，见 LICENSE 与 docs/UPSTREAM-README.zh.md），我们做了重命名 + 特效层 + 视觉重写。

## 0. 文件所有权（并行开发，不要越界写别人的文件）

| 文件 | 归属 | 说明 |
|---|---|---|
| `lib/index.js`, `lib/browser.js`, `lib/tools.js`, `lib/define-tool.js`, `lib/lazy.js` | **host** | 宿主半：生命周期、CDP 动作、工具、特效事件发射 |
| `lib/client.js` | **ui** | 客户端半：右侧栏面板 body（画面、特效、HUD、接管横幅） |
| `lib/cdp.js`, `lib/screencast.js`, `lib/routes.js`, `lib/ws.js`, `lib/human.js` | Lead/共用 | 尽量不动；确需小改先告诉 Lead |
| `e2e/**`, `/root/workspace/.dsh-dev/**` | **e2e** | 开发实例与自动化验收 |
| `docs/`, `README.md`, `package.json`, `cordis.patch.yml`, `install.sh` | Lead | 契约、打包、安装 |

## 1. 坐标系统

- 页面视口由宿主配置 `viewport`（默认 `1440x900`）固定；CDP 输入与特效都用这个坐标系（CSS px，原点在页面左上）。
- 客户端 canvas 按 contain-fit 显示，四周留舞台留白（浅色主题下是 `#fbfcfe → #e2eaf3` 渐变，不是黑边）：`scale = min(cw/vw, ch/vh)`；`ox=(cw-vw*scale)/2`，`oy=(ch-vh*scale)/2`；页面坐标 → canvas 坐标：`(x*scale+ox, y*scale+oy)`。
- 画布 backing store 用 `window.devicePixelRatio`（DPR）放大后再 `ctx.setTransform(dpr,0,0,dpr,0,0)` 绘制。

### 1.1 页面身份（只影响浏览器上报的环境，不影响坐标）

| 配置 | 空值含义 | 作用 |
|---|---|---|
| `mode: auto` | — | 优先 Xvfb headed（`screen` 报真实 1440x900），失败退 `--headless=new`（报 800x600） |
| `languages` | 沿用宿主 | 非空时加 `--lang=<主语言>` 与 `--accept-lang=<全列表>`，`navigator.languages` 从 `en-US` 变 `zh-CN` |
| `timezone` | 沿用宿主 | 非空时注入 Chrome 进程 `TZ`，`Intl…timeZone` 从 `Etc/Unknown` 变 `Asia/Shanghai` |
| `extraArgs` | — | 追加启动参数；无 GPU 的 Xvfb 需要 `--enable-unsafe-swiftshader`（否则 `getContext('webgl')` 是 `null`） |

理由：登录型站点（知乎/微博等）会按「IP 时区 vs 浏览器时区」「语言」「屏幕尺寸」「WebGL 渲染器」打分。
出口 IP 在 UTC+8 而浏览器答 UTC+0 是最重的一条矛盾；这三项配置就是把这个矛盾抹平。改完属宿主侧，
需要重启 DSH 进程才生效。

## 2. 宿主 → 客户端（经 panel WebSocket）

保留基线全部消息：`hello`、`state`、`sessions`、`frame`（二进制 JPEG）、`stream`、`human-request`、`human-done`、`human-timeout`、`browser-stopped`。

**新增 `fx` 事件**（JSON text 帧，只发给发起该动作的会话的面板）：

```js
{ type: 'fx', kind: 'click',  x, y, box: {x,y,w,h}?, label?: string, tool: string }
{ type: 'fx', kind: 'drag',   from: {x,y}, to: {x,y}, durationMs: number, label?: string, tool }
{ type: 'fx', kind: 'type',   x, y, box?, text: string, tool }
{ type: 'fx', kind: 'read',   boxes: [{x,y,w,h,kind:'text'|'element'}], title?, url?, tool }
{ type: 'fx', kind: 'scroll', direction: 'down'|'up'|'left'|'right'|'top'|'bottom', dy?: number, tool }
{ type: 'fx', kind: 'nav',    url, phase: 'start'|'done', tool }
{ type: 'fx', kind: 'key',    key, tool }
{ type: 'fx', kind: 'idle' }            // 一轮动作结束，特效收尾
```

语义：
- **动作前**发（click/drag/type/nav start/key/scroll），客户端先播 200–400ms 动画，宿主再真正派发 CDP 动作 —— 由宿主 `effectLeadMs`（默认 260ms）控制节奏，让用户看得见。
- `drag` 由 `webpilot_drag` 在**真实按下之前**发出：客户端先把光标飞到 `from`，再让轨迹在 `durationMs`（与真实拖拽同长）内长到 `to`，落点画 `DROP` 括号 + 涟漪；拖拽进行中蜘蛛光标压在轨迹头部。`prefers-reduced-motion` 下退化为一条静止虚线 + 淡入淡出。
- `read` 在 snapshot 读完时发，`boxes` 是这次「读」覆盖的区域（正文段落/元素框），客户端画扫描线 + 括号高亮。
- 客户端要容错：未知 kind 忽略；`box` 缺失时用 `x,y` 画点特效；`drag` 缺 `from`/`to` 时整条忽略。
- `idle` 可省略。

宿主实现建议：`BrowserManager` 构造收 `onFx(sessionId, payload)`，内部 `this.fx(sessionId, {...})`；
`index.js` 把它接到 `hub.broadcast({ ...payload, sessionId }, sessionId)`；`hub.broadcast` 已按会话过滤。

## 3. 客户端 → 宿主

不变：`{type:'focus'|'blur'|'play'|'human-done'|'human-reply'|'open'|'close'|'nav'|'input', ...}`。

`nav` 有三种动作，面板只会发前两种的后三个按钮：

```js
{ type: 'nav', action: 'back' | 'forward' | 'reload' }        // 工具栏按钮
{ type: 'nav', action: 'goto', url: 'example.com' }          // 人在地址栏回车
```

`goto` 的地址规范化在宿主（`lib/browser.js` 的 `normalizeAddress`）唯一实现：

| 输入 | 结果 |
| --- | --- |
| `https://a.com/x`、`http://a.com` | 原样 |
| `example.com`、`example.com/a`、`example.com:8443` | 补 `https://` |
| `localhost:3000`、`127.0.0.1:8080`、`[::1]` | 补 `http://` |
| `about:blank` | 放行 |
| `hello`（裸词）、含空白、`javascript:…` 等其它 scheme | 拒绝（不发导航，面板保持原 URL） |

拒绝是**静默**的：宿主只在规范化成功时 `navigate`，随后照常 `pushState`，所以面板自己会把地址栏还原成页面的真实 URL——客户端不做第二套校验。

## 4. 视觉规范（浅色 console 风）

面板配色跟随 Web GUI 的浅色主色调（2026-11-18 由深色改成浅色，结构与动效不变）：

```
--bg:#f3f6fa    --bg-2:#ffffff  --panel:#ffffff  --panel2:#f7f9fc
--line:rgba(20,50,80,.12)       --line-soft:rgba(20,50,80,.06)
--cyan:#0a7c93  --mint:#0d8a5f  --violet:#6a4fd0  --amber:#a2680f  --red:#cf3450
--text:#1b2b3b  --dim:#5c7186   --faint:#94a7b8
等宽字体：ui-monospace,"SF Mono","JetBrains Mono",Consolas,monospace
```

取色原则：底色用白/浅灰（`#fff` → `#f3f6fa`），线条用低透明度蓝灰（5–12%），
强调色用**加深版**原色（青 `#0a7c93`、薄荷 `#0d8a5f`、紫 `#6a4fd0`、琥珀 `#a2680f`、红 `#cf3450`），
因为亮底上霓虹原色对比度不足；overlay canvas 的胶囊/文字底色也随之从深色换成半透明白，
`fx` 的反衬描边由黑改为白（详见 `lib/client.js` 顶部 `PALETTE` 与三处 halo 注释）。

视觉要素（全部画在面板自己的 DOM/CSS 与 overlay canvas 上，**绝不注入被访问页面**）：

1. 面板外框：白玻璃 + 细网格 + 顶部扫描线；URL 栏像终端路径；左侧「WP」标记。
2. 顶部状态条：`● LIVE` / `SPIDER-IDLE` / `HUMAN-TAKEOVER` / 帧率 + viewport 尺寸 + host。
3. 蜘蛛机器人光标（8 腿小图标，贝塞尔飞行到目标准星），click 时腿张开 + 涟漪；腿和身体是深青线框 + 白色描边（亮底可读）。
4. 阅读特效：`read` 事件 → 对每个 box 画青色括号（四角）+ 竖向扫描线扫过 + 少量数据粒子；HUD 打一行 `READ ▸ <title> · <n> blocks`。
5. 操作日志 HUD（左下，最多 6 行，等宽、带时间戳、颜色按 kind；每行一块半透明白底，压在任何页面内容上都可读）。
6. 人机接管：琥珀色横幅 + 呼吸边（保留基线语义：点名请求者的会话）。
7. 空闲态：中央 `WEBPILOT STANDBY` + 「打开浏览器」按钮（沿用基线 open 流程）。
8. 尊重 `prefers-reduced-motion`：动效降级为淡入。

## 5. 验收标准

- host：`node e2e/backend-smoke.mjs` 能真起 Chrome、navigate example.com、snapshot 返回带 `box` 的元素、click 触发 fx、进度日志清楚；不依赖 DSH。
- ui：`e2e/harness.html` 能独立加载特效层（喂合成 fx 事件 + 一张截图），键盘/鼠标回灌仍走基线协议。
- e2e：在 `/root/workspace/.dsh-dev`（DSH_HOME）起 `--port 3090` 实例，Playwright 打开 GUI → 触发面板 → 截图断言（画面非空白、fx 层存在、HUD 有行、无 console error）。
- 语言：界面文案中文为主 + 少量英文技术词（LIVE / READ / TAKEOVER），HUD 用英文大写短词。

## 6. 禁止

- 不改 `/root/.dsh`、不 restart 线上 DSH（Lead 最后统一处理）。
- 不 import `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`（link 插件解析不到）；工具定义用 `lib/define-tool.js` 本地 shim。
- 不在自身代码里开 `Runtime.evaluate` 的对外通道（安全模型同基线）。
- 特效不注入目标页面；不引入新的 npm 依赖（ws 用基线自带实现）。
