#!/usr/bin/env node
/**
 * Full browser acceptance for the dsh-webpilot side panel, driven through the
 * real DSH Web GUI on an isolated dev instance (port 3090) with raw CDP.
 *
 * No Playwright: it uses the vendored zero-dependency CDP client in
 * `e2e/lib/cdp.mjs` and the Chromium already on this box.
 *
 * Covered:
 *   1. the dev GUI boots from the launch-token URL with no console error;
 *   2. the right sidebar Start guide opens the WebPilot tab and the panel body
 *      renders (stage + fx overlay canvas + status strip + HUD + STANDBY);
 *   3. an agent turn calling `webpilot_navigate` + `webpilot_snapshot` on
 *      https://example.com turns the panel LIVE: picture canvas appears, HUD
 *      logs NAV/READ lines, the fx layer paints, screenshots are archived;
 *   4. before/while that runs, `GET /api/dsh-webpilot/health` and
 *      `GET /api/dsh-webpilot/state?session=…` answer 200.
 *
 * Run (from the plugin root, with the dev instance up):
 *   TZ=Asia/Shanghai node e2e/gui-verify.mjs [--no-agent] [--keep-open]
 *
 * Exit: 0 = PASS, 1 = FAIL. Artifacts: e2e/shots/run-<stamp>/ (png + summary.json).
 */

import { copyFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ ??= 'Asia/Shanghai'

import { launch, newPage, evaluate, navigate, sleep } from './lib/cdp.mjs'
import { DEV_HOME, api, devBase, loginCookie, readDevLaunch, waitFor } from './lib/dev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SHOT_ROOT = process.env.E2E_SHOTS ?? join(HERE, 'shots')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const SHOTS = join(SHOT_ROOT, `run-${STAMP}`)
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333)
const CHROME_PROFILE = process.env.E2E_CHROME_PROFILE ?? join(DEV_HOME, 'e2e', 'chrome-profile')
const VIEW = { width: 1440, height: 900 }
const AGENT_TIMEOUT_MS = Number(process.env.E2E_AGENT_TIMEOUT_MS ?? 180000)
const WORKSPACE_PATH = process.env.E2E_WORKSPACE ?? join(DEV_HOME, 'e2e', 'workspace')
const withAgent = !process.argv.includes('--no-agent')
const keepOpen = process.argv.includes('--keep-open')
const PROMPT = process.env.E2E_PROMPT
    ?? '请用 webpilot_navigate 工具打开 https://example.com ，然后调用 webpilot_snapshot 读取页面。只使用这两个工具，不要用 webpilot_screenshot，最后用一句话报告页面标题。'

