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
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${textLimit}),
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
      return JSON.stringify({
        found: true,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        tag: el.tagName.toLowerCase(),
        label: String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      });
    })()`)
    const located = JSON.parse(raw)
    if (located.found !== true) throw new Error(`element #${index} is gone — call webpilot_snapshot again`)
    return located
  }

  /** Click one indexed element with real input events. */
  async click(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const located = await this.locate(sessionId, index)
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
    this.finishAction(sessionId)
    return located
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
  async clickAt(sessionId, x, y) {
    const page = await this.pageFor(sessionId)
    const box = { x: Math.round(x), y: Math.round(y), w: 1, h: 1 }
    await this.leadFx(sessionId, { kind: 'click', x: box.x, y: box.y, box, label: `(${box.x}, ${box.y})`, tool: 'webpilot_click' })
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await sleep(30)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(120)
    this.finishAction(sessionId)
    return { ...box, found: true, source: 'coordinates' }
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
    await this.leadFx(sessionId, {
      kind: 'click',
      x: x1,
      y: y1,
      box: { x: x1, y: y1, w: 1, h: 1 },
      label: `drag → (${x2}, ${y2})`,
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
    this.fx(sessionId, {
      kind: 'click', x: x2, y: y2, box: { x: x2, y: y2, w: 1, h: 1 }, label: 'drag end', tool: 'webpilot_drag',
    })
    this.finishAction(sessionId)
    return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, steps: total, durationMs: budget }
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
    await this.clickAt(sessionId, x, y)
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
    this.finishAction(sessionId)
    return { ...located, submitted: submit === true, replaced: replace === true }
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
    this.finishAction(sessionId)
    return { key }
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
