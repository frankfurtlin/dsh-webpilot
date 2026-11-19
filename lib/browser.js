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
  async snapshot(sessionId, { maxChars, maxElements } = {}) {
    const page = await this.pageFor(sessionId)
    const textLimit = maxChars ?? this.config.snapshotMaxChars ?? 4000
    const elementLimit = maxElements ?? this.config.maxElements ?? 80
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
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, limit);
      elements.forEach((el, index) => el.setAttribute(attribute, String(index)));
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
        elements: elements.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          label: label(el),
          value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value || '').slice(0, 100) : undefined,
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

  /** Click by visible text — a convenience for stable, human-readable targets. */
  async clickText(sessionId, text) {
    const snapshot = await this.snapshot(sessionId, { maxChars: 0 })
    const needle = text.trim().toLowerCase()
    const match =
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase() === needle) ??
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase().includes(needle))
    if (match === undefined) throw new Error(`no clickable element matching ${JSON.stringify(text)}`)
    const located = await this.click(sessionId, match.index)
    return { ...located, index: match.index }
  }

  /**
   * Focus an indexed field and insert text.
   *
   * The click is not decoration: `Input.insertText` is a silent no-op unless the
   * renderer has a focused text-accepting element, so the field is focused with
   * a real press/release pair first.
   */
  async type(sessionId, index, text, { submit = false } = {}) {
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
    if (text !== undefined && text !== '') await page.send('Input.insertText', { text })
    await sleep(60)
    if (submit) await this.press(sessionId, 'Enter')
    this.finishAction(sessionId)
    return { ...located, submitted: submit === true }
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
