#!/usr/bin/env node
/**
 * Host-half end-to-end smoke test.
 *
 * Drives `BrowserManager` directly against a real Chrome over raw CDP — no DSH
 * runtime, no Playwright, no X server. It is the acceptance check for the parts
 * the side panel depends on: a clean UA, nav/read/click/scroll effects emitted
 * in contract order, page-space boxes, screenshots, and a quiet run when
 * `effects:false`.
 *
 * Run:   node e2e/backend-smoke.mjs
 * Exit:  0 = PASS, 1 = FAIL (every failed check is named on stderr).
 *
 * Point it at another Chromium-family binary with `WEBPILOT_CHROME=/path/to/chrome`.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, normalizeAddress, sleep } from '../lib/browser.js'
import { HumanBroker } from '../lib/human.js'
import { defineTools } from '../lib/tools.js'

const CHROME = process.env.WEBPILOT_CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const SESSION = 'backend-smoke'
const LEAD_MS = 120
const DEBUG = process.env.WEBPILOT_SMOKE_DEBUG === '1'

const startedAt = Date.now()
let passed = 0
let failed = 0

/** One named assertion; failures never abort the run, they are counted. */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Quiet logger: warnings and errors only, unless WEBPILOT_SMOKE_DEBUG=1. */
function makeLogger(prefix) {
  return {
    info: (message) => DEBUG && console.log(`[${prefix}] ${message}`),
    debug: (message) => DEBUG && console.log(`[${prefix}] ${message}`),
    warn: (message) => console.error(`[${prefix} warn] ${message}`),
    error: (message) => console.error(`[${prefix} error] ${message}`),
  }
}

/** Collect fx events with timestamps and the Seq position they arrived at. */
function makeFxSink(sink) {
  return (sessionId, payload) => {
    sink.push({ at: Date.now(), sessionId, payload })
  }
}

