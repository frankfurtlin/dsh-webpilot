/**
 * Browser lifecycle and per-session page operations.
 *
 * One Chrome instance per DSH host process, launched against a persistent
 * `--user-data-dir` so a human login survives restarts — with **one tab per DSH
 * session**. Every session drives its own page; sessions deliberately share the
 * profile, and therefore the login state, because logging in once and using it
 * everywhere is the point of the plugin.
 *
 * Every agent action also feeds the panel's effect layer (`./fx.js`): the host
 * emits an fx event, waits `effectLeadMs`, then dispatches the real CDP command,
 * so the human sees the spider cursor fly to the target before the page reacts.
 *
 * Two invariants are load-bearing (both measured on the production binary):
 *
 * - a target must be **activated once** after creation, or it silently discards
 *   every injected input event for the rest of its life;
 * - only the **active** tab emits screencast frames, so the hub, not this class,
 *   decides which tab stays in front once a session tab exists.
 *
 * @module dsh-webpilot/browser
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Cdp, fetchVersion } from './cdp.js'
import { EFFECT_IDLE_MS, MAX_READ_BLOCKS, effectLeadMs, effectsEnabled, readBoxes } from './fx.js'

/**
 * Turn what a human typed into the address bar into a navigable URL.
 *
 * The panel is lenient on purpose — people type `example.com`, not
 * `https://example.com/` — but this stays the single source of truth for the
 * guess, so the bar and any future entry point agree. `undefined` means "this is
 * not something we will navigate to" (empty, whitespace, a bare word, or a
 * non-web scheme such as a pasted `javascript:`).
 */
export function normalizeAddress(input) {
  const raw = String(input ?? '').trim()
  if (raw === '' || /\s/.test(raw)) return undefined
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^about:blank$/i.test(raw)) return 'about:blank'
  // Local hosts are checked before schemes: `localhost:3000` looks exactly like
  // a scheme, and a dotted scheme (`example.com:8443`) is a host with a port.
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(raw)) return `http://${raw}`
  // A real scheme never contains a dot, so `example.com:8443` stays a host.
  if (/^[a-z][a-z0-9+-]*:/i.test(raw)) return undefined
  if (!/^[^\s/?#@]+\.[^\s/?#@]+/.test(raw)) return undefined
  return `https://${raw}`
}

/** Folders searched for a Chromium-family binary, in order. */
const PATH_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
]

/** Cache roots of the two Node browser drivers, searched when no system Chrome exists. */
const CACHE_ROOTS = [
  join(homedir(), '.cache', 'ms-playwright'),
  join(homedir(), '.cache', 'puppeteer'),
  join(homedir(), 'Library', 'Caches', 'ms-playwright'),
]

/** Chrome major used for the clean UA when the binary cannot be asked. */
const FALLBACK_CHROME_MAJOR = 153

/** Page attribute linking a snapshot element number to its live DOM node. */
const ELEMENT_ATTRIBUTE = 'data-webpilot-index'
/**
 * 一次快照最多给多少个元素编号。编号不等于返回：snapshot 只返回窗口内的元素，
 * 但编号覆盖全页，所以 webpilot_click(index) / 文本匹配能够到窗口外的目标。
 */
const MAX_INDEXED_ELEMENTS = 800

/** 一张标注截图最多画多少个号：再多图就看不清了（Skyvern 用 60）。 */
const MAX_LOOK_MARKS = 60

/**
 * 页面上「码已经凉了」的文案。
 *
 * 扫码登录的二维码寿命通常 1–2 分钟：人过了十分钟才回到面板，看到的多半是
 * 一张失效的码，这一轮交接就白等了。ask_human 在等待期间用它判断要不要点刷新。
 */
const STALE_CHALLENGE_PATTERNS = [
  /二维码\s*已?\s*(失效|过期|超时|无效)/,
  /验证码\s*已?\s*(失效|过期|超时)/,
  /请点击刷新/,
  /点击刷新/,
  /重新获取二维码/,
]

/** 文案里带这些词的控件会被当成「刷新二维码」按钮。 */
const REFRESH_CONTROL_PATTERN = /(刷新|重新获取|换一张|重新加载)/

/** 判断「已登录」时认的账号导航文案。 */
const ACCOUNT_NAV_SIGNALS = ['退出登录', '我的订单', '个人中心', '账号设置', '我的账户', '个人资料', '退出账号']

/** 只认这几个文案就是「登录/注册」入口的按钮。 */
const LOGIN_CTA_PATTERN = /^(登录|立即登录|去登录|登录\/注册|注册\/登录|登录注册|扫码登录|微信登录|账号登录)$/

/** Keys understood by {@link BrowserManager#press}. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  EscapeSequence: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
}

/** Sleep helper. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build a browser UA without the `HeadlessChrome` token.
 *
 * Chrome for Testing still advertises headless mode in its user agent, which
 * makes ordinary sites serve degraded pages, gate logins, or trip bot checks.
 * The advertised major is kept in step with the real binary so the string stays
 * internally consistent, and the platform token stays whatever the host is.
 */
function cleanUserAgent(majorVersion) {
  const major = Number(majorVersion)
  const reported = Number.isFinite(major) && major > 0 ? major : FALLBACK_CHROME_MAJOR
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + `Chrome/${reported}.0.0.0 Safari/537.36`
  )
}

/** Ask the Chrome binary for its own version; `undefined` when it will not say. */
function detectChromeMajor(executable) {
  try {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5_000 })
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const match = /(\d+)\.\d+\.\d+\.\d+/.exec(text)
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

/** Ask the OS for a currently free TCP port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Resolve a Chromium-family executable: explicit config first, then PATH, then caches. */
export function resolveBrowserPath(configured) {
  if (configured !== undefined && configured !== '') {
    if (!existsSync(configured)) throw new Error(`browser executable not found: ${configured}`)
    return configured
  }
  for (const name of PATH_CANDIDATES) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (dir === '') continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const root of CACHE_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root).sort().reverse()) {
      if (!entry.startsWith('chromium') && !entry.startsWith('chrome')) continue
      for (const inner of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = join(root, entry, inner)
        if (existsSync(candidate) && !candidate.endsWith('headless_shell')) return candidate
      }
    }
  }
  throw new Error(
    'no Chrome/Chromium binary found — install google-chrome-stable, or set browserPath in the plugin config',
  )
}

/** Whether an XVFB display lock is free. */
function displayAvailable(display) {
  const number = display.replace(/^:/, '').split('.')[0]
  return !existsSync(`/tmp/.X${number}-lock`)
}

/** Find Xvfb on PATH (any directory). */
function resolveXvfb() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'Xvfb')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Owns the Chrome process, its virtual display, and one attached tab per session.
 */
export class BrowserManager {
  /**
   * @param options - resolved plugin config plus a logger, the fx sink and a
   *   change notifier. `onFx(sessionId, payload)` receives one effect event
   *   (see docs/INTERFACE.md §2); it must never throw back into an action.
   */
  constructor({ config, logger, onFx, onEvent }) {
    this.config = config
    this.logger = logger
    this.onFx = onFx ?? (() => {})
    this.onEvent = onEvent ?? (() => {})
    this.cdp = undefined
    /** sessionId -> { id, label, page, targetId, createdAt, lastUsedAt, url, title } */
    this.sessions = new Map()
    this.chrome = undefined
    this.xvfb = undefined
    this.display = undefined
    this.port = undefined
    this.executable = undefined
    this.userAgent = undefined
    this.mode = undefined
    this.startedAt = undefined
    this.lastUsedAt = Date.now()
    this.starting = undefined
    this.stopping = false
    this.idleTimer = undefined
    /** sessionId -> pending effect-idle timer (see {@link BrowserManager#finishAction}). */
    this.idleFxTimers = new Map()
    /** Last page of every session seen in this process, so a browser restart can
     * reopen it instead of dropping the session back to about:blank. */
    this.lastUrls = new Map()
    /** Session whose tab the hub currently keeps in front, for `/state`. */
    this.watchedSessionId = undefined
  }