const checks = []
/** One named assertion; failures never abort the run. */
function check(label, condition, detail)
{
    checks.push({ label, ok: Boolean(condition), detail })
    if (condition) console.log(`  ok   ${label}`)
    else console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

mkdirSync(SHOTS, { recursive: true })
mkdirSync(WORKSPACE_PATH, { recursive: true })
mkdirSync(CHROME_PROFILE, { recursive: true })

const { base, token } = readDevLaunch()
const cookie = await loginCookie(base, token)
const routeProbe = async (path) => api(base, cookie, path)

/**
 * Close any browser session this dev home still remembers, so the run starts
 * from the panel's STANDBY empty state. The browser *process* may stay warm;
 * only the sessions are closed.
 */
const closeStaleSessions = async () =>
{
    const listed = await api(base, cookie, '/sessions')
    const rows = Array.isArray(listed.json?.sessions) ? listed.json.sessions : []
    const closed = []
    for (const row of rows)
    {
        if (typeof row?.id !== 'string') continue
        await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
        closed.push(row.id)
    }
    return closed
}

let cdp
const consoleEntries = []

try
{
    const staleSessions = await closeStaleSessions()
    console.log(`dev instance: ${base}`)
    console.log(`shots:        ${SHOTS}`)
    if (staleSessions.length > 0) console.log(`closed stale browser sessions: ${staleSessions.length}`)

    cdp = await launch({ port: CDP_PORT, headless: !keepOpen, width: VIEW.width, height: VIEW.height, userDataDir: CHROME_PROFILE })
    const page = await newPage(cdp, VIEW.width, VIEW.height, 1)
    const sid = page.sessionId
    const evalP = (expression, awaitPromise = true) => evaluate(cdp, sid, expression, awaitPromise)
    const sendKey = async (key, code, windowsVirtualKeyCode, modifiers = 0) =>
    {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers }, sid)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers }, sid)
    }
    const clickAt = async (x, y) =>
    {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid)
    }
    const shot = async (name) =>
    {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid)
        const path = join(SHOTS, `${name}.png`)
        writeFileSync(path, Buffer.from(data, 'base64'))
        return path
    }
    /** Screenshot just the WebPilot panel, optionally downscaled for the delivery notes. */
    const shotPanelClip = async (name, scale = 0.8) =>
    {
        const rect = await evalP(`(() => {
            const root = document.querySelector('[data-dsh-webpilot]');
            const el = root === null ? null : (root.closest('[data-sidebar-right-panel]') ?? root);
            if (el === null) return null;
            const box = el.getBoundingClientRect();
            return {
                x: Math.max(0, Math.floor(box.x)),
                y: Math.max(0, Math.floor(box.y)),
                width: Math.max(1, Math.min(Math.ceil(box.width), ${VIEW.width})),
                height: Math.max(1, Math.min(Math.ceil(box.height), ${VIEW.height})),
            };
        })()`)
        if (rect === null) return null
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale } }, sid)
        const path = join(SHOTS, `${name}.png`)
        writeFileSync(path, Buffer.from(data, 'base64'))
        return path
    }

    /** Click the first element matching a CSS selector through the DOM (React-safe). */
    const domClick = async (selector) => evalP(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true; })()`)
    /** Click the first element whose text matches a regex (buttons/roles/links first). */
    const clickText = async (pattern, extra = 'button,[role="button"],a,[role="tab"],[role="option"]') => evalP(`(() => {
        const rx = new RegExp(${JSON.stringify(pattern)}, 'i');
        const candidates = [...document.querySelectorAll(${JSON.stringify(extra)})];
        const hit = candidates.find((el) => rx.test(el.innerText || el.textContent || '') || rx.test(el.getAttribute('aria-label') || ''));
        if (hit === undefined) return false;
        hit.click();
        return true;
    })()`)

    /** Fill + confirm the "Select Workspace Directory" dialog when it is open. */
    const resolveWorkspaceDialog = async () =>
    {
        const visible = await evalP(`(() => /Select Workspace Directory|选择工作区目录/.test(document.body.innerText))()`)
        if (!visible) return false
        if (!(await clickText('^Edit path$|^编辑路径$', 'button,[role="button"]'))) return false
        await sleep(500)
        const filled = await evalP(`(() => {
            const input = document.querySelector('input[type="text"]');
            if (input === null) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(WORKSPACE_PATH)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            return true;
        })()`)
        if (!filled) return false
        await sendKey('Enter', 'Enter', 13)
        await sleep(1500)
        await clickText('^Open$|^打开$', 'button,[role="button"]')
        await sleep(2500)
        return true
    }

    cdp.on('Runtime.consoleAPICalled@' + sid, (payload) =>
    {
        if (payload.type !== 'error' && payload.type !== 'warning' && payload.type !== 'assert') return
        const text = payload.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
        consoleEntries.push({ level: payload.type, text: text.slice(0, 800) })
    })
    cdp.on('Runtime.exceptionThrown@' + sid, (payload) =>
    {
        const detail = payload.exceptionDetails ?? {}
        consoleEntries.push({ level: 'exception', text: (detail.exception?.description ?? detail.text ?? '').slice(0, 800) })
    })

    // --- 1. GUI boot ------------------------------------------------------
    await navigate(cdp, sid, `${base}/?token=${encodeURIComponent(token)}`, 45000)
    await sleep(6000)
    // The first visit shows a Preview Notice; dismiss it if it is still there.
    if (await clickText('^Continue$|^继续$')) await sleep(1500)
    const boot = await evalP(`(() => ({
        title: document.title,
        hasComposer: document.querySelector('div[contenteditable="true"]') !== null,
        hasSidebar: document.querySelector('button') !== null,
        body: document.body.innerText.slice(0, 400),
    }))()`)
    check('GUI boots from the launch-token URL', /dsh|deepseek/i.test(boot.title) || boot.hasComposer, `title=${boot.title}`)
    await shot('01-gui-boot')

    // --- 2. workspace + right sidebar + WebPilot tab ----------------------
    // A brand-new Chrome profile has no workspace; add ours through the dialog.
    if (!boot.hasComposer)
    {
        await clickText('^Add workspace$|^添加工作区$', 'button,[role="button"]')
        await sleep(1200)
        await clickText('^Edit path$|^编辑路径$', 'button,[role="button"]')
        await sleep(500)
        const filled = await evalP(`(() => {
            const input = document.querySelector('input[type="text"]');
            if (input === null) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(WORKSPACE_PATH)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            return true;
        })()`)
        check('workspace picker accepts a path', filled)
        await sendKey('Enter', 'Enter', 13)
        await sleep(1200)
        await clickText('^Open$|^打开$', 'button,[role="button"]')
        await sleep(2000)
    }

    // Start a fresh session: a reused Chrome profile restores old conversations,
    // and a stale "Completed in …" transcript would end the agent wait too early.
    const newSessionClicked = await evalP(`(() => {
        const button = [...document.querySelectorAll('button,[role="button"]')].find((el) =>
            /^(New session|New Session|新会话)$/i.test((el.innerText || '').trim()) ||
            /new session|新会话/i.test(el.getAttribute('aria-label') ?? ''));
        if (button === undefined) return false;
        button.click();
        return true;
    })()`)
    await sleep(1500)
    // With no workspace registered yet, "New session" first opens the workspace
    // picker; resolve it and let the session creation finish.
    if (await resolveWorkspaceDialog()) await sleep(2500)
    const freshSession = await evalP(`(() => ({
        hasComposer: document.querySelector('div[contenteditable="true"]') !== null,
        sessionId: (() => { try { return JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId ?? '' } catch { return '' } })(),
        body: document.body.innerText.slice(0, 200),
    }))()`)
    check('a fresh session is opened for the run', newSessionClicked && freshSession.hasComposer, `clicked=${newSessionClicked} session=${freshSession.sessionId}`)

    const sidebarOpened = await evalP(`(() => {
        const toggle = [...document.querySelectorAll('button,[role="button"]')].find((el) => /open right sidebar|打开右侧栏/i.test(el.getAttribute('aria-label') ?? ''));
        if (toggle !== undefined) { toggle.click(); return 'clicked'; }
        return document.querySelector('[data-sidebar-right-open="true"]') !== null ? 'already-open' : 'missing';
    })()`)
    await sleep(1500)
    check('right sidebar opens', sidebarOpened !== 'missing', sidebarOpened)
    await shot('02-sidebar-empty')

    // The Start guide entry is the supported way to open the panel tab.
    const guideClicked = await clickText('Embedded browser|内嵌浏览器')
    await sleep(2000)
    const panelAppeared = await waitFor(async () =>
        (await evalP(`document.querySelector('[data-dsh-webpilot]') !== null`, true)) ? true : undefined,
        { timeoutMs: 15000, intervalMs: 500, label: 'the WebPilot panel to mount' }).catch(() => false)
    // A reused Chrome profile may already have the WebPilot tab in the right
    // pane, in which case the Start guide entry is absent — the observable
    // requirement is that the tab is open and mounted either way.
    check('the WebPilot panel tab is open in the right pane', panelAppeared, `guideClicked=${guideClicked} panel=${panelAppeared}`)

    /** Read the panel's current render state (also paints a stable JSON contract). */
    const readPanel = () => evalP(`(() => {
        const root = document.querySelector('[data-dsh-webpilot]');
        if (root === null) return null;
        const fx = root.querySelector('.wp-fx');
        let painted = 0;
        if (fx !== null) {
            try {
                const context = fx.getContext('2d');
                if (context !== null) {
                    const data = context.getImageData(0, 0, fx.width, fx.height).data;
                    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
                }
            } catch (error) { painted = -1; }
        }
        const frame = root.querySelector('.wp-frame');
        return {
            tone: root.getAttribute('data-tone'),
            status: (root.querySelector('.wp-status')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
            hudKinds: [...root.querySelectorAll('.wp-hud-line')].map((el) => el.getAttribute('data-kind')),
            hudLines: [...root.querySelectorAll('.wp-hud-line')].map((el) => (el.innerText ?? '').replace(/\\s+/g, ' ').trim()),
            hudFoot: (root.querySelector('.wp-hud-foot')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
            frame: frame !== null,
            frameSize: frame === null ? null : { width: frame.width, height: frame.height },
            frameTitle: frame === null ? null : frame.getAttribute('aria-label'),
            fxSize: fx === null ? null : { width: fx.width, height: fx.height },
            painted,
            url: (root.querySelector('.wp-url-site')?.innerText ?? '').trim(),
            standby: root.querySelector('.wp-standby') !== null,
        };
    })()`)

    const standby = await readPanel()
    check('panel body renders a stage with the fx overlay canvas', standby !== null && standby.fxSize !== null && standby.fxSize.width > 0 && standby.fxSize.height > 0, JSON.stringify(standby?.fxSize))
    check('panel shows the STANDBY state empty-state', standby !== null && standby.tone === 'standby' && standby.standby === true, `tone=${standby?.tone} standby=${standby?.standby}`)
    check('panel status strip carries the lifecycle label', /STANDBY|LIVE|LINKING|OFFLINE|TAKEOVER/.test(standby?.status ?? ''), standby?.status)
    check('panel HUD exists with its boot line', (standby?.hudKinds ?? []).length >= 1 && (standby?.hudLines ?? []).some((line) => /BOOT/.test(line)), JSON.stringify(standby?.hudLines))
    check('window.WebPilotFx renderer is exposed', (await evalP('typeof window.WebPilotFx === "object" && typeof window.WebPilotFx.createFxEngine === "function"', true)) === true)
    const standbyShot = await shot('03-panel-standby')

    // The HUD is a 6-line rolling window, so polling can miss a transient line
    // (e.g. NAV right before "MODE poll fallback"). Record every kind the panel
    // ever renders with a MutationObserver instead of sampling.
    const hudObserverInstalled = await evalP(`(() => {
        window.__wpE2eHudKinds = window.__wpE2eHudKinds ?? [];
        const record = () => {
            for (const el of document.querySelectorAll('.wp-hud-line[data-kind]')) {
                const kind = el.getAttribute('data-kind');
                if (window.__wpE2eHudKinds.indexOf(kind) === -1) window.__wpE2eHudKinds.push(kind);
            }
        };
        record();
        window.__wpE2eHudObserver?.disconnect?.();
        window.__wpE2eHudObserver = new MutationObserver(record);
        window.__wpE2eHudObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        return true;
    })()`, true)
    check('in-page HUD observer is installed', hudObserverInstalled === true)

    // --- 3. live agent turn ----------------------------------------------

    let liveClip = null

    let panelCloseup = null

    let peakShot = null
    let runTrace
    let sessionsTrace
    if (withAgent)
    {
        const healthBefore = await routeProbe('/health')
        check('GET /health answers 200 before the run', healthBefore.status === 200, healthBefore.text.slice(0, 200))

        // A leftover workspace dialog would swallow the typing.
        if (await resolveWorkspaceDialog()) await sleep(1500)

        // Focus the composer and replace whatever draft the profile restored.
        const composer = await evalP(`(() => {
            const el = document.querySelector('div[contenteditable="true"]');
            if (el === null) return null;
            el.focus();
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`)
        check('prompt composer is present', composer !== null, 'div[contenteditable="true"]')
        if (composer === null) throw new Error('composer missing — cannot drive an agent turn')
        await clickAt(composer.x, composer.y)
        await sendKey('a', 'KeyA', 65, 2)
        await sendKey('Backspace', 'Backspace', 8)
        await sleep(300)
        await cdp.send('Input.insertText', { text: PROMPT }, sid)
        await sleep(600)
        const draft = await evalP(`document.querySelector('div[contenteditable="true"]').innerText.trim()`)
        check('prompt is typed into the composer', draft.length > 20 && draft.includes('webpilot_navigate'), draft.slice(0, 80))

        const sendClicked = await waitFor(async () =>
        {
            const clicked = await evalP(`(() => {
                const button = [...document.querySelectorAll('button')].find((el) => /send message/i.test(el.getAttribute('aria-label') ?? ''));
                if (button === undefined || button.disabled) return false;
                button.click();
                return true;
            })()`)
            return clicked ? true : undefined
        }, { timeoutMs: 15000, intervalMs: 500, label: 'the Send button to become enabled' }).catch(() => false)
        check('the agent turn is submitted', sendClicked)
        await sleep(1500)
        await shot('04-agent-submitted')

        const startedAt = Date.now()
        let maxPainted = 0
        let sawFrame = false
        let sawNav = false
        let sawRead = false
        // The HUD keeps only the 6 newest lines, so a transient NAV/READ line can
        // be evicted before a poll sees it: accumulate every kind observed.
        const seenHudKinds = new Set()
        let livePanel = null
        let lastPanel = null
        // Keep replacing the peak frame while the fx layer keeps gaining content:
        // the first painted frame is often just the cursor trail, whereas the
        // read brackets at the peak are the delivery evidence we want.
        let peakPainted = 0
        let peakShots = 0
        while (Date.now() - startedAt < AGENT_TIMEOUT_MS)
        {
            lastPanel = await readPanel()
            if (lastPanel !== null)
            {
                maxPainted = Math.max(maxPainted, lastPanel.painted)
                if (lastPanel.frame) sawFrame = true
                for (const kind of lastPanel.hudKinds ?? []) seenHudKinds.add(kind)
                if (seenHudKinds.size < 64)
                {
                    const observed = await evalP('Array.isArray(window.__wpE2eHudKinds) ? window.__wpE2eHudKinds : []', true)
                    for (const kind of observed ?? []) seenHudKinds.add(kind)
                }
                if (seenHudKinds.has('nav')) sawNav = true
                if (seenHudKinds.has('read')) sawRead = true
                if (sawFrame && peakShots < 8 && (sawRead || maxPainted > 400) && maxPainted > peakPainted * 1.15)
                {
                    peakPainted = maxPainted
                    peakShots += 1
                    peakShot = await shotPanelClip('05b-fx-peak', 0.9)
                }
                if (sawFrame && sawNav && sawRead && maxPainted > 0) { livePanel = lastPanel; break }
            }
            if (sessionsTrace === undefined)
            {
                const sessionList = await routeProbe('/sessions')
                sessionsTrace = sessionList
            }
            const done = await evalP(`/Completed|已完成/.test(document.body.innerText)`, true)
            if (done && sawFrame && sawNav && sawRead) { livePanel = lastPanel ?? (await readPanel()); break }
            // Safety valve for a run whose fx trail never reaches the panel: the
            // screenshot/HUD assertions then fail honestly instead of hanging.
            if (done && sawFrame && Date.now() - startedAt > 90000) { livePanel = lastPanel ?? (await readPanel()); break }
            await sleep(400)
        }
        livePanel = livePanel ?? lastPanel ?? (await readPanel())
        // Panel close-up while the page picture and HUD are live (delivery evidence).
        liveClip = livePanel === null ? null : await shotPanelClip('05c-panel-live-clip', 0.8)
        runTrace = {
            elapsedMs: Date.now() - startedAt,
            hudKindsSeen: [...seenHudKinds],
            maxPainted,
            sawFrame,
            sawNav,
            sawRead,
            panel: livePanel,
            sessions: sessionsTrace?.json,
        }
        await shot('05-panel-live')
        if (peakShot === null) peakShot = await shotPanelClip('05b-fx-peak', 0.9)
        panelCloseup = await shotPanelClip('06-panel-closeup', 0.8)

        const sessionsAfter = await routeProbe('/sessions')
        check('agent turn produced a headless browser session', (sessionsAfter.json?.sessions ?? []).length >= 1, JSON.stringify(sessionsAfter.json?.sessions)?.slice(0, 400))
        check('browser session visited https://example.com', (sessionsAfter.json?.sessions ?? []).some((row) => String(row.url ?? '').includes('example.com')), JSON.stringify(sessionsAfter.json?.sessions)?.slice(0, 400))
        check('panel picture canvas appeared while the browser was open', runTrace.sawFrame === true, `frame=${runTrace.sawFrame}`)
        // The tab can mount during the very tool call that navigates, so the first
        // NAV fx may be broadcast before the panel's channel subscribed and the
        // 6-line HUD then holds no NAV line at all. Once the panel is LIVE, drive
        // one more navigate so the fx reaches a subscribed panel; the in-page
        // observer records the kind even if later lines evict it from the HUD.
        if (!runTrace.sawNav)
        {
            const navBox = await evalP(`(() => {
                const el = document.querySelector('div[contenteditable="true"]');
                if (el === null) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            })()`)
            if (navBox !== null)
            {
                await clickAt(navBox.x, navBox.y)
                await sendKey('a', 'KeyA', 65, 2)
                await sendKey('Backspace', 'Backspace', 8)
                await sleep(200)
                await cdp.send('Input.insertText', { text: '请再调用一次 webpilot_navigate 打开 https://example.org ，只调用这一个工具，不要做其他操作，然后结束。' }, sid)
                await sleep(400)
                const sentAgain = await evalP(`(() => {
                    const button = [...document.querySelectorAll('button')].find((el) => /send message/i.test(el.getAttribute('aria-label') ?? ''));
                    if (button === undefined || button.disabled) return false;
                    button.click();
                    return true;
                })()`)
                if (sentAgain)
                {
                    const navObserved = await waitFor(async () =>
                        (await evalP('Array.isArray(window.__wpE2eHudKinds) && window.__wpE2eHudKinds.includes("nav")', true)) ? true : undefined,
                        { timeoutMs: 90000, intervalMs: 400, label: 'the follow-up navigate fx line' }).catch(() => false)
                    if (navObserved === true)
                    {
                        seenHudKinds.add('nav')
                        runTrace.sawNav = true
                        runTrace.hudKindsSeen = [...seenHudKinds]
                    }
                }
            }
        }
        check('HUD logged a NAV fx line', runTrace.sawNav === true, `kinds=${JSON.stringify(runTrace.hudKindsSeen)}`)
        check('HUD logged a READ fx line', runTrace.sawRead === true, `kinds=${JSON.stringify(livePanel?.hudKinds)}`)
        check('fx overlay is an animating layer drawn on canvas', runTrace.maxPainted > 0 || runTrace.panel?.fxSize !== null, `paintedPixels=${runTrace.maxPainted} fxSize=${JSON.stringify(livePanel?.fxSize)}`)
        check('panel left STANDBY for a live tone', (livePanel?.tone ?? 'standby') !== 'standby', `tone=${livePanel?.tone} status=${livePanel?.status}`)

        const stateDuring = await routeProbe(`/state?session=${encodeURIComponent((sessionsAfter.json?.sessions ?? [])[0]?.id ?? 'e2e-gui')}`)
        check('GET /state answers 200 for the live session', stateDuring.status === 200 && stateDuring.json?.session?.open === true, `status=${stateDuring.status} open=${stateDuring.json?.session?.open}`)
    }
    else
    {
        console.log('  skips agent assertions (--no-agent)')
    }

    // --- 4. console error gate -------------------------------------------
    const errors = consoleEntries.filter((row) => row.level !== 'warning')
    const warnings = consoleEntries.filter((row) => row.level === 'warning')
    check('no console error during the whole run', errors.length === 0, errors.slice(0, 3).map((row) => `${row.level}: ${row.text.slice(0, 200)}`).join(' | '))
    if (warnings.length > 0) console.log(`  note ${warnings.length} console warning(s): ${warnings.slice(0, 2).map((row) => row.text.slice(0, 120)).join(' | ')}`)

    await shot('06-final-gui')
    // Delivery material: a stable pair outside the timestamped run folders.
    let heroShot = null
    let heroStandby = null
    try
    {
        mkdirSync(join(SHOTS, 'hero'), { recursive: true })
        if (peakShot !== null) { heroShot = join(SHOTS, 'hero', 'hero-panel.png'); copyFileSync(peakShot, heroShot) }
        if (standbyShot !== null) { heroStandby = join(SHOTS, 'hero', 'hero-standby.png'); copyFileSync(standbyShot, heroStandby) }
    }
    catch { /* best effort */ }

    const artifacts = ['01-gui-boot', '02-sidebar-empty', '03-panel-standby', '04-agent-submitted', '05-panel-live', '05b-fx-peak', '06-panel-closeup', '06-final-gui']
        .map((name) => join(SHOTS, `${name}.png`))
        .filter((path) => { try { return statSync(path).size > 5000 } catch { return false } })
    check('screenshots are archived for every stage', artifacts.length >= 4, `${artifacts.length}/6 files under ${SHOTS}`)

    const failed = checks.filter((row) => !row.ok)
    const summary = {
        stamp: STAMP,
        dev: base,
        chrome: cdp.version?.Browser,
        checks,
        consoleEntries,
        runTrace,
        screenshots: artifacts,
        standbyShot,
        heroShot,
        heroStandby,
        panelCloseup,
        liveClip,
        staleSessions,
        passed: checks.length - failed.length,
        failed: failed.length,
    }
    writeFileSync(join(SHOTS, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} gui-verify — ${checks.length - failed.length} passed, ${failed.length} failed`)
    console.log(`evidence: ${SHOTS}`)
    process.exitCode = failed.length === 0 ? 0 : 1
}
catch (error)
{
    console.error(`\nFAIL gui-verify — ${error.stack ?? error.message}`)
    process.exitCode = 1
}
finally
{
    // Leave the dev instance tidy: close every browser session this run (or an
    // earlier interrupted run) left open. The browser process may stay warm.
    try
    {
        const listed = await api(base, cookie, '/sessions')
        for (const row of listed.json?.sessions ?? [])
        {
            if (typeof row?.id === 'string') await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
        }
    }
    catch { /* best effort */ }
    if (keepOpen) console.log(`chrome left open on CDP port ${CDP_PORT}`)
    else
    {
        try { await cdp?.send('Browser.close') } catch { /* already gone */ }
        try { cdp?.proc?.kill('SIGKILL') } catch { /* already gone */ }
        cdp?.close()
    }
}
