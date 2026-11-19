#!/usr/bin/env node
/**
 * The user-facing core scenario: a browser opened for the session on screen
 * must make the WebPilot panel appear by itself in the right sidebar.
 *
 * This runs on a brand-new Chrome profile every time — no localStorage, no
 * previously opened right sidebar — which is the "first use" state a user meets.
 *
 * Contract under test:
 *   1. fresh GUI boots and has a session selected on screen;
 *   2. `POST /api/dsh-webpilot/open {sessionId}` from the page (same-origin
 *      cookie) returns 200 and starts the headless browser;
 *   3. the right sidebar expands on its own (`[data-sidebar-right-panel]` gains
 *      `data-sidebar-right-open`), a "Browser" tab exists and is selected, and
 *      the panel body renders the stage + `.wp-fx` overlay + live `.wp-frame`;
 *   4. no `slot entry crashed` / pageerror / console error;
 *   5. clicking the sidebar toggle collapses it and the watcher does NOT
 *      re-expand it for the rest of this page's life.
 *
 * Run (from the plugin root, with the dev instance up):
 *   TZ=Asia/Shanghai node e2e/auto-reveal.mjs [--keep-open]
 *
 * Exit: 0 = PASS, 1 = FAIL. Artifacts: e2e/shots/auto-<stamp>/ (png + summary.json).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.TZ ??= 'Asia/Shanghai'

import { launch, newPage, evaluate, navigate, sleep } from './lib/cdp.mjs'
import { DEV_HOME, api, devBase, loginCookie, readDevLaunch, waitFor } from './lib/dev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_ROOT = process.env.E2E_SHOTS ?? join(HERE, 'shots')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const SHOTS = join(SHOT_ROOT, `auto-${STAMP}`)
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334)
const WORKSPACE_PATH = process.env.E2E_WORKSPACE ?? join(DEV_HOME, 'e2e', 'workspace')
const keepOpen = process.argv.includes('--keep-open')

const checks = []
function check(label, condition, detail)
{
    checks.push({ label, ok: Boolean(condition), detail })
    if (condition) console.log(`  ok   ${label}`)
    else console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

mkdirSync(SHOTS, { recursive: true })
mkdirSync(WORKSPACE_PATH, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'dsh-webpilot-fresh-'))

const { base, token } = readDevLaunch()
const cookie = await loginCookie(base, token)
const routeProbe = (path) => api(base, cookie, path)

let cdp
const consoleEntries = []
let sessionId
let opened = false
try
{
    console.log(`dev instance:   ${base}`)
    console.log(`fresh profile:  ${profile}`)
    console.log(`shots:          ${SHOTS}`)

    cdp = await launch({ port: CDP_PORT, headless: !keepOpen, width: 1440, height: 900, userDataDir: profile })
    const page = await newPage(cdp, 1440, 900, 1)
    const sid = page.sessionId
    const evalP = (expression) => evaluate(cdp, sid, expression, true)
    const shot = async (name) =>
    {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid)
        const path = join(SHOTS, `${name}.png`)
        writeFileSync(path, Buffer.from(data, 'base64'))
        return path
    }
    const clickText = async (pattern, selector = 'button,[role="button"],a,[role="tab"]') => evalP(`(() => {
        const rx = new RegExp(${JSON.stringify(pattern)}, 'i');
        const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((el) => rx.test(el.innerText || '') || rx.test(el.getAttribute('aria-label') || ''));
        if (hit === undefined) return false;
        hit.click();
        return true;
    })()`)
    const clickAt = async (x, y) =>
    {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid)
    }
    cdp.on('Runtime.consoleAPICalled@' + sid, (payload) =>
    {
        if (payload.type !== 'error' && payload.type !== 'warning' && payload.type !== 'assert') return
        consoleEntries.push({ level: payload.type, text: payload.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ').slice(0, 800) })
    })
    cdp.on('Runtime.exceptionThrown@' + sid, (payload) =>
    {
        const detail = payload.exceptionDetails ?? {}
        consoleEntries.push({ level: 'exception', text: (detail.exception?.description ?? detail.text ?? '').slice(0, 800) })
    })

    /** The current GUI session id (the one the panel must bind to). */
    const currentSession = () => evalP(`(() => {
        try { return JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId ?? '' } catch { return '' }
    })()`)

    /** Fill + confirm the "Select Workspace Directory" dialog when it is open. */
    const resolveWorkspaceDialog = async () =>
    {
        const visible = await evalP(`(() => /Select Workspace Directory|选择工作区目录/.test(document.body.innerText))()`)
        if (!visible) return false
        if (!(await clickText('^Edit path$|^编辑路径$'))) return false
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
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
        await sleep(1500)
        await clickText('^Open$|^打开$')
        await sleep(2500)
        return true
    }

    /** Boot the GUI, dismiss onboarding, make sure a workspace and a session exist. */
    const bootGui = async () =>
    {
        await navigate(cdp, sid, `${base}/?token=${encodeURIComponent(token)}`, 45000)
        await sleep(6000)
        if (await clickText('^Continue$|^继续$')) await sleep(1500)

        let composer = await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)
        if (!composer)
        {
            // First-use workspace picker.
            await clickText('^Add workspace$|^添加工作区$')
            await sleep(1200)
            await clickText('^Edit path$|^编辑路径$')
            await sleep(500)
            await evalP(`(() => {
                const input = document.querySelector('input[type="text"]');
                if (input === null) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(input, ${JSON.stringify(WORKSPACE_PATH)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
                return true;
            })()`)
            await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
            await sleep(1200)
            await clickText('^Open$|^打开$')
            await sleep(2500)
            composer = await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)
        }
        if (!composer)
        {
            // The workspace chooser can also appear as its own dialog; fill it the
            // same way gui-verify does, then wait for the editor to mount.
            if (await resolveWorkspaceDialog())
            {
                composer = await waitFor(async () => (await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)) ? true : undefined,
                    { timeoutMs: 15000, intervalMs: 400, label: 'the composer to mount' }).catch(() => false)
            }
        }
        let current = await currentSession()
        if (current === '')
        {
            // A fresh profile may boot to the welcome page: create a session.
            await clickText('^New session$|^新会话$')
            await sleep(1500)
            await resolveWorkspaceDialog()
            current = await currentSession()
        }
        composer = await waitFor(async () => (await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)) ? true : undefined,
            { timeoutMs: 15000, intervalMs: 400, label: 'the composer after creating the session' }).catch(() => composer)
        return composer === true && current !== ''
    }

    // --- 1. fresh boot + session on screen --------------------------------
    const ready = await bootGui()
    check('fresh profile: GUI boots and selects a session', ready === true, `composer/current ready=${ready}`)
    sessionId = await currentSession()
    check('fresh profile: session id is discoverable', /^[A-Za-z0-9_-]{8,}$/.test(sessionId), sessionId)
    await shot('01-fresh-boot')

    // --- 2. trigger the browser from the page (same-origin cookie) --------
    if (sessionId !== '')
    {
        const response = await evalP(`fetch('/api/dsh-webpilot/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: ${JSON.stringify(sessionId)} })
        }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 400) }))`)
        check('POST /open from the GUI page returns 200', response?.status === 200, JSON.stringify(response)?.slice(0, 300))
        opened = response?.status === 200
    }
    const openedState = opened ? await routeProbe(`/state?session=${encodeURIComponent(sessionId)}`) : undefined
    check('the browser is running for the on-screen session', openedState?.json?.running === true && openedState?.json?.session?.open === true, JSON.stringify(openedState?.json?.session))

    // --- 3. the sidebar reveals itself ------------------------------------
    /**
     * Stable DOM criterion: the right panel root carries `data-sidebar-right-open`
     * and its dock host has a real width (that attribute alone is set while the
     * column is expanded; the host width rules out a zero-width hidden dock).
     */
    const sidebarState = () => evalP(`(() => {
        const panel = document.querySelector('[data-sidebar-right-panel]');
        const host = panel?.querySelector('[data-dockkit-host="dock"]');
        // The tab strip is dockkit's: one [role="tab"] per tab, its title in a
        // nested [data-sidebar-right-tab] span. Our title slot renders .wp-tab-title.
        const tabs = [...document.querySelectorAll('[role="tab"]')].map((el) => {
            const titleEl = el.querySelector('[data-sidebar-right-tab]');
            const raw = ((titleEl?.innerText ?? el.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            return {
                text: raw,
                compact: raw.replace(/\s+/g, ''),
                selected: el.getAttribute('aria-selected') === 'true',
                ours: el.querySelector('.wp-tab-title') !== null,
            };
        });
        return {
            panel: panel !== null,
            expanded: panel !== null && panel.hasAttribute('data-sidebar-right-open'),
            hostWidth: host === null ? 0 : Math.round(host.getBoundingClientRect().width),
            toggle: document.querySelector('[data-sidebar-right-toggle]') !== null,
            expandCtl: document.querySelector('[data-sidebar-right-expand]') !== null,
            tabs,
            panelBody: panel === null ? '' : (panel.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        };
    })()`)

    const revealTimeoutMs = Number(process.env.E2E_REVEAL_TIMEOUT_MS ?? 10000)
    const revealStartedAt = Date.now()
    let reveal
    let revealMs
    while (Date.now() - revealStartedAt < revealTimeoutMs)
    {
        reveal = await sidebarState()
        const tabNow = (reveal?.tabs ?? []).find((tab) => tab.ours === true || /browser|浏览器/i.test(tab.compact))
        if (reveal?.expanded === true && reveal.hostWidth > 0 && tabNow !== undefined)
        {
            revealMs = Date.now() - revealStartedAt
            break
        }
        await sleep(250)
    }
    check(`sidebar expands by itself when a browser opens (within ${revealTimeoutMs}ms)`, reveal?.expanded === true && (reveal?.hostWidth ?? 0) > 0, `revealMs=${revealMs ?? 'timeout'} state=${JSON.stringify({ expanded: reveal?.expanded, hostWidth: reveal?.hostWidth, tabs: reveal?.tabs })}`)
    check('expanded side panel has real width', (reveal?.hostWidth ?? 0) > 0, `hostWidth=${reveal?.hostWidth}`)

    const panelTab = (reveal?.tabs ?? []).find((tab) => tab.ours === true || /browser|浏览器/i.test(tab.compact))
    check('a Browser tab exists in the right tab strip', panelTab !== undefined, JSON.stringify(reveal?.tabs)?.slice(0, 400))
    check('the Browser tab is the selected one', panelTab?.selected === true, JSON.stringify(panelTab))

    const readPanelDom = () => evalP(`(() => {
        const root = document.querySelector('[data-dsh-webpilot]');
        if (root === null) return null;
        const fx = root.querySelector('.wp-fx');
        const frame = root.querySelector('.wp-frame');
        const status = (root.querySelector('.wp-status')?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const hud = [...root.querySelectorAll('.wp-hud-line')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
        return {
            root: true,
            stage: root.querySelector('.wp-stage') !== null,
            fx: fx !== null && fx.width > 0 && fx.height > 0,
            fxSize: fx === null ? null : { width: fx.width, height: fx.height },
            frame: frame !== null && frame.width > 0,
            frameSize: frame === null ? null : { width: frame.width, height: frame.height },
            tone: root.getAttribute('data-tone'),
            status,
            hud,
            standby: root.querySelector('.wp-standby') !== null,
        };
    })()`)
    // The WebSocket + first screencast frame need a moment after the tab mounts;
    // wait for the panel to leave STANDBY before asserting on it.
    const panelDom = await waitFor(async () =>
    {
        const dom = await readPanelDom()
        return dom !== null && (dom.frame === true || dom.tone === 'live') ? dom : undefined
    }, { timeoutMs: 20000, intervalMs: 300, label: 'the panel to show a live picture' }).catch(async () => readPanelDom())
    check('panel body renders the stage + fx overlay canvas', panelDom?.root === true && panelDom.stage && panelDom.fx, JSON.stringify(panelDom)?.slice(0, 400))
    check('panel shows the live picture canvas for the opened browser', panelDom?.frame === true, JSON.stringify(panelDom?.frameSize))
    check('panel left STANDBY and reports a live tone', (panelDom?.tone ?? 'standby') !== 'standby', `tone=${panelDom?.tone} status=${panelDom?.status}`)
    await shot('02-auto-revealed')

    // --- 4. console gate --------------------------------------------------
    const errors = consoleEntries.filter((row) => row.level !== 'warning')
    const slotCrash = errors.some((row) => /slot entry crashed|Cannot read properties of undefined/i.test(row.text))
    check('no console error / slot crash while auto-revealing', errors.length === 0, errors.slice(0, 3).map((row) => `${row.level}: ${row.text.slice(0, 200)}`).join(' | '))
    check('no "slot entry crashed" error specifically', slotCrash === false, errors.filter((row) => /slot entry crashed/i.test(row.text)).map((row) => row.text.slice(0, 200)).join(' | '))

    // --- 5. collapse must stick (no auto re-expand this page life) --------
    // `[data-sidebar-right-toggle]` is a toggle: only meaningful while expanded.
    const expandedNow = (await sidebarState())?.expanded === true
    const collapseClicked = expandedNow
        ? await evalP(`(() => {
            const toggle = document.querySelector('[data-sidebar-right-toggle]');
            if (toggle === null) return false;
            toggle.click();
            return true;
        })()`)
        : false
    await sleep(1500)
    const collapsed = await sidebarState()
    check('toggle collapses the right sidebar', collapseClicked && collapsed.expanded === false, `clicked=${collapseClicked} expanded=${collapsed?.expanded}`)
    await sleep(6000) // longer than the reveal poll window after the ui change
    const stayed = await sidebarState()
    check('the watcher does not re-expand a sidebar the user collapsed', stayed.expanded === false, `expanded=${stayed?.expanded} hostWidth=${stayed?.hostWidth}`)
    await shot('03-after-collapse')

    const failed = checks.filter((row) => !row.ok)
    writeFileSync(join(SHOTS, 'summary.json'), JSON.stringify({ stamp: STAMP, dev: base, sessionId, checks, consoleEntries, screenshots: [join(SHOTS, '01-fresh-boot.png'), join(SHOTS, '02-auto-revealed.png'), join(SHOTS, '03-after-collapse.png')],
        revealMs,
        revealState: reveal, passed: checks.length - failed.length, failed: failed.length }, null, 2))
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} auto-reveal — ${checks.length - failed.length} passed, ${failed.length} failed`)
    console.log(`evidence: ${SHOTS}`)
    process.exitCode = failed.length === 0 ? 0 : 1
}
catch (error)
{
    console.error(`\nFAIL auto-reveal — ${error.stack ?? error.message}`)
    process.exitCode = 1
}
finally
{
    // Close the dev-instance browser for this session, then our own Chrome.
    if (sessionId !== undefined && sessionId !== '' && opened)
    {
        try { await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId }) }) } catch { /* best effort */ }
    }
    if (keepOpen) console.log(`chrome left open on CDP port ${CDP_PORT} (profile ${profile})`)
    else
    {
        try { await cdp?.send('Browser.close') } catch { /* already gone */ }
        try { cdp?.proc?.kill('SIGKILL') } catch { /* already gone */ }
        cdp?.close()
        try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
    }
}