  /**
   * Everything the panel needs to render a status line.
   *
   * @param sessionId - optional session whose own page state is included.
   * @returns browser-level state, plus `session` when an id was given.
   */
  async status(sessionId) {
    const base = {
      running: this.cdp !== undefined,
      mode: this.mode ?? null,
      executable: this.executable ?? null,
      userAgent: this.userAgent ?? null,
      profileDir: this.profileDir(),
      port: this.port ?? null,
      display: this.display ?? null,
      startedAt: this.startedAt ?? null,
      sessions: this.sessions.size,
      watched: this.watchedSessionId ?? null,
    }
    if (sessionId === undefined) return base
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      return {
        ...base,
        session: { id: sessionId, open: false, url: null, title: null, viewport: null, watched: false, createdAt: null },
      }
    }
    let url
    let title
    let viewport
    try {
      const info = await record.page.evaluate(
        'JSON.stringify({url: location.href, title: document.title, w: innerWidth, h: innerHeight})',
      )
      const parsed = JSON.parse(info)
      url = parsed.url
      title = parsed.title
      viewport = { width: parsed.w, height: parsed.h }
      record.url = url
      record.title = title
      if (typeof url === 'string' && url !== '' && url !== 'about:blank') this.lastUrls.set(sessionId, url)
    } catch {
      /* the page may be navigating; report what we last saw */
      url = record.url
      title = record.title
    }
    return {
      ...base,
      session: {
        id: sessionId,
        open: true,
        label: record.label ?? null,
        url: url ?? null,
        title: title ?? null,
        viewport: viewport ?? null,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        watched: this.watchedSessionId === sessionId,
      },
    }
  }

  /** Every open session tab, newest first — the sidebar overview's data. */
  listSessions() {
    const entries = [...this.sessions.values()].map((record) => ({
      id: record.id,
      label: record.label ?? null,
      url: record.url ?? null,
      title: record.title ?? null,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      watched: this.watchedSessionId === record.id,
    }))
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return entries
  }

  /** Absolute path of the persistent Chrome profile. */
  profileDir() {
    const configured = this.config.profileDir
    if (configured !== undefined && configured !== '') return configured.replace(/^~(?=\/)/, homedir())
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'webpilot', 'profile')
  }

  /** The live record for one session, or undefined when it has no tab. */
  session(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Start (or reuse) the browser process. */
  async ensureBrowser() {
    this.lastUsedAt = Date.now()
    if (this.cdp !== undefined) return
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * The tab belonging to one session, created on first use.
   *
   * Creation activates the tab once — without it the target never receives
   * injected input (see the module header) — and records it so the hub can put
   * the foreground back where a watching human expects it.
   *
   * @param sessionId - the calling DSH session.
   * @param options - optional display label and first URL.
   * @returns the session record.
   */
  async ensureSession(sessionId, { label, url } = {}) {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      this.touch()
      return existing
    }
    await this.ensureBrowser()
    const target = url ?? this.lastUrls.get(sessionId) ?? this.config.startUrl ?? 'about:blank'
    const page = await this.cdp.newPage(target)
    try {
      await page.enable()
      await this.applyViewport(page)
      // The one activation that matters: a target that was never activated drops
      // every Input.* call for the rest of its life.
      await this.cdp.activate(page.targetId).catch(() => {})
    } catch (error) {
      await page.close().catch(() => {})
      throw error
    }
    const record = {
      id: sessionId,
      label: label ?? undefined,
      page,
      targetId: page.targetId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      url: target,
      title: undefined,
    }
    this.sessions.set(sessionId, record)
    this.touch()
    this.logger?.info?.(`session tab opened (${sessionId}${label !== undefined ? `, ${label}` : ''})`)
    this.onEvent({ type: 'session-created', sessionId })
    return record
  }

  /** Apply the emulated viewport so the panel's canvas space matches the page. */
  async applyViewport(page, viewport = this.viewportSize()) {
    await page
      .send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => {})
  }

  /** Configured emulated viewport, falling back to the window size. */
  viewportSize() {
    const raw = String(this.config.viewport ?? this.config.windowSize ?? '1440x900')
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim())
    if (match === null) return { width: 1440, height: 900 }
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  /** Bring one session's tab to the front (the hub does this for watched panels). */
  async activateSession(sessionId) {
    const record = this.sessions.get(sessionId)
    if (record === undefined || this.cdp === undefined) return false
    await this.cdp.activate(record.targetId).catch(() => {})
    return true
  }

  /** Remember which session the hub is streaming, so `/state` can report it. */
  setWatched(sessionId) {
    this.watchedSessionId = sessionId
  }

  /**
   * Close one session's tab and forget it.
   *
   * @param sessionId - the session to tear down.
   * @param options - reason recorded in the log and returned to callers.
   * @returns whether a tab was actually closed.
   */
  async closeSession(sessionId, { reason = 'closed' } = {}) {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return false
    this.clearIdleFx(sessionId)
    this.sessions.delete(sessionId)
    if (this.watchedSessionId === sessionId) this.watchedSessionId = undefined
    await record.page.close().catch(() => {})
    await this.cdp?.closeTarget(record.targetId).catch(() => {})
    this.lastUrls.delete(sessionId)
    this.logger?.info?.(`session tab closed (${sessionId}, ${reason})`)
    this.onEvent({ type: 'session-closed', sessionId, reason })
    return true
  }

  /** Close every session tab, keeping the browser process alive. */
  async closeAllSessions(reason = 'closed') {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId, { reason }).catch(() => {})
    }
  }

  /**
   * The UA Chrome is launched with: the configured override when one is set,
   * otherwise a clean UA built from the binary's real major version.
   */
  launchUserAgent() {
    const configured = typeof this.config.userAgent === 'string' ? this.config.userAgent.trim() : ''
    if (configured !== '') return configured
    return cleanUserAgent(detectChromeMajor(this.executable))
  }

  async start() {
    this.executable = resolveBrowserPath(this.config.browserPath)
    this.userAgent = this.launchUserAgent()
    const profileDir = this.profileDir()
    mkdirSync(profileDir, { recursive: true })

    const wanted = this.config.mode ?? 'auto'
    const xvfb = resolveXvfb()
    let mode = 'headless'
    let display = process.env.DISPLAY
    if (wanted === 'auto' || wanted === 'headed') {
      if (display !== undefined && display !== '') {
        mode = 'headed'
      } else if (xvfb !== undefined) {
        const base = Number((this.config.xvfbDisplay ?? ':99').replace(/^:/, '')) || 99
        for (let offset = 0; offset < 12; offset += 1) {
          const candidate = `:${base + offset}`
          if (!displayAvailable(candidate)) continue
          await this.startXvfb(xvfb, candidate)
          display = candidate
          mode = 'headed'
          break
        }
        if (mode !== 'headed' && wanted === 'headed') throw new Error('no free X display for the headed browser')
      } else if (wanted === 'headed') {
        throw new Error('headed mode requested but neither $DISPLAY nor Xvfb is available')
      }
    }

    const port = this.config.port !== undefined && this.config.port > 0 ? this.config.port : await freePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--password-store=basic',
      '--use-mock-keychain',
      '--hide-crash-restore-bubble',
      `--window-size=${(this.config.windowSize ?? '1440x900').replace('x', ',')}`,
      '--window-position=0,0',
    ]
    if (mode === 'headless') args.push('--headless=new')
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
    // A headless Chrome identifies itself as `HeadlessChrome`, which sites use
    // to serve degraded pages and to gate logins — the human has to be able to
    // take this tab over, so present the same surface a headed browser would.
    args.push(`--user-agent=${this.userAgent}`)
    // Keep `navigator.webdriver` and the related automation tells off; some
    // bot walls (and SSO flows) gate on them. Site-visible behaviour only, no
    // CDP capability changes.
    args.push('--disable-blink-features=AutomationControlled')
    // Language and timezone are two of the cheapest bot-wall signals: an
    // account that lives in one place but reports another zone, in a language
    // its owner never writes, is a mismatch real browsers do not have.
    const languages = String(this.config.languages ?? '').trim()
    if (languages !== '')
    {
      const primary = (languages.split(',')[0] ?? '').trim()
      if (primary !== '') args.push(`--lang=${primary}`)
      args.push(`--accept-lang=${languages}`)
    }
    if (Array.isArray(this.config.extraArgs)) args.push(...this.config.extraArgs)
    // Chrome always needs at least one page target; sessions open their own.
    args.push('about:blank')

    const env = { ...process.env }
    if (mode === 'headed' && display !== undefined) env.DISPLAY = display
    const timezone = String(this.config.timezone ?? '').trim()
    if (timezone !== '') env.TZ = timezone
    this.chrome = spawn(this.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.chrome.stdout.on('data', (chunk) => this.logger?.debug?.(`chrome: ${String(chunk).trim()}`))
    this.chrome.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.debug?.(`chrome: ${text}`)
    })
    this.chrome.on('exit', (code, signal) => {
      this.logger?.info?.(`chrome exited (code=${code} signal=${signal})`)
      this.clearAllIdleFx()
      this.cdp?.close()
      this.cdp = undefined
      this.sessions.clear()
      this.watchedSessionId = undefined
      this.chrome = undefined
      this.onEvent({ type: 'browser-stopped' })
    })

    this.port = port
    this.mode = mode
    this.display = mode === 'headed' ? display : undefined

    const version = await fetchVersion(port, this.config.startTimeoutMs ?? 20_000)
    this.cdp = await Cdp.connect(port, { version })
    this.cdp.onClose(() => {
      this.sessions.clear()
    })
    this.startedAt = Date.now()
    this.logger?.info?.(`browser ready (mode=${mode} port=${port} profile=${profileDir})`)
    this.scheduleIdleShutdown()
    this.onEvent({ type: 'browser-started' })
  }

  async startXvfb(xvfb, display) {
    const screen = this.config.screen ?? '1440x900x24'
    this.xvfb = spawn(xvfb, [display, '-screen', '0', screen, '-nolisten', 'tcp', '-noreset'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.xvfb.stderr.on('data', (chunk) => this.logger?.debug?.(`xvfb: ${String(chunk).trim()}`))
    this.xvfb.on('exit', () => {
      this.xvfb = undefined
    })
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (existsSync(`/tmp/.X${display.replace(/^:/, '')}-lock`)) {
        await sleep(150)
        return
      }
      await sleep(100)
    }
    this.logger?.warn?.(`xvfb ${display} did not report a lock file; continuing`)
  }

  /** Stop Chrome (and the private Xvfb) and drop every session tab. */
  async stop({ keepProfile = true } = {}) {
    this.stopping = true
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.clearAllIdleFx()
    const records = [...this.sessions.values()]
    for (const record of records) {
      if (typeof record.url === 'string' && record.url !== '' && record.url !== 'about:blank') this.lastUrls.set(record.id, record.url)
    }
    this.sessions.clear()
    this.watchedSessionId = undefined
    for (const record of records) await record.page.close().catch(() => {})
    if (this.cdp !== undefined) {
      // Ask Chrome to exit gracefully: cookies and storage only flush on a clean
      // shutdown, and a lost flush would log the human out.
      await this.cdp.send('Browser.close', undefined, 3000).catch(() => {})
      this.cdp.close()
      this.cdp = undefined
    }
    if (this.chrome !== undefined) {
      const chrome = this.chrome
      const exited = new Promise((resolve) => chrome.once('exit', resolve))
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 4000)
      await exited.catch(() => {})
      clearTimeout(timer)
      this.chrome = undefined
    }
    if (this.xvfb !== undefined) {
      this.xvfb.kill('SIGTERM')
      this.xvfb = undefined
    }
    if (!keepProfile) {
      const dir = this.profileDir()
      rmSync(dir, { recursive: true, force: true })
    }
    this.stopping = false
    this.startedAt = undefined
    this.onEvent({ type: 'browser-stopped' })
  }

  /** Restart the browser process, keeping the profile (and every login in it). */
  async restart() {
    await this.stop()
    return this.ensureBrowser()
  }

  scheduleIdleShutdown() {
    const minutes = this.config.idleShutdownMinutes ?? 0
    clearTimeout(this.idleTimer)
    if (!(minutes > 0)) return
    this.idleTimer = setTimeout(() => {
      const idleFor = Date.now() - this.lastUsedAt
      if (idleFor >= minutes * 60_000) void this.stop()
      else this.scheduleIdleShutdown()
    }, Math.min(minutes * 60_000, 5 * 60_000))
    this.idleTimer.unref?.()
  }

  /** Record activity so the idle timer does not fire mid-use. */
  touch() {
    this.lastUsedAt = Date.now()
    this.scheduleIdleShutdown()
  }

  // ------------------------------------------------------------------ effects

  /** Emit one effect to the panel watching this session; never throws. */
  fx(sessionId, payload) {
    if (!effectsEnabled(this.config)) return
    try {
      this.onFx(sessionId, payload)
    } catch (error) {
      this.logger?.debug?.(`fx listener failed: ${error.message}`)
    }
  }

  /**
   * Emit an effect, then hold the action back long enough for the panel to play
   * it. This is the whole pacing mechanism: the CDP command is dispatched after
   * the `await`, so a human sees the intent before the page changes. Effects
   * switched off turn this into a plain emit-free no-op with no latency.
   */
  async leadFx(sessionId, payload) {
    this.fx(sessionId, payload)
    const lead = effectLeadMs(this.config)
    if (lead > 0) await sleep(lead)
  }

  /**
   * Settle a session's effect turn: one `idle` after the last action landed,
   * coalesced so a multi-step action (a text click is read + click) closes once.
   */
  finishAction(sessionId) {
    if (!effectsEnabled(this.config)) return
    this.clearIdleFx(sessionId)
    const timer = setTimeout(() => {
      this.idleFxTimers.delete(sessionId)
      this.fx(sessionId, { kind: 'idle' })
    }, EFFECT_IDLE_MS)
    timer.unref?.()
    this.idleFxTimers.set(sessionId, timer)
  }

  /** Drop one session's pending effect-idle timer (no trailing event). */
  clearIdleFx(sessionId) {
    const timer = this.idleFxTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.idleFxTimers.delete(sessionId)
  }

  /** Drop every pending effect-idle timer (browser teardown). */
  clearAllIdleFx() {
    for (const timer of this.idleFxTimers.values()) clearTimeout(timer)
    this.idleFxTimers.clear()
  }

  // ---------------------------------------------------------------- page ops

  /** Resolve a session's page, creating its tab when needed. */
  async pageFor(sessionId, { label, url } = {}) {
    const record = await this.ensureSession(sessionId, { label, url })
    this.touch()
    return record.page
  }

  /** Evaluate an expression in one session's page. */
  async evaluate(sessionId, expression) {
    const page = await this.pageFor(sessionId)
    return page.evaluate(expression)
  }

  /**
   * Navigate one session's page, bracketed by `nav` start/done effects so the
   * panel can glitch-flash to the new address before the load begins.
   */
  async navigate(sessionId, url, options) {
    const page = await this.pageFor(sessionId)
    await this.leadFx(sessionId, { kind: 'nav', url, phase: 'start', tool: 'webpilot_navigate' })
    try {
      await page.navigate(url, options)
    } finally {
      this.fx(sessionId, { kind: 'nav', url, phase: 'done', tool: 'webpilot_navigate' })
      this.finishAction(sessionId)
    }
    return this.status(sessionId)
  }

  /** Replace a session's tab with a fresh one (the old page is discarded). */
  async replaceTab(sessionId, url) {
    await this.leadFx(sessionId, { kind: 'nav', url, phase: 'start', tool: 'webpilot_navigate' })
    try {
      await this.closeSession(sessionId, { reason: 'replaced' })
      const record = await this.ensureSession(sessionId, { url })
      return this.status(record.id)
    } finally {
      this.fx(sessionId, { kind: 'nav', url, phase: 'done', tool: 'webpilot_navigate' })
      this.finishAction(sessionId)
    }
  }

  async goBack(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.evaluate('history.back()')
    await sleep(600)
    return this.status(sessionId)
  }

  async goForward(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.evaluate('history.forward()')
    await sleep(600)
    return this.status(sessionId)
  }

  async reload(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.send('Page.reload')
    await sleep(600)
    return this.status(sessionId)
  }

  /**
   * Structured page read: text, a numbered inventory of actionable elements
   * with page-space boxes, and the visible text blocks the panel scans.
   *
   * Boxes are what make the reading effect possible: every element gets
   * `box:{x,y,w,h}` in the emulated viewport's CSS pixels, and `blocks` lists up
   * to {@link MAX_READ_BLOCKS} on-screen prose blocks. The original return keys
   * are untouched, so anything reading `title`/`url`/`text`/`elements` keeps
   * working; the `read` fx event is emitted once both are known.
   */
  async snapshot(sessionId, { maxChars, maxElements, offset = 0, includeClickables = false } = {}) {
    const page = await this.pageFor(sessionId)
    const textLimit = maxChars ?? this.config.snapshotMaxChars ?? 4000
    const elementLimit = maxElements ?? this.config.maxElements ?? 80
    // 索引永远覆盖整页，只有“返回的窗口”受 elementLimit 限制：否则第 81 个按钮
    // 根本没有编号，webpilot_click/text 都够不着（CNB 的令牌表单就卡在这里）。
    const startOffset = Math.max(0, Number(offset) || 0)
    const viewport = this.viewportSize()
    const raw = await page.evaluate(`(() => {
      const limit = ${elementLimit};
      const blockLimit = ${MAX_READ_BLOCKS};
      const attribute = ${JSON.stringify(ELEMENT_ATTRIBUTE)};
      const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable="true"],[onclick]';
      for (const stale of document.querySelectorAll('[' + attribute + ']')) stale.removeAttribute(attribute);
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;
        // checkVisibility 把 opacity:0 也算进去：预渲染的「提交成功」横幅就是靠
        // opacity 藏起来的，只看 display/visibility 会把它当正常元素喂给模型。
        if (typeof el.checkVisibility === 'function') {
          try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (error) { /* 旧版 Chrome 不认选项 */ }
        }
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const boxOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      const label = (el) => {
        const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('name') || '';
        return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 100);
      };
      const all = [...document.querySelectorAll(selector)].filter(visible).slice(0, ${MAX_INDEXED_ELEMENTS});
      if (${includeClickables ? 'true' : 'false'}) {
        // 兜底：没有语义角色的可点击 div（React 的 onClick 不会留下 [onclick]）。
        const extra = [];
        for (const el of document.querySelectorAll('body *')) {
          if (all.length + extra.length >= ${MAX_INDEXED_ELEMENTS}) break;
          if (el.hasAttribute(attribute) || all.includes(el)) continue;
          if (el.querySelector(selector) !== null) continue;
          const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
          if (text === '' || text.length > 120) continue;
          if (getComputedStyle(el).cursor !== 'pointer') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          extra.push(el);
        }
        all.push(...extra);
      }
      all.forEach((el, index) => el.setAttribute(attribute, String(index)));
      const elements = all.slice(${startOffset}, ${startOffset} + limit);
      // opacity:0 / visibility:hidden 的叶子里的字不算「看得到」。做法是临时把这些
      // 叶子藏起来再读 innerText（innerText 会自动跳掉 visibility:hidden），读完立刻
      // 还原——比事后从字符串里删子串安全（同一句话可能出现两次）。
      const visibleInnerText = () => {
        const body = document.body;
        if (body === null) return '';
        const touched = [];
        let checked = 0;
        for (const el of body.querySelectorAll('*')) {
          if (checked >= 4000) break;
          if (el.childElementCount !== 0) continue;
          if (String(el.textContent || '').trim() === '') continue;
          checked += 1;
          if (typeof el.checkVisibility !== 'function') continue;
          let shown = true;
          try { shown = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (error) { shown = true; }
          if (shown) continue;
          touched.push([el, el.style.visibility]);
          el.style.visibility = 'hidden';
        }
        let text = '';
        try {
          text = String(body.innerText || '');
        } finally {
          for (const entry of touched) entry[0].style.visibility = entry[1];
        }
        return text.replace(/\\n{3,}/g, '\\n\\n');
      };
      // 头 80% + 尾 20%：一页的结论（合计、金额、状态）常在末尾，只留头会把它切掉，
      // 而且必须明说被切了——静默截断会让模型以为页面就这么短。
      const clipText = (source, cap) => {
        const text = String(source || '');
        const limit = Math.max(0, Math.round(cap) || 0);
        if (limit <= 0 || text.length <= limit) return { text: text, cut: 0 };
        const head = Math.max(1, Math.round(limit * 0.8));
        const tail = Math.max(0, limit - head);
        const cut = text.length - limit;
        return {
          text: text.slice(0, head)
            + '\\n…（已省略中间 ' + cut + ' 字，全文 ' + text.length + ' 字；要全量用 webpilot_eval 或分段滚动）…\\n'
            + (tail > 0 ? text.slice(text.length - tail) : ''),
          cut: cut,
        };
      };
      // Visible text blocks: the nearest block-level ancestor of each text run,
      // clipped to the viewport, so the reading effect scans prose rather than
      // painting one full-page rectangle.
      const blockTags = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'FORM', 'DIV']);
      const body = document.body || document.documentElement;
      const blocks = [];
      const seen = new Set();
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = String(node.nodeValue || '').trim();
          if (text.length < 4) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (parent === null) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node !== null && blocks.length < blockLimit; node = walker.nextNode()) {
        let el = node.parentElement;
        while (el !== null && el !== body && !blockTags.has(el.tagName)) el = el.parentElement;
        if (el === null || el === body || seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0.1) continue;
        const candidate = boxOf(el);
        const onScreen = candidate.w >= 12 && candidate.h >= 8 && candidate.x + candidate.w > 0 && candidate.y + candidate.h > 0 && candidate.x < innerWidth && candidate.y < innerHeight;
        const oversized = candidate.w * candidate.h > innerWidth * innerHeight * 0.5;
        if (onScreen && !oversized) blocks.push(candidate);
      }
      blocks.sort((a, b) => a.y - b.y || a.x - b.x);
      const fullText = visibleInnerText();
      const clipped = clipText(fullText, ${textLimit});
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: clipped.text,
        textTotal: fullText.length,
        total: all.length,
        offset: ${startOffset},
        elements: elements.map((el, windowIndex) => ({
          index: windowIndex + ${startOffset},
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          label: label(el),
          value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value || '').slice(0, 100) : undefined,
          // 链接必须带 href：模型拿不到 URL 就只能靠文本猜，像小红书那种
          // 「必须带 xsec_token 才打得开」的站，没有 href 等于进不去。
          href: el.tagName === 'A' && el.href ? String(el.href).slice(0, 400) : undefined,
          disabled: el.disabled === true ? true : undefined,
          box: boxOf(el),
        })),
        blocks,
      });
    })()`)
    const snapshot = JSON.parse(raw)
    this.fx(sessionId, {
      kind: 'read',
      title: snapshot.title,
      url: snapshot.url,
      boxes: readBoxes({ elements: snapshot.elements, blocks: snapshot.blocks, viewport }),
      tool: 'webpilot_snapshot',
    })
    this.finishAction(sessionId)
    return snapshot
  }

  /** Screen-space centre of an indexed element, scrolled into view. */
  async locate(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const selector = `[${ELEMENT_ATTRIBUTE}="${index}"]`
    const raw = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ found: false });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.x + rect.width / 2);
      const cy = Math.round(rect.y + rect.height / 2);
      const boxOf = (node) => {
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      // 动作前预检：被浮层盖住 / disabled / inert / 滚出视口时，几何中心点下去打到的
      // 是别的东西——以前照样返回 found:true，右侧面板还演一遍点击，骗了模型也骗了人。
      const blocked = [];
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') blocked.push({ reason: 'disabled' });
      if (el.closest('[inert]') !== null) blocked.push({ reason: 'inert' });
      const inViewport = rect.width > 0 && rect.height > 0 && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      if (!inViewport) blocked.push({ reason: 'offscreen', box: boxOf(el) });
      let hit = null;
      try { hit = document.elementFromPoint(cx, cy); } catch (error) { hit = null; }
      if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        blocked.push({
          reason: 'occluded',
          by: {
            tag: hit.tagName.toLowerCase(),
            label: String(hit.getAttribute('aria-label') || hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
            box: boxOf(hit),
          },
        });
      }
      return JSON.stringify({
        found: true,
        x: cx,
        y: cy,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        tag: el.tagName.toLowerCase(),
        label: String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        blocked: blocked,
      });
    })()`)
    const located = JSON.parse(raw)
    if (located.found !== true) throw new Error(`element #${index} is gone — call webpilot_snapshot again`)
    const blocked = Array.isArray(located.blocked) ? located.blocked : []
    if (blocked.length > 0) {
      const first = blocked[0]
      const detail =
        first.reason === 'occluded'
          ? `被 <${first.by.tag}> "${first.by.label}" 盖住（它的 box ${JSON.stringify(first.by.box)}）`
          : first.reason === 'disabled'
            ? '是 disabled 状态，点了不会有任何反应'
            : first.reason === 'inert'
              ? '在一个 [inert] 子树里，浏览器不会派发事件给它'
              : '滚动之后仍然不在视口内'
      throw new Error(`元素 #${index}（${located.label}）现在点不了：${detail}。先关掉遮挡层/等它可用，再重新 webpilot_snapshot。`)
    }
    return located
  }

  /**
   * 动作前在页面里装一个变更探针，返回动作前的基线。
   *
   * 探针 = 页面里的 MutationObserver 计数 + 一个随机 document 身份：文档内的变化
   * 记在计数上，整页跳转会连 window 和上下文一起销毁——「探针不见了」本身就是最
   * 可靠的「导航发生了」信号。
   */
  async beginAction(sessionId) {
    const page = await this.pageFor(sessionId)
    const raw = await page.evaluate(`(() => {
      if (!window.__webpilotProbe) {
        const state = { n: 0, last: Date.now(), doc: Math.random().toString(36).slice(2) };
        try {
          new MutationObserver(() => { state.n += 1; state.last = Date.now(); })
            .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch (error) { /* 极端页面拒绝 observe：退化成只看导航 */ }
        window.__webpilotProbe = state;
      }
      const probe = window.__webpilotProbe;
      return JSON.stringify({ n: probe.n, doc: probe.doc, url: location.href });
    })()`)
    let baseline = {}
    try { baseline = JSON.parse(raw) } catch (error) { baseline = {} }
    return { ...baseline, at: Date.now() }
  }

  /**
   * 动作后等到页面安静下来，给出三种结论之一：navigated / changed / none。
   *
   * 用「变更计数 + 静默时长」而不是固定 sleep：DOM 还在抖就继续等，什么都没发生
   * 就到预算为止（默认 1200ms 上限、180ms 静默）。这样「点了没反应」当次就能看见，
   * 不用等下一轮 snapshot 肉眼比对。
   */
  async endAction(sessionId, before, { quietMs = 160, timeoutMs = 800, pollMs = 50 } = {}) {
    if (before === undefined || before === null) return { changed: null, navigated: null, reason: 'no-baseline' }
    const page = await this.pageFor(sessionId)
    const started = Date.now()
    for (;;) {
      let current
      try {
        const raw = await page.evaluate(`(() => {
          const probe = window.__webpilotProbe;
          if (!probe) return JSON.stringify({ alive: false, url: location.href });
          return JSON.stringify({ alive: true, n: probe.n, doc: probe.doc, url: location.href, idle: Date.now() - probe.last });
        })()`)
        current = JSON.parse(raw)
      } catch (error) {
        return { changed: true, navigated: true, reason: 'context-replaced', mutations: null, waitedMs: Date.now() - started }
      }
      if (current.alive !== true) {
        return { changed: true, navigated: true, reason: 'probe-gone', url: current.url, waitedMs: Date.now() - started }
      }
      const mutations = current.n - (before.n ?? 0)
      const navigated = typeof before.url === 'string' && current.url !== before.url
      const changed = mutations > 0 || current.doc !== before.doc || navigated
      if (changed && (navigated || current.idle >= quietMs)) {
        return { changed: true, navigated, mutations, url: current.url, waitedMs: Date.now() - started }
      }
      if (Date.now() - started >= timeoutMs) {
        return { changed, navigated, mutations, url: current.url, waitedMs: Date.now() - started }
      }
      await sleep(pollMs)
    }
  }

  /** 输入之后读回字段值——「打了字但没进去」是受控输入最常见的一种失败。 */
  async readFieldValue(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const raw = await page.evaluate(`(() => {
      const el = document.querySelector('[' + ${JSON.stringify(ELEMENT_ATTRIBUTE)} + '="' + ${JSON.stringify(String(index))} + '"]');
      if (el === null) return JSON.stringify({ found: false });
      const value = el.value !== undefined && el.value !== null ? el.value : el.textContent || '';
      return JSON.stringify({ found: true, value: String(value) });
    })()`)
    try { return JSON.parse(raw) } catch (error) { return { found: false } }
  }

  /** Click one indexed element with real input events. */
  async click(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const located = await this.locate(sessionId, index)
    const before = await this.beginAction(sessionId)
    await this.leadFx(sessionId, {
      kind: 'click',
      x: located.x,
      y: located.y,
      box: located.box,
      label: located.label,
      tool: 'webpilot_click',
    })
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: located.x, y: located.y, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await sleep(30)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(120)
    const assertion = await this.endAction(sessionId, before)
    this.finishAction(sessionId)
    return { ...located, ...assertion }
  }

  /**
   * Click by visible text — a convenience for stable, human-readable targets.
   *
   * The match runs over every indexed element on the page, not just the window
   * the last snapshot returned, and it includes role-less clickable divs
   * (`includeClickables`): a dropdown shipped through a portal is usually a
   * `<div>` with an onClick, which has neither a role nor an `[onclick]`
   * attribute for the selector to find.
   */
  async clickText(sessionId, text) {
    const page = await this.pageFor(sessionId)
    await this.snapshot(sessionId, { maxChars: 0, maxElements: MAX_INDEXED_ELEMENTS, includeClickables: true })
    const needle = String(text).trim().toLowerCase()
    const raw = await page.evaluate(`(() => {
      const needle = ${JSON.stringify(needle)};
      const attr = ${JSON.stringify(ELEMENT_ATTRIBUTE)};
      const labelOf = (el) => String(
        el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText ||
        el.value || el.getAttribute('title') || el.getAttribute('name') || ''
      ).replace(/\\s+/g, ' ').trim().toLowerCase();
      const all = [...document.querySelectorAll('[' + attr + ']')];
      const exact = all.find((el) => labelOf(el) === needle);
      const partial = all.find((el) => labelOf(el).includes(needle));
      const hit = exact ?? partial;
      return hit === undefined ? '' : hit.getAttribute(attr);
    })()`)
    if (raw === '' || raw === null || raw === undefined) {
      throw new Error(`页面上没有匹配 ${JSON.stringify(text)} 的可点击元素（已扫描全页 ${MAX_INDEXED_ELEMENTS} 个元素）`)
    }
    const index = Number(raw)
    const located = await this.click(sessionId, index)
    return { ...located, index }
  }

  /** 按页面坐标点击：截图里看到了目标、但没有可抓取的 DOM 元素时用它。 */
  async clickAt(sessionId, x, y, { probe = true } = {}) {
    const page = await this.pageFor(sessionId)
    const box = { x: Math.round(x), y: Math.round(y), w: 1, h: 1 }
    const before = probe === true ? await this.beginAction(sessionId) : null
    await this.leadFx(sessionId, { kind: 'click', x: box.x, y: box.y, box, label: `(${box.x}, ${box.y})`, tool: 'webpilot_click' })
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await sleep(30)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(120)
    const assertion = before === null ? {} : await this.endAction(sessionId, before)
    this.finishAction(sessionId)
    return { ...box, found: true, source: 'coordinates', ...assertion }
  }

  /**
   * 按住 → 拖过去 → 松开，一次真实拖拽。
   *
   * 滑块验证码（阿里、腾讯、美团那几家）只认完整的三段式：mousePressed 之后
   * 必须有一串 **buttons:1 的 mouseMoved**，再 mouseReleased；缺了中间那段，
   * 页面判定「不是人」。轨迹用 ease-out 收敛，而不是匀速直线——匀速拖拽本身
   * 就是脚本特征。
   *
   * 面板看到的是起点一次 click 特效 + 终点一次 click 特效（宿主故意不发新的
   * fx kind：未知 kind 客户端会忽略，改契约要动 UI 半）。
   */
  async drag(sessionId, from, to, { steps = 12, durationMs = 420 } = {}) {
    const page = await this.pageFor(sessionId)
    const x1 = Math.round(Number(from?.x))
    const y1 = Math.round(Number(from?.y))
    const x2 = Math.round(Number(to?.x))
    const y2 = Math.round(Number(to?.y))
    if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) {
      throw new Error('drag 需要有限的起点 {x,y} 与终点 {x,y}')
    }
    const total = Math.min(60, Math.max(2, Math.round(Number(steps) || 12)))
    const budget = Math.min(6_000, Math.max(60, Math.round(Number(durationMs) || 420)))
    const stepDelay = Math.max(4, Math.round(budget / total))
    const before = await this.beginAction(sessionId)
    await this.leadFx(sessionId, {
      kind: 'click',
      x: x1,
      y: y1,
      box: { x: x1, y: y1, w: 1, h: 1 },
      label: `drag → (${x2}, ${y2})`,
      tool: 'webpilot_drag',
    })
    // 拖拽轨迹：和真实按下同时发出，面板上那条线按 durationMs 长到终点——人看到
    // 的轨迹和鼠标走的是同一段时间，而不是事后补画一条线。
    this.fx(sessionId, {
      kind: 'drag',
      from: { x: x1, y: y1 },
      to: { x: x2, y: y2 },
      durationMs: budget,
      label: `${x1},${y1} → ${x2},${y2}`,
      tool: 'webpilot_drag',
    })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1,
    })
    for (let index = 1; index <= total; index += 1) {
      const t = index / total
      const eased = 1 - (1 - t) ** 3
      const x = Math.round(x1 + (x2 - x1) * eased)
      const y = Math.round(y1 + (y2 - y1) * eased)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 })
      await sleep(stepDelay)
    }
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0,
    })
    await sleep(140)
    const assertion = await this.endAction(sessionId, before)
    this.finishAction(sessionId)
    return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, steps: total, durationMs: budget, ...assertion }
  }

  /**
   * 等一个条件成立再返回：选择器出现、文本出现，或它们消失（`gone`）。
   *
   * 所有 SPA 都是「点了之后过一会儿才渲染」，没有这个原语就只能盲目 sleep：
   * 等短了抓空，等长了浪费。轮询在页面里做，默认 200ms 一次、10s 超时、上限 120s。
   */
  async waitFor(sessionId, { selector, text, gone = false, timeoutMs = 10_000, pollMs = 200 } = {}) {
    const page = await this.pageFor(sessionId)
    const needle = typeof text === 'string' && text !== '' ? text : undefined
    const query = typeof selector === 'string' && selector !== '' ? selector : undefined
    if (needle === undefined && query === undefined) throw new Error('waitFor 需要 selector 或 text 之一')
    const budget = Math.min(120_000, Math.max(200, Math.round(Number(timeoutMs) || 10_000)))
    const interval = Math.min(2_000, Math.max(50, Math.round(Number(pollMs) || 200)))
    const probe = `(() => {
      const selector = ${JSON.stringify(query ?? null)};
      const needle = ${JSON.stringify(needle ?? null)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const describe = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          label: String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          href: el.tagName === 'A' && el.href ? String(el.href).slice(0, 400) : undefined,
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      };
      let hit = null;
      if (selector !== null) {
        for (const el of document.querySelectorAll(selector)) {
          if (visible(el)) { hit = el; break; }
        }
      }
      if (hit === null && needle !== null) {
        const body = document.body;
        if (body !== null && String(body.innerText || '').includes(needle)) {
          for (const el of body.querySelectorAll('*')) {
            if (!String(el.innerText || '').includes(needle)) continue;
            if (!visible(el)) continue;
            // 只认最深的命中：父节点的 innerText 必然也包含这段文本
            if ([...el.children].some((child) => String(child.innerText || '').includes(needle))) continue;
            hit = el;
            break;
          }
          if (hit === null) hit = body;
        }
      }
      return JSON.stringify({ present: hit !== null, element: hit === null ? null : describe(hit) });
    })()`
    const started = Date.now()
    const deadline = started + budget
    for (;;) {
      let probeResult
      try {
        probeResult = JSON.parse(await page.evaluate(probe))
      } catch (error) {
        throw new Error(`页面内探测失败：${error.message}`)
      }
      const satisfied = gone === true ? probeResult.present === false : probeResult.present === true
      if (satisfied) {
        this.finishAction(sessionId)
        return {
          matched: true,
          gone: gone === true,
          waitedMs: Date.now() - started,
          selector: query ?? null,
          text: needle ?? null,
          element: probeResult.element ?? null,
        }
      }
      if (Date.now() + interval > deadline) break
      await sleep(interval)
    }
    this.finishAction(sessionId)
    return {
      matched: false,
      gone: gone === true,
      timedOut: true,
      waitedMs: Date.now() - started,
      selector: query ?? null,
      text: needle ?? null,
      element: null,
    }
  }

  /**
   * 二维码/验证码过期时，点一下页面上的「刷新」。
   *
   * 交接给人之后，宿主每 10s 调一次；只有在页面确实写着「失效/过期/点击刷新」
   * 时才动手，所以不会打断正在扫码的人。返回 `refreshed:true` 说明点过了。
   */
  async refreshStaleQr(sessionId) {
    const page = await this.pageFor(sessionId)
    const probe = `(() => {
      const staleSources = ${JSON.stringify(STALE_CHALLENGE_PATTERNS.map((pattern) => pattern.source))};
      const controlSource = ${JSON.stringify(REFRESH_CONTROL_PATTERN.source)};
      const text = String(document.body ? document.body.innerText : '');
      const stale = staleSources.map((source) => new RegExp(source)).find((pattern) => pattern.test(text));
      if (stale === undefined) return JSON.stringify({ stale: false });
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.1;
      };
      const control = new RegExp(controlSource);
      const candidates = [];
      for (const el of document.querySelectorAll('a,button,[role=button],div,span')) {
        const label = String(el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (label === '' || label.length > 24) continue;
        if (!control.test(label)) continue;
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        candidates.push({
          label,
          area: rect.width * rect.height,
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }
      candidates.sort((a, b) => a.area - b.area);
      return JSON.stringify({ stale: true, matched: String(text.match(stale)?.[0] ?? ''), control: candidates[0] ?? null });
    })()`
    let probeResult
    try {
      probeResult = JSON.parse(await page.evaluate(probe))
    } catch (error) {
      throw new Error(`页面内探测失败：${error.message}`)
    }
    if (probeResult.stale !== true) return { refreshed: false, reason: 'no-stale-challenge' }
    const control = probeResult.control
    if (control === null || control === undefined) {
      return { refreshed: false, reason: 'stale-but-no-control', matched: probeResult.matched }
    }
    const x = control.box.x + Math.round(control.box.w / 2)
    const y = control.box.y + Math.round(control.box.h / 2)
    await this.clickAt(sessionId, x, y, { probe: false })
    await sleep(400)
    return { refreshed: true, control: control.label, x, y, matched: probeResult.matched }
  }

  /**
   * 这一页现在算不算「已登录」——ask_human 结束时给模型一个可判断的返回。
   *
   * 证据三条：页面上还挂着登录/注册入口（`login-cta`，说明没登进去）、出现了
   * 账号导航或头像（`account-nav`，说明登进去了）、相比交接前多了新 cookie
   * （`new-cookies`，最强但需要 `before`）。判断不出来时 `loggedIn:null`：
   * 宁可说不知道，也不猜。
   */
  async loginState(sessionId, { before } = {}) {
    const page = await this.pageFor(sessionId)
    const probe = `(() => {
      const text = String(document.body ? document.body.innerText : '');
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const ctaPattern = ${JSON.stringify(LOGIN_CTA_PATTERN.source)};
      const cta = [];
      for (const el of document.querySelectorAll('a,button,[role=button]')) {
        const label = String(el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (label === '' || label.length > 16) continue;
        if (!new RegExp(ctaPattern).test(label)) continue;
        if (!visible(el)) continue;
        cta.push(label);
      }
      const signals = [];
      for (const needle of ${JSON.stringify(ACCOUNT_NAV_SIGNALS)}) {
        if (text.includes(needle)) signals.push(needle);
      }
      // 头像单独报，不混进 signals：广告位、默认图、别人的头像都会命中
      // [class*=avatar]，把它当「已登录」会跟页面上的登录按钮打架（B 站就是这样）。
      const avatar = document.querySelector('img[class*="avatar" i], [class*="avatar" i] img') !== null;
      return JSON.stringify({
        url: location.href,
        title: document.title,
        loginCta: cta.slice(0, 4),
        signals: signals.slice(0, 6),
        avatar,
        head: text.replace(/\\s+/g, ' ').slice(0, 200),
      });
    })()`
    let pageInfo
    try {
      pageInfo = JSON.parse(await page.evaluate(probe))
    } catch (error) {
      throw new Error(`页面内探测失败：${error.message}`)
    }
    let newCookies = []
    let cookieError
    if (Array.isArray(before)) {
      try {
        const now = await this.cookies(sessionId)
        const beforeKeys = new Set(before.map((cookie) => `${cookie.domain}|${cookie.name}`))
        newCookies = now
          .filter((cookie) => !beforeKeys.has(`${cookie.domain}|${cookie.name}`))
          .map((cookie) => cookie.name)
          .slice(0, 12)
      } catch (error) {
        cookieError = error.message
      }
    }
    let loggedIn = null
    let reason = 'unknown'
    if (pageInfo.signals.length > 0 && pageInfo.loginCta.length === 0) {
      loggedIn = true
      reason = 'account-nav'
    } else if (pageInfo.loginCta.length > 0 && pageInfo.signals.length === 0) {
      // 登录入口还在，就当没登进去：头像/广告位上的图不能推翻这一条（B 站
      // 未登录时既有「登录」按钮，也有 [class*=avatar] 的占位图）。
      loggedIn = false
      reason = 'login-cta'
    } else if (pageInfo.loginCta.length === 0 && pageInfo.signals.length === 0 && pageInfo.avatar === true) {
      loggedIn = true
      reason = 'avatar'
    }
    if (loggedIn === null && newCookies.length > 0) {
      loggedIn = true
      reason = 'new-cookies'
    }
    return {
      loggedIn,
      reason,
      url: pageInfo.url,
      title: pageInfo.title,
      loginCta: pageInfo.loginCta,
      signals: pageInfo.signals,
      avatar: pageInfo.avatar === true,
      newCookies,
      ...(cookieError === undefined ? {} : { cookieError }),
      head: pageInfo.head,
    }
  }

  /**
   * 在页面上下文里执行一段 JS 并返回 JSON 结果。
   *
   * 这是让 agent 在登录态里做事的唯一实用通道：读 localStorage、用页面自己的
   * 凭据调接口、批量处理 DOM，都比「截图 + 逐个点击」可靠得多。
   */
  async evaluate(sessionId, expression, { awaitPromise = true } = {}) {
    const page = await this.pageFor(sessionId)
    this.fx(sessionId, { kind: 'read', title: 'evaluate', url: page.url?.() ?? '', boxes: [], tool: 'webpilot_eval' })
    // 表达式既可能是 `() => v` 也可能是 `fetch(...)`：先取出值，是函数就调用。
    const source = `(async () => {
      const candidate = (${expression});
      const value = typeof candidate === 'function' ? await candidate() : await candidate;
      return JSON.stringify(value === undefined ? null : value);
    })()`
    let raw
    try {
      raw = await page.evaluate(source, { awaitPromise })
    } catch (error) {
      throw new Error(`页面内执行失败：${error.message}`)
    }
    this.finishAction(sessionId)
    if (typeof raw !== 'string') return raw ?? null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  /**
   * Focus an indexed field and insert text.
   *
   * The click is not decoration: `Input.insertText` is a silent no-op unless the
   * renderer has a focused text-accepting element, so the field is focused with
   * a real press/release pair first.
   */
  async type(sessionId, index, text, { submit = false, replace = false } = {}) {
    const page = await this.pageFor(sessionId)
    const located = await this.locate(sessionId, index)
    await this.leadFx(sessionId, {
      kind: 'type',
      x: located.x,
      y: located.y,
      box: located.box,
      label: located.label,
      text: typeof text === 'string' ? text : '',
      tool: 'webpilot_type',
    })
    const before = await this.beginAction(sessionId)
    const valueBefore = await this.readFieldValue(sessionId, index).catch(() => null)
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(60)
    if (replace === true) {
      // 现有内容必须先清掉：insertText 是“插入”，不替换，之前的实现会把新文本
      // 直接拼在旧值后面（CNB 的确认框要求整段路径，拼上去就永远不匹配）。
      await this.selectAll(sessionId)
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
      await sleep(40)
    }
    if (text !== undefined && text !== '') await page.send('Input.insertText', { text })
    await sleep(60)
    if (submit) await this.press(sessionId, 'Enter')
    const assertion = await this.endAction(sessionId, before, { timeoutMs: 400 })
    const field = await this.readFieldValue(sessionId, index).catch(() => null)
    const valueAfter = field !== null && field.found === true ? field.value : null
    // 输入框的 value 变化不是 DOM 变更，MutationObserver 看不见——type 的「成了没」
    // 只能靠读回字段值来判断（受控输入把值吞掉时也会在这里露出来）。
    const fieldChanged =
      valueBefore !== null && valueBefore.found === true && valueAfter !== null ? valueAfter !== valueBefore.value : null
    this.finishAction(sessionId)
    return {
      ...located,
      submitted: submit === true,
      replaced: replace === true,
      value: valueAfter,
      ...assertion,
      changed: fieldChanged === null ? assertion.changed : fieldChanged || assertion.changed === true,
    }
  }

  /** 全选当前焦点内的文本（Ctrl+A），供 replace 输入使用。 */
  async selectAll(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    })
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    })
    await sleep(40)
  }

  /** Dispatch one named key press. */
  async press(sessionId, key) {
    const page = await this.pageFor(sessionId)
    const spec = KEYS[key]
    if (spec === undefined) throw new Error(`unsupported key ${JSON.stringify(key)}; use one of ${Object.keys(KEYS).join(', ')}`)
    const before = await this.beginAction(sessionId)
    await this.leadFx(sessionId, { kind: 'key', key, tool: 'webpilot_press' })
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    }
    await page.send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, text: spec.text })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(80)
    const assertion = await this.endAction(sessionId, before)
    this.finishAction(sessionId)
    return { key, ...assertion }
  }

  /** Scroll the viewport, either in whole pages or by an explicit delta. */
  async scroll(sessionId, direction, { pixels } = {}) {
    const page = await this.pageFor(sessionId)
    const viewport = await page.viewport()
    const step = pixels ?? Math.round(viewport.height * 0.85)
    const deltas = {
      down: { deltaX: 0, deltaY: step },
      up: { deltaX: 0, deltaY: -step },
      left: { deltaX: -step, deltaY: 0 },
      right: { deltaX: step, deltaY: 0 },
      top: { deltaX: 0, deltaY: -1_000_000 },
      bottom: { deltaX: 0, deltaY: 1_000_000 },
    }
    const delta = deltas[direction]
    if (delta === undefined) throw new Error(`unsupported direction ${JSON.stringify(direction)}`)
    await this.leadFx(sessionId, {
      kind: 'scroll',
      direction,
      dy: direction === 'down' ? step : direction === 'up' ? -step : undefined,
      tool: 'webpilot_scroll',
    })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(viewport.width / 2),
      y: Math.round(viewport.height / 2),
      ...delta,
    })
    await sleep(350)
    this.finishAction(sessionId)
    return this.status(sessionId)
  }

  /** PNG screenshot as raw bytes. */
  async screenshot(sessionId, { format = 'png', fullPage = false } = {}) {
    const page = await this.pageFor(sessionId)
    const result = await page.send('Page.captureScreenshot', { format, captureBeyondViewport: fullPage })
    this.finishAction(sessionId)
    return { data: Buffer.from(result.data, 'base64'), mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
  }

  /**
   * 标注截图：视口截图 + 每个可交互元素的编号框，再把同编号的 legend 一起给模型。
   *
   * 为什么值得单独一个工具：文本里的编号和截图里的位置是两条通道，模型看图时
   * 没有号、读号时看不见图。把号画到图上之后，"点第 7 个"才第一次既能在文本里
   * 指认、也能在图上看到（Skyvern 的 look() / Stagehand 的 selectorMap 同思路）。
   *
   * 合成走一个离屏 CDP target，**不往被访问页面注入任何东西**，也不需要新的 npm
   * 依赖（画布就在 Chrome 里）。坐标契约与 click 一致：视口 CSS px、DSF 1。
   */
  async look(sessionId, { maxMarks = MAX_LOOK_MARKS } = {}) {
    const page = await this.pageFor(sessionId)
    // 用真实的布局视口，不是配置里的窗口尺寸：headed Chrome 的内容区会比窗口小一截，
    // 拿错尺寸会让编号框整体偏移。
    const metrics = await page.send('Page.getLayoutMetrics').catch(() => null)
    const cssWidth = Math.round(metrics?.cssLayoutViewport?.clientWidth ?? this.viewportSize().width)
    const cssHeight = Math.round(metrics?.cssLayoutViewport?.clientHeight ?? this.viewportSize().height)
    const viewport = { width: Math.max(1, cssWidth), height: Math.max(1, cssHeight) }
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const snapshot = await this.snapshot(sessionId, { maxChars: 0, maxElements: Math.max(1, Math.min(maxMarks, MAX_LOOK_MARKS)) })
    let marks = (snapshot.elements ?? [])
      .filter((element) => {
        const box = element.box
        if (box === undefined || box === null) return false
        if (box.w < 3 || box.h < 3) return false
        return box.x + box.w > 0 && box.y + box.h > 0 && box.x < viewport.width && box.y < viewport.height
      })
      .map((element) => ({ index: element.index, tag: element.tag, label: element.label ?? '', box: element.box }))
    // 只给"点得着"的元素画号：被浮层盖住的号画上去就是骗人（点了会被预检拒绝）。
    // 判定和 locate() 用同一套规则，避免"图上能点、点了不行"。
    let hidden = 0
    if (marks.length > 0) {
      try {
        const raw = await page.evaluate(`(() => {
          const kept = [];
          let hidden = 0;
          for (const index of ${JSON.stringify(marks.map((mark) => mark.index))}) {
            const el = document.querySelector('[' + ${JSON.stringify(ELEMENT_ATTRIBUTE)} + '="' + index + '"]');
            if (el === null) { hidden += 1; continue; }
            const rect = el.getBoundingClientRect();
            const x = Math.round(rect.x + rect.width / 2);
            const y = Math.round(rect.y + rect.height / 2);
            let hit = null;
            try { hit = document.elementFromPoint(x, y); } catch (error) { hit = null; }
            const related = hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
            if (!related) { hidden += 1; continue; }
            kept.push(index);
          }
          return JSON.stringify({ kept: kept, hidden: hidden });
        })()`)
        const visibility = JSON.parse(raw)
        const visible = new Set(visibility.kept ?? [])
        hidden = visibility.hidden ?? 0
        marks = marks.filter((mark) => visible.has(mark.index))
      } catch (error) {
        hidden = 0
      }
    }
    if (marks.length === 0) {
      const buffer = Buffer.from(shot.data, 'base64')
      return { data: buffer, mediaType: 'image/png', marks: [], drawn: 0, hidden }
    }
    // 后台创建 + 用完提回前台：新建 target 会抢走前台，会话页一旦变成后台标签，
    // Chrome 会节流它的渲染和输入派发（实测下一次点击从 100ms 变 6.3s）。
    const offscreen = await this.cdp.newPage('about:blank', { background: true })
    try {
      const payload = {
        image: `data:image/png;base64,${shot.data}`,
        viewport: { w: viewport.width, h: viewport.height },
        marks: marks.map((mark) => ({ index: mark.index, box: mark.box })),
      }
      const raw = await offscreen.evaluate(`(async () => {
        const payload = ${JSON.stringify(payload)};
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('screenshot decode failed'));
          image.src = payload.image;
        });
        const canvas = document.createElement('canvas');
        // 官方建议截图不要超过 XGA/WXGA：太宽的图既贵又不会更准，缩到 1280 宽。
        const shrink = Math.min(1, 1280 / Math.max(1, image.naturalWidth));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * shrink));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * shrink));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const scale = canvas.width / payload.viewport.w;
        const placed = [];
        const overlaps = (x, y, w, h) => placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
        let drawn = 0;
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        for (const mark of payload.marks) {
          const box = mark.box;
          const x = Math.round(box.x * scale);
          const y = Math.round(box.y * scale);
          const w = Math.max(2, Math.round(box.w * scale));
          const h = Math.max(2, Math.round(box.h * scale));
          if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue;
          ctx.strokeStyle = 'rgba(10,124,147,0.95)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
          const text = String(mark.index);
          const chipW = Math.max(16, Math.round(ctx.measureText(text).width) + 8);
          const chipH = 14;
          let chipX = x;
          let chipY = y - chipH - 1;
          if (chipY < 0) chipY = y + 1;
          // 角标互相压住就右移 / 下移，最多试 12 次
          for (let attempt = 0; attempt < 12 && overlaps(chipX, chipY, chipW, chipH); attempt += 1) {
            chipX += chipW + 2;
            if (chipX + chipW > canvas.width) { chipX = x; chipY += chipH + 2; }
          }
          if (chipX + chipW > canvas.width) chipX = Math.max(0, canvas.width - chipW);
          placed.push({ x: chipX, y: chipY, w: chipW, h: chipH });
          ctx.fillStyle = 'rgba(10,124,147,0.95)';
          ctx.fillRect(chipX, chipY, chipW, chipH);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, chipX + 4, chipY + 2);
          drawn += 1;
        }
        return JSON.stringify({ dataUrl: canvas.toDataURL('image/png'), drawn: drawn });
      })()`)
      const composed = JSON.parse(raw)
      const base64 = String(composed.dataUrl || '').replace(/^data:image\/png;base64,/, '')
      this.fx(sessionId, {
        kind: 'read',
        boxes: marks.map((mark) => ({ ...mark.box, kind: 'element' })),
        title: `look · ${marks.length} marks`,
        url: page.url?.() ?? '',
        tool: 'webpilot_look',
      })
      this.finishAction(sessionId)
      return {
        data: Buffer.from(base64, 'base64'),
        mediaType: 'image/png',
        marks,
        drawn: composed.drawn ?? 0,
        hidden,
      }
    } finally {
      await offscreen.close().catch(() => {})
      await page.send('Page.bringToFront').catch(() => {})
    }
  }

  /** Current cookies (names and domains only — values are truncated). */
  async cookies(sessionId) {
    const page = await this.pageFor(sessionId)
    // getAllCookies 只在 Network 域启用后才稳定返回；启用是无副作用的，
    // 失败也只是没拿到 cookie（登录态判定会退回页面文案证据）。
    await page.send('Network.enable').catch(() => {})
    const result = await page.send('Network.getAllCookies')
    return (result.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      session: cookie.session,
    }))
  }
}
