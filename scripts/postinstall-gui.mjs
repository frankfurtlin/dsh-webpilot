#!/usr/bin/env node
// Post-install GUI probe for the LIVE DSH on 127.0.0.1:3080.
//
// Runs detached from the agent's turn (inside the same systemd-run unit as
// install.sh), because the install restart kills the DSH process that hosts the
// agent. What it proves: after the restart the Web GUI still boots, the
// right-Sidebar shell is mounted, and the plugin's host routes answer — i.e.
// adding the bundle did not break the app and the host half is live. The panel
// UI itself is exercised on the isolated dev instance by e2e/gui-verify.mjs
// (same files, same DSH version).
//
// Writes scripts/postinstall-gui.json and scripts/postinstall-gui.png.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, newPage, navigate, evaluate, sleep } from '../e2e/lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'postinstall-gui')
const BASE = process.env.WEBPILOT_BASE ?? 'http://127.0.0.1:3080'
const SERVICE = process.env.DSH_SERVICE ?? 'deepseek-harness'
const PORT = Number(process.env.WEBPILOT_PROBE_PORT ?? 9223)

const result = { ok: false, base: BASE, checks: [], exceptions: [], shot: null }

function check(label, ok, detail) {
  result.checks.push({ label, ok: Boolean(ok), detail: detail === undefined ? null : detail })
}

function launchToken() {
  if (process.env.WEBPILOT_TOKEN) return process.env.WEBPILOT_TOKEN
  try {
    const journal = execFileSync('journalctl', ['-u', SERVICE, '--since', '-40 min', '--no-pager'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    const matches = journal.match(/http:\/\/[^ ?]+\/\?token=([A-Za-z0-9_-]+)/g) ?? []
    const last = matches.at(-1)
    return last ? last.replace(/^.*token=/, '') : ''
  } catch (error) {
    result.tokenError = String(error.message ?? error)
    return ''
  }
}

let cdp
try {
  const token = launchToken()
  check('launch token found in the service journal', token !== '', token ? `token length ${token.length}` : 'not found')

  cdp = await launch({
    port: PORT,
    userDataDir: '/tmp/webpilot-postinstall-profile',
    headless: true,
    width: 1440,
    height: 900,
  })
  const page = await newPage(cdp, 1440, 900, 1)
  cdp.on('Runtime.exceptionThrown@' + page.sessionId, (params) => {
    result.exceptions.push(params?.exceptionDetails?.text ?? 'exception')
  })

  await navigate(cdp, page.sessionId, token ? `${BASE}/?token=${token}` : `${BASE}/`, 45000)
  await sleep(3000)

  const probe = await evaluate(
    cdp,
    page.sessionId,
    `(() => {
      const text = document.body?.innerText ?? ''
      return {
        title: document.title,
        textLength: text.length,
        hasSidebarShell: document.querySelector('[data-sidebar-right-expand]') !== null
          || document.querySelector('[data-sidebar-right-toggle]') !== null,
        hasComposer: document.querySelector('div[contenteditable="true"]') !== null,
        bodySnippet: text.slice(0, 140),
      }
    })()`,
    true,
  )
  check('GUI renders after the restart', probe.textLength > 50, `textLength=${probe.textLength} title=${probe.title}`)
  check('right-Sidebar shell is mounted', probe.hasSidebarShell, probe.hasSidebarShell)
  check('conversation composer exists', probe.hasComposer, probe.hasComposer)

  const health = await evaluate(
    cdp,
    page.sessionId,
    `fetch('/api/dsh-webpilot/health', { credentials: 'same-origin' })
       .then(r => r.json().then(v => ({ status: r.status, ok: true, value: v })))
       .catch(e => ({ ok: false, error: String(e) }))`,
    true,
  )
  check(
    'plugin health answers 200 inside the GUI session',
    health.ok && health.status === 200 && health.value?.ok === true,
    JSON.stringify(health).slice(0, 220),
  )

  const state = await evaluate(
    cdp,
    page.sessionId,
    `fetch('/api/dsh-webpilot/state?session=__probe__', { credentials: 'same-origin' })
       .then(r => ({ status: r.status }))
       .catch(e => ({ status: 0, error: String(e) }))`,
    true,
  )
  check('plugin state route is reachable from the GUI origin', state.status === 200, JSON.stringify(state).slice(0, 160))

  const tabType = await evaluate(
    cdp,
    page.sessionId,
    `(() => {
      const text = document.body?.innerText ?? ''
      return {
        mentionsWebpilot: /webpilot/i.test(text),
        hasRightSidebar: document.querySelector('[data-sidebar-right]') !== null
          || document.querySelector('[data-sidebar-right-expand]') !== null,
      }
    })()`,
    true,
  )
  check('shell exposes the right-sidebar mount points', tabType.hasRightSidebar, tabType)

  await sleep(400)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId)
  result.shot = `${OUT}.png`
  writeFileSync(result.shot, Buffer.from(shot.data, 'base64'))
  check('screenshot captured', true, result.shot)

  check('no uncaught page exception during boot', result.exceptions.length === 0, result.exceptions.slice(0, 5))
  result.ok = result.checks.every((entry) => entry.ok)
} catch (error) {
  result.error = String(error?.stack ?? error)
  result.ok = false
} finally {
  try {
    cdp?.proc?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  result.finishedAt = new Date().toISOString()
  writeFileSync(`${OUT}.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({
    ok: result.ok,
    checks: result.checks.length,
    failed: result.checks.filter((entry) => !entry.ok).length,
    exceptions: result.exceptions.length,
  }))
  process.exit(result.ok ? 0 : 1)
}
