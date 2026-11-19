#!/usr/bin/env node
/**
 * The human typed an address: the panel's location row must be a real input,
 * and typing a bare host there must navigate the session's tab.
 *
 * Contract under test:
 *   1. a session with a browser renders `input.wp-address` inside `.wp-location`,
 *      and it is editable (not readOnly/disabled), ghosting the current URL;
 *   2. focusing it turns it into an editor whose value is what the human types;
 *   3. Enter on `example.com` (no scheme) navigates the tab to
 *      `https://example.com/` — and the row shows the new host;
 *   4. a bare word (`hello`) is refused: the tab stays where it was;
 *   5. no `slot entry crashed` / pageerror / console error along the way.
 *
 * Run (from the plugin root, with the dev instance up):
 *   TZ=Asia/Shanghai node e2e/address-bar.mjs [--keep-open]
 *
 * Exit: 0 = PASS, 1 = FAIL. Artifacts: e2e/shots/address-<stamp>/ (png + summary.json).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.TZ ??= 'Asia/Shanghai'

import { launch, newPage, evaluate, navigate, sleep } from './lib/cdp.mjs'
import { DEV_HOME, devBase, loginCookie, readDevLaunch, waitFor } from './lib/dev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_ROOT = process.env.E2E_SHOTS ?? join(HERE, 'shots')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const SHOTS = join(SHOT_ROOT, `address-${STAMP}`)
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335)
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
const profile = mkdtempSync(join(tmpdir(), 'dsh-webpilot-address-'))

const { base, token } = readDevLaunch() ?? {}
const cookie = await loginCookie(base, token)

let cdp
const consoleEntries = []
let sessionId = ''
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
        writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
    }
    const clickText = async (pattern, selector = 'button,[role="button"],a,[role="tab"]') => evalP(`(() => {
        const rx = new RegExp(${JSON.stringify(pattern)}, 'i');
        const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((el) => rx.test(el.innerText || '') || rx.test(el.getAttribute('aria-label') || ''));
        if (hit === undefined) return false;
        hit.click();
        return true;
    })()`)
    const pressEnter = async () =>
    {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
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

    const currentSession = () => evalP(`(() => {
        try { return JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId ?? '' } catch { return '' }
    })()`)

    /** Fill the workspace picker with the shared dev workspace. */
    const pickWorkspace = async () =>
    {
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
        await pressEnter()
        await sleep(1200)
        await clickText('^Open$|^打开$')
        await sleep(2500)
        return true
    }

    const bootGui = async () =>
    {
        await navigate(cdp, sid, `${base}/?token=${encodeURIComponent(token)}`, 45000)
        await sleep(6000)
        if (await clickText('^Continue$|^继续$')) await sleep(1500)
        let composer = await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)
        if (!composer)
        {
            await clickText('^Add workspace$|^添加工作区$')
            await sleep(1200)
            if (await pickWorkspace()) composer = await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)
        }
        let current = await currentSession()
        if (current === '')
        {
            await clickText('^New session$|^新会话$')
            await sleep(1500)
            await pickWorkspace()
            current = await currentSession()
        }
        const ready = await waitFor(
            async () => (await evalP(`document.querySelector('div[contenteditable="true"]') !== null`)) ? true : undefined,
            { timeoutMs: 15000, intervalMs: 400, label: 'the composer' },
        ).catch(() => false)
        return { composer: ready === true, current }
    }

    // --- 1. a session on screen ------------------------------------------
    const boot = await bootGui()
    check('GUI boots with a session and a composer', boot.composer && boot.current !== '', JSON.stringify(boot))
    sessionId = boot.current

    // --- 2. a browser for that session, panel reveals itself -------------
    const opened = await evalP(`fetch('/api/dsh-webpilot/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: ${JSON.stringify(sessionId)} }),
    }).then((r) => r.ok)`).catch(() => false)
    check('POST /open starts the browser for the session', opened === true, String(opened))

    const address = `document.querySelector('[data-dsh-webpilot] input.wp-address')`
    const appeared = await waitFor(
        async () => (await evalP(`${address} !== null`)) ? true : undefined,
        { timeoutMs: 20000, intervalMs: 500, label: 'the address input' },
    ).catch(() => false)
    check('the panel renders an address input', appeared === true, String(appeared))
    if (appeared !== true)
    {
        await shot('00-no-address-input')
        throw new Error('address input never appeared')
    }
    await sleep(1500)
    await shot('01-ghost-address')

    // --- 3. ghost state mirrors the live URL ------------------------------
    const ghost = await evalP(`(() => {
        const input = ${address};
        if (input === null) return null;
        return {
            value: input.value,
            ghost: input.classList.contains('wp-address--ghost'),
            editable: input.readOnly === false && input.disabled === false,
            focused: document.activeElement === input,
        };
    })()`)
    check('the address input is editable', ghost?.editable === true, JSON.stringify(ghost))
    check('a live URL means navigation is possible', ghost !== null && /^(https?:\/\/|about:blank$|$)/.test(ghost.value), JSON.stringify(ghost?.value))

    // Regression guard: the hint must not be painted underneath the ghosted
    // URL text. When the host has not reported a URL yet the input is empty,
    // so a `placeholder` there draws over the `about:blank` span (the overlap
    // the human saw). The hint only belongs to the focused editor.
    const hint = await evalP(`(() => {
        const input = ${address};
        if (input === null) return null;
        const site = input.parentElement?.querySelector('.wp-url-site');
        return {
            ghosting: input.classList.contains('wp-address--ghost'),
            placeholder: input.getAttribute('placeholder'),
            value: input.value,
            span: site === undefined || site === null ? '' : site.textContent,
        };
    })()`)
    check('the ghost bar paints no hint under the URL text', hint?.ghosting === false || hint?.placeholder === null, JSON.stringify(hint))

    // --- 4. focus turns it into an editor, typing is visible -------------
    const before = ghost?.value ?? ''
    await evalP(`${address}.focus()`)
    await sleep(300)
    const editing = await evalP(`(() => {
        const input = ${address};
        return input === null ? null : { ghost: input.classList.contains('wp-address--ghost'), value: input.value, placeholder: input.getAttribute('placeholder'), selected: input.selectionStart === 0 && input.selectionEnd === input.value.length };
    })()`)
    check('focus drops the ghost style (real text shows)', editing?.ghost === false, JSON.stringify(editing))
    check('focus selects the whole address, like a browser', editing?.selected === true, JSON.stringify(editing))
    check('focus brings back the typing hint', typeof editing?.placeholder === 'string' && editing.placeholder.length > 0, JSON.stringify(editing?.placeholder))

    await cdp.send('Input.insertText', { text: 'example.com' }, sid)
    await sleep(300)
    const typed = await evalP(`${address}?.value`)
    check('typing replaces the address text', typed === 'example.com', JSON.stringify(typed))
    await shot('02-editing-address')

    // --- 5. Enter navigates a bare host with https:// ---------------------
    await evalP(`${address}.focus()`)
    await sleep(200)
    await pressEnter()
    const landed = await waitFor(async () =>
    {
        const state = await evalP(`${address} === null ? '' : ${address}.value`)
        return /^https?:\/\/example\.com\/?$/.test(String(state ?? '')) ? String(state) : undefined
    }, { timeoutMs: 20000, intervalMs: 500, label: 'the tab to land on example.com' }).catch(() => undefined)
    check('bare host + Enter navigates to https://example.com/', landed !== undefined, JSON.stringify(landed))
    await sleep(1200)
    await shot('03-navigated')

    const shown = await evalP(`(() => {
        const root = document.querySelector('[data-dsh-webpilot]');
        if (root === null) return null;
        return {
            site: root.querySelector('.wp-url-site')?.textContent ?? '',
            path: root.querySelector('.wp-url-path')?.textContent ?? '',
            title: root.querySelector('.wp-url-site')?.getAttribute('title') ?? '',
        };
    })()`)
    check('the URL row shows the new host', shown?.site === 'example.com', JSON.stringify(shown))

    // --- 6. a bare word is refused ---------------------------------------
    await evalP(`${address}.focus()`)
    await sleep(200)
    await cdp.send('Input.insertText', { text: 'hello' }, sid)
    await sleep(200)
    await pressEnter()
    await sleep(2500)
    const afterWord = await evalP(`${address}?.value ?? ''`)
    check('a bare word does not navigate away', /example\.com/.test(String(afterWord)), JSON.stringify(afterWord))
    await shot('04-bare-word-refused')

    // --- 7. Ctrl+L focuses the bar, Escape abandons the edit -------------
    await evalP(`document.querySelector('[data-dsh-webpilot] canvas')?.focus()`)
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 }, sid)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 }, sid)
    await sleep(400)
    const shortcut = await evalP(`(() => {
        const input = ${address};
        return input === null ? null : { focused: document.activeElement === input, ghost: input.classList.contains('wp-address--ghost') };
    })()`)
    check('Ctrl+L focuses the address bar', shortcut?.focused === true && shortcut?.ghost === false, JSON.stringify(shortcut))

    await cdp.send('Input.insertText', { text: 'zzz' }, sid)
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
    await sleep(400)
    const escaped = await evalP(`(() => {
        const input = ${address};
        return input === null ? null : { ghost: input.classList.contains('wp-address--ghost'), value: input.value };
    })()`)
    check('Escape drops the edit and restores the page URL', escaped?.ghost === true && /example\.com/.test(String(escaped?.value)), JSON.stringify(escaped))
    await shot('05-shortcut-and-escape')

    // --- 8. no crashes in the panel --------------------------------------
    const crashes = consoleEntries.filter((entry) => /slot entry crashed|Uncaught|TypeError/.test(entry.text))
    check('no slot crash or uncaught error', crashes.length === 0, JSON.stringify(crashes.slice(0, 3)))
}
catch (error)
{
    check('scenario completes without throwing', false, error.message)
    console.error(error.stack?.split('\n').slice(0, 6).join('\n') ?? '')
}
finally
{
    writeFileSync(join(SHOTS, 'summary.json'), JSON.stringify({
        base,
        sessionId,
        checks,
        console: consoleEntries.slice(0, 40),
    }, null, 2))
    if (keepOpen !== true)
    {
        await cdp?.send?.('Browser.close').catch(() => {})
        await sleep(800)
        rmSync(profile, { recursive: true, force: true })
    }
    const failed = checks.filter((entry) => entry.ok !== true)
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} address-bar — ${checks.length - failed.length} passed, ${failed.length} failed`)
    console.log(`shots: ${SHOTS}`)
    process.exit(failed.length === 0 ? 0 : 1)
}
