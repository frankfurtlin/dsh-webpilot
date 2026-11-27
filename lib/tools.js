/**
 * The model-facing tool set.
 *
 * Every tool works on **the calling session's own tab**: the handler reads the
 * session id off its execution context, so the model never has to know that
 * sessions exist, and two sessions can never steer each other's page. They do
 * share the Chrome profile — and therefore the login state — on purpose.
 *
 * Every action is mirrored to the person in front of the DSH Web UI. The
 * plugin's right-sidebar panel plays a matching effect — the spider cursor
 * flying to a target, a click ripple, typing, a page read, a scroll sweep, a
 * navigation glitch — before the real CDP command is sent, so the human can
 * follow the agent live and take the tab over when it hits something only a
 * human can do. Effects are cosmetic: they never change what the page does.
 *
 * Names are prefixed `webpilot_` so they cannot collide with another browser
 * suite a deployment may install (e.g. a `browser_*` set driving the user's own
 * browser); a duplicate tool name aborts plugin load. The prefix is also what
 * the `browser-use` skill routes on, so keep the two in step.
 *
 * Registration is lazy (see `./lazy.js`): nothing here is published until the
 * `browser-use` skill has been invoked, so this module *builds* the suite and
 * the caller decides when it goes live.
 *
 * @module dsh-webpilot/tools
 */

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from './define-tool.js'

/** Canonical values must be lossless JSON: drop `undefined` and functions. */
const clean = (value) => JSON.parse(JSON.stringify(value ?? null))

/** Render one canonical value as a single text block. */
const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, undefined, 1) }]

/** Unconstrained JSON output plus the plugin's own text projection. */
const jsonOutput = () => ({ schema: { type: 'json' }, render: (_args, value) => asText(value) })

/**
 * The session a tool call belongs to.
 *
 * `exec.agent` is absent on agentless dispatches (service-internal, UI, command
 * paths), and a browser without an owner would be shared state again — so that
 * case is an error rather than a silent fallback.
 */
function sessionOf(exec) {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('webpilot_* tools require a calling agent session; this call has no owning session')
  }
  return sessionId
}

/** 元素清单里链接的展示形式：太长就截断，路径足够判断是哪条链接。 */
function shortenHref(href) {
  const text = String(href)
  return text.length > 110 ? `${text.slice(0, 107)}…` : text
}

/** Human-readable snapshot: header, numbered inventory, then page text. */
function formatSnapshot(value) {
  const lines = []
  if (value.title !== undefined || value.url !== undefined) lines.push(`${value.title ?? ''}`.trim(), `${value.url ?? ''}`.trim(), '')
  if (Array.isArray(value.elements) && value.elements.length > 0) {
    // 窗口 != 全页：`total` 是整页编号后的总数，模型看不到它就以为「80 个就是全部」。
    const total = Number.isFinite(value.total) ? value.total : value.elements.length
    const offset = Number.isFinite(value.offset) ? Math.max(0, value.offset) : 0
    const shown = value.elements.length
    const more = Math.max(0, total - offset - shown)
    const windowInfo =
      total > shown
        ? `窗口 ${offset + 1}-${offset + shown} / 共 ${total} 个${more > 0 ? `，还有 ${more} 个未列出（webpilot_snapshot offset=${offset + shown} 看下一页）` : ''}`
        : `共 ${total} 个`
    lines.push(`可交互元素 (${shown} 个，${windowInfo}):`)
    for (const element of value.elements) {
      const bits = [`[${element.index}]`, `<${element.tag}>`]
      if (element.type !== undefined) bits.push(`type=${element.type}`)
      if (element.label !== undefined && element.label !== '') bits.push(`"${element.label}"`)
      if (element.href !== undefined && element.href !== '') bits.push(`→ ${shortenHref(element.href)}`)
      if (element.value !== undefined && element.value !== '') bits.push(`值="${element.value}"`)
      if (element.disabled === true) bits.push('(disabled)')
      lines.push(`  ${bits.join(' ')}`)
    }
    lines.push('')
  }
  if (typeof value.text === 'string' && value.text !== '') {
    const textTotal = Number.isFinite(value.textTotal) ? value.textTotal : value.text.length
    if (textTotal > value.text.length) {
      lines.push(`页面正文（已截断：全文 ${textTotal} 字，这里 ${value.text.length} 字）:`, value.text)
    } else {
      lines.push('页面正文:', value.text)
    }
  }
  return lines.join('\n')
}