async function main() {
  console.log('backend-smoke: host half against real Chrome (raw CDP, no DSH)')

  // The address bar's only rule: what does a typed string navigate to? Pure
  // function, so it is checked before any browser starts.
  const addressCases = [
    ['https://a.com/x', 'https://a.com/x'],
    ['http://a.com', 'http://a.com'],
    ['HTTPS://A.COM/P', 'HTTPS://A.COM/P'],
    ['example.com', 'https://example.com'],
    ['example.com/deep/path?q=1', 'https://example.com/deep/path?q=1'],
    ['example.com:8443', 'https://example.com:8443'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['[::1]:80', 'http://[::1]:80'],
    ['about:blank', 'about:blank'],
    ['', undefined],
    ['   ', undefined],
    ['hello', undefined],
    ['two words.com', undefined],
    ['javascript:alert(1)', undefined],
    ['file:///etc/passwd', undefined],
    ['user@mail.com', undefined],
    [undefined, undefined],
  ]
  for (const [input, expected] of addressCases) {
    const actual = normalizeAddress(input)
    check(`normalizeAddress(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, actual === expected, JSON.stringify(actual))
  }

  check('chrome binary exists', existsSync(CHROME), CHROME)
  if (!existsSync(CHROME)) throw new Error(`chrome not found: ${CHROME}`)

  const profileDir = await mkdtemp(join(tmpdir(), 'webpilot-smoke-'))
  const fx = []
  const manager = new BrowserManager({
    config: {
      browserPath: CHROME,
      profileDir,
      mode: 'headless',
      windowSize: '1280x800',
      viewport: '1280x800',
      startUrl: 'about:blank',
      snapshotMaxChars: 4000,
      maxElements: 60,
      idleShutdownMinutes: 0,
      effectLeadMs: LEAD_MS,
      effects: true,
    },
    logger: makeLogger('main'),
    onFx: makeFxSink(fx),
    onEvent: () => {},
  })
  let stopped = false
  try {
    // ---------------------------------------------------------- launch + UA
    const before = await manager.status(SESSION)
    check('no browser before first use', before.running === false)

    const record = await manager.ensureSession(SESSION, { label: 'smoke' })
    check('session tab opened', record !== undefined && manager.session(SESSION) !== undefined)

    const status = await manager.status(SESSION)
    check('chrome process is running', status.running === true)
    check('headless mode was used', status.mode === 'headless', String(status.mode))
    check(
      'reported UA is not HeadlessChrome',
      typeof status.userAgent === 'string' && !/HeadlessChrome/i.test(status.userAgent),
      status.userAgent,
    )
    check(
      'reported UA looks like a clean desktop Chrome',
      /Chrome\/\d+\.0\.0\.0/.test(String(status.userAgent)) && /Safari\/537\.36/.test(String(status.userAgent)),
      String(status.userAgent),
    )
    const liveUa = await manager.evaluate(SESSION, 'navigator.userAgent')
    check('page navigator.userAgent matches the launched UA', liveUa === status.userAgent, String(liveUa))

    // -------------------------------------------------------------- navigate
    const navMark = fx.length
    const navT0 = Date.now()
    await manager.navigate(SESSION, 'https://example.com/')
    const navResolvedAt = Date.now()
    const navElapsed = navResolvedAt - navT0
    const navEvents = fx.slice(navMark).filter((event) => event.payload.kind === 'nav')
    check('navigate emits nav start then nav done', navEvents.length === 2 && navEvents[0].payload.phase === 'start' && navEvents[1].payload.phase === 'done')
    check(
      'nav start is emitted before the load begins',
      navEvents.length > 0 && navEvents[0].at - navT0 < LEAD_MS + 80 && navEvents[0].at < navEvents[1]?.at,
      `start+${navEvents[0]?.at - navT0}ms done+${navEvents[1]?.at - navT0}ms`,
    )
    check('nav events carry url + tool', navEvents.every((event) => event.payload.tool === 'webpilot_navigate' && String(event.payload.url).startsWith('https://example.com')))
    check('navigate waited for the effect lead', navElapsed >= LEAD_MS, `elapsed=${navElapsed}ms`)
    const pageInfo = JSON.parse(await manager.evaluate(SESSION, 'JSON.stringify({ url: location.href, title: document.title })'))
    check('page really loaded example.com', pageInfo.url.startsWith('https://example.com') && /Example Domain/.test(pageInfo.title), JSON.stringify(pageInfo))

    // -------------------------------------------------------------- snapshot
    const readMark = fx.length
    const snapshot = await manager.snapshot(SESSION, { maxChars: 2500 })
    check(
      'snapshot keeps the baseline keys',
      typeof snapshot.title === 'string' && typeof snapshot.url === 'string' && Array.isArray(snapshot.elements) && typeof snapshot.text === 'string',
    )
    check('snapshot returns page text', typeof snapshot.text === 'string' && snapshot.text.trim().length > 50, `chars=${snapshot.text?.length}`)
    check(
      'every interactive element has a page-space box',
      snapshot.elements.length > 0
        && snapshot.elements.every((element) => element.box !== undefined && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(element.box[key]))),
      `elements=${snapshot.elements.length}`,
    )
    check(
      'snapshot returns visible text blocks',
      Array.isArray(snapshot.blocks)
        && snapshot.blocks.length > 0
        && snapshot.blocks.every((block) => Number.isFinite(block.x) && Number.isFinite(block.y) && block.w >= 12 && block.h >= 8 && block.x + block.w > 0 && block.y + block.h > 0),
      `blocks=${snapshot.blocks?.length}`,
    )
    const readEvent = fx.slice(readMark).find((event) => event.payload.kind === 'read')
    check('snapshot emits one read effect', readEvent !== undefined)
    check(
      'read effect carries title, url and tool',
      readEvent?.payload.tool === 'webpilot_snapshot'
        && typeof readEvent?.payload.title === 'string'
        && String(readEvent?.payload.url).startsWith('https://example.com'),
    )
    const readBoxes = readEvent?.payload.boxes ?? []
    check('read effect boxes include element regions', readBoxes.some((box) => box.kind === 'element' && Number.isFinite(box.x) && Number.isFinite(box.w)))
    check('read effect boxes include text regions', readBoxes.some((box) => box.kind === 'text' && Number.isFinite(box.x) && Number.isFinite(box.w)))
    check('read effect box count is bounded', readBoxes.length > 0 && readBoxes.length <= 80, `boxes=${readBoxes.length}`)

    // ----------------------------------------------------------------- click
    // Test fixture: a same-page button so the click assertion cannot depend on
    // the network. The plugin itself never injects anything into a page — this
    // only exists inside the smoke page.
    await manager.evaluate(
      SESSION,
      `(() => {
        const button = document.createElement('button');
        button.id = 'webpilot-smoke-button';
        button.textContent = 'Smoke Click';
        button.style.cssText = 'position:fixed;left:40px;top:80px;z-index:2147483647;padding:8px 16px';
        button.addEventListener('click', () => { window.__webpilotSmokeClicks = (window.__webpilotSmokeClicks ?? 0) + 1 });
        document.body.append(button);
        return 'appended';
      })()`,
    )
    const inventory = await manager.snapshot(SESSION, { maxChars: 0, maxElements: 60 })
    const target = inventory.elements.find((element) => element.label === 'Smoke Click')
    check('injected button appears in the element inventory', target !== undefined, `elements=${inventory.elements.length}`)
    if (target !== undefined) {
      const clickMark = fx.length
      const clickT0 = Date.now()
      const clickResult = await manager.click(SESSION, target.index)
      const clickResolvedAt = Date.now()
      const clickEvent = fx.slice(clickMark).find((event) => event.payload.kind === 'click')
      check('click emits a click effect with tool + coords', clickEvent !== undefined && clickEvent.payload.tool === 'webpilot_click' && Number.isFinite(clickEvent.payload.x) && Number.isFinite(clickEvent.payload.y))
      check(
        'click effect carries the target box and label',
        ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(clickEvent?.payload.box?.[key])) && clickEvent?.payload.label === 'Smoke Click',
        JSON.stringify(clickEvent?.payload),
      )
      check('click effect is emitted before the click settles', clickEvent !== undefined && clickResolvedAt - clickEvent.at >= LEAD_MS - 20, `lead=${clickResolvedAt - (clickEvent?.at ?? clickResolvedAt)}ms`)
      check('click delayed the action by the effect lead', clickResolvedAt - clickT0 >= LEAD_MS, `elapsed=${clickResolvedAt - clickT0}ms`)
      check('page actually received the click', (await manager.evaluate(SESSION, 'window.__webpilotSmokeClicks ?? 0')) === 1)
      check('click result keeps the page-space box', clickResult.box !== undefined && Number.isFinite(clickResult.box.w) && clickResult.box.w > 0)
    }

    // ---------------------------------------------------------------- scroll
    const scrollMark = fx.length
    await manager.scroll(SESSION, 'down', { pixels: 400 })
    const scrollEvent = fx.slice(scrollMark).find((event) => event.payload.kind === 'scroll')
    check(
      'scroll emits a scroll effect with direction and delta',
      scrollEvent?.payload.tool === 'webpilot_scroll' && scrollEvent?.payload.direction === 'down' && scrollEvent?.payload.dy === 400,
      JSON.stringify(scrollEvent?.payload),
    )

    // ------------------------------------------------------------ screenshot
    const shot = await manager.screenshot(SESSION)
    check('screenshot returns real PNG bytes', shot.mediaType === 'image/png' && shot.data.length > 1000 && shot.data[0] === 0x89 && shot.data.toString('ascii', 1, 4) === 'PNG', `bytes=${shot.data.length}`)

    // ------------------------------------------------------------------ idle
    await new Promise((resolve) => setTimeout(resolve, 900))
    const last = fx[fx.length - 1]
    check('last effect after the action settles is idle', last?.payload.kind === 'idle', String(last?.payload.kind))
    check('every effect is scoped to the acting session', fx.every((event) => event.sessionId === SESSION))

    // ---------------------------------------- drag / wait / href / handover
    // Four capabilities that the price-comparison run showed missing: link
    // hrefs in the inventory, a real drag, a conditional wait, and a handover
    // that keeps an expired QR alive and reports whether the login landed.
    // Everything here runs on injected fixtures over about:blank, so no check
    // depends on the network.
    await manager.navigate(SESSION, 'about:blank')

    await manager.evaluate(
      SESSION,
      `(() => {
        const anchor = document.createElement('a');
        anchor.href = 'https://example.com/with-token?xsec_token=abc';
        anchor.textContent = 'Href Probe';
        anchor.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647';
        document.body.append(anchor);
        return 'ok';
      })()`,
    )
    const hrefSnapshot = await manager.snapshot(SESSION, { maxChars: 0, maxElements: 40 })
    const hrefTarget = hrefSnapshot.elements.find((element) => element.label === 'Href Probe')
    check(
      'snapshot exposes absolute href on links',
      hrefTarget?.href === 'https://example.com/with-token?xsec_token=abc',
      JSON.stringify(hrefTarget),
    )

    // A drag is only credible to a slider CAPTCHA when it is press → several
    // button-held moves → release, so the fixture records exactly that.
    await manager.evaluate(
      SESSION,
      `(() => {
        const zone = document.createElement('div');
        zone.id = 'drag-zone';
        zone.style.cssText = 'position:fixed;left:120px;top:240px;width:240px;height:48px;background:#ccd;z-index:2147483647';
        window.__webpilotDrag = { down: 0, moves: 0, movesHeld: 0, up: 0, lastX: 0 };
        zone.addEventListener('mousedown', (event) => {
          window.__webpilotDrag.down += 1;
          window.__webpilotDrag.lastX = event.clientX;
        });
        zone.addEventListener('mousemove', (event) => {
          window.__webpilotDrag.moves += 1;
          if (event.buttons === 1) window.__webpilotDrag.movesHeld += 1;
        });
        zone.addEventListener('mouseup', (event) => {
          window.__webpilotDrag.up += 1;
          window.__webpilotDrag.lastX = event.clientX;
        });
        document.body.append(zone);
        return 'ok';
      })()`,
    )
    const dragMark = fx.length
    const dragResult = await manager.drag(SESSION, { x: 140, y: 264 }, { x: 336, y: 264 }, { steps: 10, durationMs: 200 })
    const dragState = JSON.parse(await manager.evaluate(SESSION, 'JSON.stringify(window.__webpilotDrag)'))
    const dragEvents = fx.slice(dragMark)
    const dragPressFx = dragEvents.filter((event) => event.payload.kind === 'click')
    const dragTrailFx = dragEvents.filter((event) => event.payload.kind === 'drag')
    check('drag dispatches press and release once', dragState.down === 1 && dragState.up === 1, JSON.stringify(dragState))
    check('drag moves with the button held down', dragState.movesHeld >= 8, JSON.stringify(dragState))
    check('drag ends on the requested coordinate', Math.abs(dragState.lastX - 336) <= 2, String(dragState.lastX))
    check('drag marks the press with one click effect', dragPressFx.length === 1, `${dragPressFx.length}`)
    check(
      'drag emits a trail effect with from/to/duration',
      dragTrailFx.length === 1
        && dragTrailFx[0].payload.from?.x === 140
        && dragTrailFx[0].payload.to?.x === 336
        && Number.isFinite(dragTrailFx[0].payload.durationMs),
      JSON.stringify(dragTrailFx[0]?.payload),
    )
    check('drag returns from/to', dragResult.from.x === 140 && dragResult.to.x === 336 && dragResult.steps === 10)

    // A conditional wait is the whole point: the node shows up 500ms late.
    await manager.evaluate(
      SESSION,
      `(() => {
        window.setTimeout(() => {
          const late = document.createElement('div');
          late.id = 'late-node';
          late.textContent = 'LATE_MARKER';
          late.style.cssText = 'position:fixed;left:20px;top:120px';
          document.body.append(late);
        }, 500);
        return 'armed';
      })()`,
    )
    const lateWait = await manager.waitFor(SESSION, { text: 'LATE_MARKER', timeoutMs: 4000, pollMs: 100 })
    check('wait resolves on text that appears late', lateWait.matched === true && lateWait.element?.label === 'LATE_MARKER', JSON.stringify(lateWait.element))
    check('wait reports the real elapsed time', lateWait.waitedMs >= 400, `${lateWait.waitedMs}ms`)
    const timeoutWait = await manager.waitFor(SESSION, { text: 'NEVER_THERE', timeoutMs: 400, pollMs: 100 })
    check('wait times out with matched:false instead of throwing', timeoutWait.matched === false && timeoutWait.timedOut === true)
    await manager.evaluate(SESSION, "(() => { document.querySelector('#late-node')?.remove(); return 'ok' })()")
    const goneWait = await manager.waitFor(SESSION, { selector: '#late-node', gone: true, timeoutMs: 1000, pollMs: 80 })
    check('wait can wait for something to disappear', goneWait.matched === true)

    // Handover fixture: an expired QR with a refresh control, plus a login CTA
    // so loginState has something to report before the "human" logs in. It runs
    // on a real https origin because the fixture needs to write a cookie.
    await manager.navigate(SESSION, 'https://example.com/')
    await manager.evaluate(
      SESSION,
      `(() => {
        document.body.innerHTML = '';
        window.__qrRefreshes = 0;
        const stale = document.createElement('div');
        stale.id = 'qr-text';
        stale.textContent = '二维码失效，点击刷新';
        stale.style.cssText = 'position:fixed;left:40px;top:60px';
        const refresh = document.createElement('button');
        refresh.textContent = '点击刷新';
        refresh.style.cssText = 'position:fixed;left:40px;top:100px';
        refresh.addEventListener('click', () => {
          window.__qrRefreshes += 1;
          stale.textContent = '请扫码登录';
        });
        const cta = document.createElement('a');
        cta.href = '#login';
        cta.textContent = '登录';
        cta.style.cssText = 'position:fixed;left:40px;top:140px';
        document.body.append(stale, refresh, cta);
        return 'ok';
      })()`,
    )
    const human = new HumanBroker({ onEvent: () => {} })
    const toolList = defineTools({
      manager,
      human,
      hub: { pushState: async () => {}, sync: async () => {} },
      config: { askHumanTimeoutSeconds: 30 },
      getAttachments: () => undefined,
      logger: makeLogger('tools'),
      getPanelAvailable: () => true,
    })
    const byName = new Map(toolList.map((tool) => [tool.name, tool]))
    check('drag and wait are registered as tools', byName.has('webpilot_drag') && byName.has('webpilot_wait'))

    const pending = byName.get('webpilot_ask_human').execute({ instruction: '扫码登录', timeoutSeconds: 30 }, { agent: { id: SESSION } })
    await sleep(1200)
    const request = human.snapshot(SESSION)
    const refreshesBeforeDone = await manager.evaluate(SESSION, 'window.__qrRefreshes ?? 0')
    check('ask_human re-requests an expired QR before the human looks', refreshesBeforeDone >= 1, String(refreshesBeforeDone))
    // The "human" comes back having logged in: a new cookie and account nav.
    await manager.evaluate(
      SESSION,
      `(() => {
        document.cookie = 'webpilot_smoke_session=1; path=/';
        document.body.innerHTML = '';
        const nav = document.createElement('div');
        nav.textContent = '我的订单 退出登录';
        nav.style.cssText = 'position:fixed;left:40px;top:60px';
        document.body.append(nav);
        return 'ok';
      })()`,
    )
    human.done(request?.id)
    const handover = await pending
    check('ask_human reports how many QR refreshes it did', handover.qrRefreshes >= 1, String(handover.qrRefreshes))
    check('ask_human reports loggedIn:true after the login', handover.loginState?.loggedIn === true, JSON.stringify(handover.loginState))
    check(
      'ask_human login evidence names the signal',
      Array.isArray(handover.loginState?.signals) && handover.loginState.signals.length > 0 && typeof handover.loginState.reason === 'string',
      JSON.stringify(handover.loginState),
    )

    // Regression from the live-site run: bilibili's logged-out page carries both
    // a 登录 button and a [class*=avatar] placeholder image, so a stray avatar
    // must not be able to call it "logged in".
    await manager.evaluate(
      SESSION,
      `(() => {
        document.body.innerHTML = '';
        const avatar = document.createElement('img');
        avatar.className = 'user-avatar';
        avatar.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
        avatar.style.cssText = 'position:fixed;left:10px;top:10px;width:16px;height:16px';
        const cta = document.createElement('a');
        cta.href = '#login';
        cta.textContent = '登录';
        cta.style.cssText = 'position:fixed;left:60px;top:10px';
        document.body.append(avatar, cta);
        return 'ok';
      })()`,
    )
    const negativePending = byName.get('webpilot_ask_human').execute({ instruction: 'noop', timeoutSeconds: 5 }, { agent: { id: SESSION } })
    await sleep(600)
    human.done(human.snapshot(SESSION)?.id)
    const negative = await negativePending
    check(
      'a visible login CTA wins over a stray avatar',
      negative.loginState?.loggedIn === false && negative.loginState.reason === 'login-cta',
      JSON.stringify(negative.loginState),
    )

    // -------------------------------------------------------- effects:false
    const quietDir = await mkdtemp(join(tmpdir(), 'webpilot-smoke-quiet-'))
    const quietFx = []
    const quiet = new BrowserManager({
      config: {
        browserPath: CHROME,
        profileDir: quietDir,
        mode: 'headless',
        windowSize: '1280x800',
        viewport: '1280x800',
        idleShutdownMinutes: 0,
        effects: false,
      },
      logger: makeLogger('quiet'),
      onFx: makeFxSink(quietFx),
      onEvent: () => {},
    })
    try {
      await quiet.ensureSession('quiet-session', { label: 'quiet' })
      const quietSnapshot = await quiet.snapshot('quiet-session', { maxChars: 200 })
      await quiet.scroll('quiet-session', 'down')
      const quietShot = await quiet.screenshot('quiet-session')
      check('effects:false still performs a snapshot', Array.isArray(quietSnapshot.elements))
      check('effects:false still performs a screenshot', quietShot.data.length > 1000)
      check('effects:false emits no effects at all', quietFx.length === 0, `${quietFx.length} events`)
    } finally {
      await quiet.stop({ keepProfile: false }).catch(() => {})
      await rm(quietDir, { recursive: true, force: true })
    }

    // --------------------------------------------------------------- teardown
    await manager.closeSession(SESSION)
    check('session tab closed', manager.session(SESSION) === undefined)
    await manager.stop({ keepProfile: false })
    stopped = true
    const finalStatus = await manager.status()
    check('browser stopped cleanly', finalStatus.running === false)
    check('profile directory removed', !existsSync(profileDir))
  } finally {
    if (!stopped) {
      await manager.stop({ keepProfile: false }).catch(() => {})
      await rm(profileDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main()
  .then(() => {
    const elapsed = Date.now() - startedAt
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} backend-smoke — ${passed} passed, ${failed} failed in ${elapsed}ms`)
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(`\nFAIL backend-smoke — ${error.stack ?? error.message}`)
    process.exit(1)
  })