/**
 * Build every tool this plugin registers.
 *
 * @param deps - browser manager, human broker, screencast hub, config, and the
 *   optional attachment service used to hand screenshots back to the model.
 * @returns tool definitions to register inside one effect.
 */
export function defineTools({ manager, human, hub, config, getAttachments, logger, getPanelAvailable = () => true }) {
  const screenshotRefs = new Map()
  let screenshotSequence = 0
  const askHumanTimeoutMs = Math.max(10_000, (config.askHumanTimeoutSeconds ?? 600) * 1000)

  const status = defineTool({
    name: 'webpilot_status',
    description:
      "Report this session's WebPilot tab as the side panel shows it: whether the embedded browser is running, this tab's URL and title, the persistent profile directory, and whether the human has a pending handover. Call this first when unsure about the browser state.",
    parameters: {},
    output: jsonOutput(),
    execute: async (_args, exec) => clean(await manager.status(sessionOf(exec))),
  })

  const navigate = defineTool({
    name: 'webpilot_navigate',
    description:
      "Open a URL in this session's WebPilot tab (starting the embedded browser if needed). Each session gets its own tab, and the human watches it in the DSH Web UI's right sidebar — the panel opens by itself once this session has a browser, and plays a navigation effect before the page loads. All sessions share one login profile, so a login done once works everywhere.",
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      newTab: { type: 'boolean', description: "Discard this session's current page and open the URL in a fresh tab." },
    },
    output: jsonOutput(),
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      const url = String(args.url)
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      return clean(
        args.newTab === true
          ? await manager.replaceTab(sessionId, url)
          : await manager.navigate(sessionId, url),
      )
    },
  })

  const snapshot = defineTool({
    name: 'webpilot_snapshot',
    description:
      "Read this session's WebPilot page as structured text: title, URL, a numbered inventory of clickable/typable elements, and the visible text. Reading also lights up the page regions the human sees in the side panel. Pass an element number to webpilot_click or webpilot_type.",
    parameters: {
      maxChars: { type: 'number', description: 'Truncate the page text at this many characters.' },
      maxElements: { type: 'number', description: 'How many elements to list in this view (default 80, max 800). The page is always indexed in full, so a higher offset still reaches the rest.' },
      offset: { type: 'number', description: 'Skip this many elements — use it to page through a long form instead of getting stuck at the first 80.' },
      includeClickables: { type: 'boolean', description: 'Also index role-less clickable divs (cursor:pointer). Needed for portal dropdowns and custom menus.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(formatSnapshot(value)),
    },
    execute: async (args, exec) =>
      clean(
        await manager.snapshot(sessionOf(exec), {
          maxChars: args.maxChars,
          maxElements: args.maxElements,
          offset: args.offset,
          includeClickables: args.includeClickables === true,
        }),
      ),
  })

  const click = defineTool({
    name: 'webpilot_click',
    description:
      "Click something in this session's WebPilot page: either an element number from webpilot_snapshot, or a visible text label to match. Real input events are dispatched, so hover/focus behaviour matches a human click; the side panel shows the cursor flying to the target before the click lands. It refuses a target that is covered, disabled or scrolled out of view (the error names the blocker), and returns {changed, navigated, mutations} measured on the page's own MutationObserver — a dead click is visible immediately instead of on the next snapshot.",
    parameters: {
      index: { type: 'number', description: 'Element number from the latest webpilot_snapshot.' },
      text: { type: 'string', description: 'Visible label of the element to click (exact match first, then substring). Searched across the whole page, not just the returned window.' },
      x: { type: 'number', description: 'Page x coordinate — fallback when the target has no usable DOM node (e.g. something only visible in a screenshot).' },
      y: { type: 'number', description: 'Page y coordinate, used together with x.' },
    },
    output: jsonOutput(),
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      if (typeof args.index === 'number') return clean(await manager.click(sessionId, args.index))
      if (typeof args.text === 'string' && args.text !== '') return clean(await manager.clickText(sessionId, args.text))
      if (typeof args.x === 'number' && typeof args.y === 'number') return clean(await manager.clickAt(sessionId, args.x, args.y))
      throw new Error('provide index, text, or x+y')
    },
  })

  const drag = defineTool({
    name: 'webpilot_drag',
    description:
      "Press, move and release in this session's WebPilot page — a real drag. Use it for slider CAPTCHAs (Alibaba/Tencent/Meituan style), range inputs, carousels and drag-to-sort lists, where a click cannot work. Give either page coordinates (x1,y1 → x2,y2, e.g. read off a screenshot) or an element index plus dx/dy to drag from that element's centre. The side panel shows the cursor land on the start point and settle on the end point. The result reports {changed, navigated} measured on the page, so a drag that moved nothing says so.",
    parameters: {
      x1: { type: 'number', description: 'Start x in page pixels (with y1).' },
      y1: { type: 'number', description: 'Start y in page pixels.' },
      x2: { type: 'number', description: 'End x in page pixels (with y2).' },
      y2: { type: 'number', description: 'End y in page pixels.' },
      index: { type: 'number', description: "Element number from webpilot_snapshot: drag starts at that element's centre, offset by dx/dy." },
      dx: { type: 'number', description: 'Horizontal distance to drag when using index (e.g. 280 to push a slider right).' },
      dy: { type: 'number', description: 'Vertical distance to drag when using index.' },
      steps: { type: 'number', description: 'Intermediate mouse moves (default 12, 2–60). More steps look more human.' },
      durationMs: { type: 'number', description: 'Total drag duration in ms (default 420).' },
    },
    output: jsonOutput(),
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      let from
      let to
      if (typeof args.index === 'number') {
        const located = await manager.locate(sessionId, args.index)
        from = { x: located.x, y: located.y }
        to = { x: Math.round(located.x + Number(args.dx ?? 0)), y: Math.round(located.y + Number(args.dy ?? 0)) }
      } else if ([args.x1, args.y1, args.x2, args.y2].every((value) => typeof value === 'number')) {
        from = { x: args.x1, y: args.y1 }
        to = { x: args.x2, y: args.y2 }
      } else {
        throw new Error('webpilot_drag needs x1,y1,x2,y2 (page coordinates) or index plus dx,dy')
      }
      return clean(await manager.drag(sessionId, from, to, { steps: args.steps, durationMs: args.durationMs }))
    },
  })

  const wait = defineTool({
    name: 'webpilot_wait',
    description:
      "Wait until a condition holds in this session's WebPilot page, then return what matched — the replacement for guessing `sleep` after an action. Wait for a CSS selector to appear, or for visible text, or (gone=true) for either to disappear. Polls every 200ms, default budget 10s, hard cap 120s; a timeout returns matched:false instead of throwing.",
    parameters: {
      selector: { type: 'string', description: 'CSS selector to wait for (visible element).' },
      text: { type: 'string', description: 'Visible text to wait for; returns the deepest element carrying it.' },
      gone: { type: 'boolean', description: 'Invert the condition: wait until it disappears.' },
      timeoutMs: { type: 'number', description: 'Max wait in ms (default 10000, cap 120000).' },
    },
    output: jsonOutput(),
    execute: async (args, exec) =>
      clean(
        await manager.waitFor(sessionOf(exec), {
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          gone: args.gone === true,
          timeoutMs: args.timeoutMs,
        }),
      ),
  })

  const type = defineTool({
    name: 'webpilot_type',
    description:
      "Focus a field by its element number and insert text into this session's WebPilot page (works with React/Vue controlled inputs; the result carries `value`, the field's content after typing, so a controlled input that silently rejected the text is visible.). Set submit=true to press Enter afterwards, e.g. to submit a login form. The click it performs is required: without a focused field the browser silently drops inserted text. The side panel animates both the click and the typing.",
    parameters: {
      index: { type: 'number', required: true, description: 'Field element number from the latest snapshot.' },
      text: { type: 'string', required: true, description: 'Text to insert.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      replace: { type: 'boolean', description: 'Clear the field first (select-all + delete), so the text replaces the old value instead of being appended. Use this whenever the field already has content.' },
    },
    output: jsonOutput(),
    execute: async (args, exec) =>
      clean(
        await manager.type(sessionOf(exec), args.index, String(args.text), {
          submit: args.submit === true,
          replace: args.replace === true,
        }),
      ),
  })

  const evaluate = defineTool({
    name: 'webpilot_eval',
    description:
      "Run JavaScript in this session's WebPilot page and return its JSON result. This is the reliable path for anything the DOM inventory cannot express: reading localStorage/sessionStorage, calling the site's own API with the logged-in session, scraping a table, or batching many DOM actions in one round trip. The expression is awaited, so it may return a Promise (e.g. `fetch('/api/x').then(r => r.json())`). Runs with the page's own origin and cookies — never paste untrusted page text into it.",
    parameters: {
      expression: { type: 'string', required: true, description: "A JS expression or async IIFE body, e.g. `() => document.title` or `() => fetch('/api/me').then(r => r.json())`. Must be JSON-serialisable when it resolves." },
    },
    output: jsonOutput(),
    execute: async (args, exec) => clean(await manager.evaluate(sessionOf(exec), String(args.expression))),
  })

  const press = defineTool({
    name: 'webpilot_press',
    description:
      "Press one key in this session's WebPilot page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). The side panel flashes the key so the human can tell what the agent did.",
    parameters: {
      key: { type: 'string', required: true, description: 'Key name, e.g. Enter.' },
    },
    output: jsonOutput(),
    execute: async (args, exec) => clean(await manager.press(sessionOf(exec), String(args.key))),
  })

  const scroll = defineTool({
    name: 'webpilot_scroll',
    description:
      "Scroll this session's WebPilot viewport: down, up, left, right, top, or bottom. The side panel plays a scroll sweep so the human can tell which way the agent moved.",
    parameters: {
      direction: { type: 'string', required: true, description: 'One of down, up, left, right, top, bottom.' },
      pixels: { type: 'number', description: 'Explicit scroll distance instead of one page.' },
    },
    output: jsonOutput(),
    execute: async (args, exec) => clean(await manager.scroll(sessionOf(exec), String(args.direction), { pixels: args.pixels })),
  })

  const screenshot = defineTool({
    name: 'webpilot_screenshot',
    description:
      "Capture this session's WebPilot page as an image so you can see the rendering (layout, CAPTCHA, QR codes, charts). Prefer webpilot_snapshot for reading text; a screenshot is a read-only look and needs no panel effect.",
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        try {
          const ref = value.attachmentId !== undefined ? screenshotRefs.get(value.attachmentId) : undefined
          if (ref !== undefined) {
            return [{ type: 'text', text: `屏幕截图 ${value.mediaType} ${value.bytes} 字节` }, { type: 'image', attachment: ref }]
          }
          return asText(value)
        } catch (error) {
          return asText({ error: `screenshot render failed: ${error.message}` })
        }
      },
    },
    execute: async (args, exec) => {
      const shot = await manager.screenshot(sessionOf(exec), { fullPage: args.fullPage === true })
      const attachments = getAttachments?.()
      if (attachments !== undefined) {
        try {
          const ref = await attachments.saveImage({ data: shot.data, mediaType: shot.mediaType })
          const attachmentId = `webpilot-shot-${++screenshotSequence}`
          screenshotRefs.set(attachmentId, ref)
          if (screenshotRefs.size > 8) screenshotRefs.delete(screenshotRefs.keys().next().value)
          return { attachmentId, bytes: shot.data.length, mediaType: shot.mediaType }
        } catch (error) {
          logger?.debug?.(`attachment save failed: ${error.message}`)
        }
      }
      const file = join(tmpdir(), `dsh-webpilot-${Date.now()}.png`)
      await writeFile(file, shot.data)
      return { path: file, bytes: shot.data.length, mediaType: shot.mediaType }
    },
  })

  const askHuman = defineTool({
    name: 'webpilot_ask_human',
    description:
      "Hand this session's WebPilot tab to the person in front of the DSH Web UI and wait. Use this whenever you hit something only a human can do: entering credentials, scanning a QR code, a one-time passcode from a phone, a CAPTCHA, or a hardware/SSO step. The browser tab is brought up in the right sidebar of this conversation and comes back to the front even if the human had closed it; the side panel stays live while they work, and this call returns as soon as they press 完成, or on timeout. Two things happen around the handover: an expired QR code is re-requested automatically (beforehand and every 10s while waiting, so a code that dies while the human is away does not waste the budget), and the result carries a loginState probe (loggedIn true/false/null plus the evidence), so you can tell whether the login actually landed instead of guessing.",
    parameters: {
      instruction: { type: 'string', required: true, description: 'What the human should do, in their language, e.g. 请在浏览器面板里登录腾讯云控制台（账号密码或扫码），完成后点「我已完成」。' },
      timeoutSeconds: { type: 'number', description: 'How long to wait for the human (default from plugin config).' },
      url: { type: 'string', description: 'Optional URL to open before handing over.' },
    },
    output: jsonOutput(),
    timeoutMs: askHumanTimeoutMs + 60_000,
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      if (getPanelAvailable() !== true) {
        throw new Error('this deployment has no DSH Web UI, so the browser tab cannot be shown to a human; ask the human to supply the value directly')
      }
      const instruction = String(args.instruction ?? '请在浏览器面板里完成操作，然后点「我已完成」。')
      const timeoutMs = args.timeoutSeconds !== undefined ? Math.max(5_000, Number(args.timeoutSeconds) * 1000) : askHumanTimeoutMs
      if (typeof args.url === 'string' && args.url !== '') await manager.navigate(sessionId, args.url)
      else await manager.ensureSession(sessionId)
      // 交接前先记一次 cookie 指纹：结束时的「新增 cookie」是登录是否成功最硬的证据。
      const cookiesBefore = await manager.cookies(sessionId).catch(() => undefined)
      // 码可能在你叫人的那一刻就已经凉了。
      let qrRefreshes = 0
      const prime = await manager.refreshStaleQr(sessionId).catch(() => undefined)
      if (prime?.refreshed === true) qrRefreshes += 1
      await hub.pushState({ force: true })
      // 人可能十分钟后才回来；等待期间每隔 10s 检查一次码是不是凉了，凉了就换一张。
      // 只有页面确实写着「失效/过期」才会动手，不会打断正在扫码的人。
      const refreshTimer = setInterval(() => {
        manager
          .refreshStaleQr(sessionId)
          .then((result) => {
            if (result?.refreshed === true) qrRefreshes += 1
          })
          .catch(() => {})
      }, 10_000)
      refreshTimer.unref?.()
      const onAbort = () => human.cancel(sessionId, 'cancelled')
      exec?.signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        const outcome = await human.ask(sessionId, instruction, { timeoutMs })
        const loginState = await manager
          .loginState(sessionId, { before: cookiesBefore })
          .catch((error) => ({ loggedIn: null, reason: 'probe-failed', error: String(error?.message ?? error) }))
        const status = await manager.status(sessionId)
        const view = await manager.snapshot(sessionId, { maxChars: 1500 }).catch(() => undefined)
        return clean({
          ...outcome,
          qrRefreshes,
          loginState,
          url: status.session?.url ?? null,
          title: status.session?.title ?? null,
          text: view?.text ?? null,
          elements: view?.elements?.slice(0, 40) ?? null,
        })
      } finally {
        clearInterval(refreshTimer)
        exec?.signal?.removeEventListener?.('abort', onAbort)
      }
    },
  })

  const close = defineTool({
    name: 'webpilot_close',
    description:
      "Close this session's WebPilot tab and free its memory. The shared profile keeps every login, so the next call opens a fresh tab already authenticated. The human can close it from the sidebar panel too, in which case the next tool call simply opens a new one.",
    parameters: {},
    output: jsonOutput(),
    execute: async (_args, exec) => {
      const sessionId = sessionOf(exec)
      const closed = await manager.closeSession(sessionId, { reason: 'closed by the agent' })
      await hub.sync()
      await hub.pushState({ force: true })
      return { closed, sessionId }
    },
  })

  return [status, navigate, snapshot, click, drag, type, press, scroll, wait, screenshot, evaluate, askHuman, close]
}
