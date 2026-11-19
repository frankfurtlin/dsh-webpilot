#!/usr/bin/env node
/**
 * Panel HTTP-route acceptance against the isolated dev DSH instance.
 *
 * Checks the exact contract the Web UI relies on, without a browser:
 *   GET  /api/dsh-webpilot/health        — plugin is mounted, version/profile match
 *   GET  /api/dsh-webpilot/sessions      — flat session list shape
 *   GET  /api/dsh-webpilot/state?session=— one session's state, id echoed
 *   POST /api/dsh-webpilot/open {sessionId}  — starts a headless browser for a session
 *   POST /api/dsh-webpilot/close {sessionId} — stops it and reports ok:true
 * plus the auth guard: an unauthenticated request must be rejected, not served.
 *
 * Run (from the plugin root):
 *   TZ=Asia/Shanghai node e2e/routes-smoke.mjs [--no-browser]
 *
 * Exit: 0 = PASS, 1 = FAIL (each failed check is named on stderr).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, devBase, loginCookie, readDevLaunch, waitFor } from './lib/dev.mjs'

process.env.TZ ??= 'Asia/Shanghai'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const PROBE_SESSION = 'e2e-routes-probe'
const withBrowser = !process.argv.includes('--no-browser')

const checks = []
/** One named assertion; failures never abort the run. */
function check(label, condition, detail)
{
    checks.push({ label, ok: Boolean(condition), detail })
    if (condition) console.log(`  ok   ${label}`)
    else console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function shape(value, keys)
{
    return value !== null && typeof value === 'object' && keys.every((key) => key in value)
}

try
{
    const packageJson = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
    const { base, token } = readDevLaunch()
    console.log(`dev instance: ${base}`)

    // Auth gate: without the cookie the GUI and the plugin routes are both closed.
    const anonymous = await fetch(`${base}/api/dsh-webpilot/health`)
    check('auth: unauthenticated /health is rejected (401/403)', anonymous.status === 401 || anonymous.status === 403, `status ${anonymous.status}`)

    const cookie = await loginCookie(base, token)
    check('auth: launch token yields an auth cookie', cookie.includes('='), cookie.slice(0, 40))

    const health = await api(base, cookie, '/health')
    check('GET /health returns 200', health.status === 200, `status ${health.status} ${health.text.slice(0, 200)}`)
    check('GET /health {ok:true, version}', health.json?.ok === true && health.json?.version === packageJson.version, JSON.stringify(health.json))
    check('GET /health profileDir lives in the dev home', typeof health.json?.profileDir === 'string' && health.json.profileDir.startsWith('/root/workspace/.dsh-dev/'), health.json?.profileDir)

    const sessions = await api(base, cookie, '/sessions')
    check('GET /sessions returns 200', sessions.status === 200, `status ${sessions.status}`)
    check('GET /sessions shape {version, running, sessions[], pending[]}',
        shape(sessions.json, ['version', 'running', 'sessions', 'pending']) && Array.isArray(sessions.json.sessions),
        JSON.stringify(sessions.json)?.slice(0, 200))

    const state = await api(base, cookie, `/state?session=${encodeURIComponent(PROBE_SESSION)}`)
    check('GET /state returns 200', state.status === 200, `status ${state.status}`)
    check('GET /state echoes sessionId', state.json?.sessionId === PROBE_SESSION, state.json?.sessionId)
    check('GET /state has {running, session, stream, panels}', shape(state.json, ['running', 'session', 'stream', 'panels']), JSON.stringify(state.json)?.slice(0, 240))
    check('GET /state session.open is boolean', typeof state.json?.session?.open === 'boolean', JSON.stringify(state.json?.session))
    check('GET /state rejects POST with 405', (await api(base, cookie, '/state', { method: 'POST' })).status === 405, 'state route is GET-only')

    if (withBrowser)
    {
        // Self-contained: earlier steps (or an interrupted run) may have left a
        // browser session open, which this lifecycle assertion needs to start
        // from zero.
        const listing = await api(base, cookie, '/sessions')
        for (const row of listing.json?.sessions ?? [])
        {
            if (typeof row?.id === 'string') await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
        }

        const before = await api(base, cookie, '/health')
        // The browser *process* is kept warm across sessions, so "running:false"
        // is not a precondition; an empty session list is.
        const sessionCount = typeof before.json?.sessions === 'number'
            ? before.json.sessions
            : (before.json?.sessions ?? []).length
        check('precondition: no browser session open before /open', sessionCount === 0, `sessions=${JSON.stringify(before.json?.sessions)} running=${before.json?.running}`)

        const opened = await api(base, cookie, '/open', { method: 'POST', body: JSON.stringify({ sessionId: PROBE_SESSION }) })
        check('POST /open returns 200', opened.status === 200, `status ${opened.status} ${opened.text.slice(0, 300)}`)
        check('POST /open reports the browser running', opened.json?.running === true, `running=${opened.json?.running}`)
        check('POST /open exposes a launchable executable', typeof opened.json?.executable === 'string' && opened.json.executable.length > 0, opened.json?.executable)

        const live = await waitFor(async () =>
        {
            const current = await api(base, cookie, `/state?session=${encodeURIComponent(PROBE_SESSION)}`)
            const list = await api(base, cookie, '/sessions')
            const entry = (list.json?.sessions ?? []).find((session) => session.id === PROBE_SESSION)
            if (entry === undefined) return undefined
            return { current, list, entry }
        }, { timeoutMs: 20000, intervalMs: 400, label: 'the opened browser session to appear in /sessions' })
        check('opened browser session is listed with a page', live.entry.id === PROBE_SESSION && typeof live.entry.url === 'string', JSON.stringify(live.entry))
        check('opened browser session has a title field', typeof live.entry.title === 'string' || live.entry.title === null, JSON.stringify(live.entry).slice(0, 200))

        const closed = await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId: PROBE_SESSION }) })
        check('POST /close returns 200 {ok:true}', closed.status === 200 && closed.json?.ok === true, `status ${closed.status} ${closed.text.slice(0, 200)}`)

        const after = await waitFor(async () =>
        {
            const result = await api(base, cookie, '/sessions')
            const stillListed = (result.json?.sessions ?? []).some((session) => session.id === PROBE_SESSION)
            return stillListed ? undefined : result
        }, { timeoutMs: 15000, intervalMs: 400, label: 'the probe session to disappear from /sessions' })
        check('closed session disappears from /sessions', after.status === 200, `status ${after.status}`)
        check('closed session is not left in the session list', !(after.json?.sessions ?? []).some((session) => session.id === PROBE_SESSION), JSON.stringify(after.json?.sessions))
        const closedState = await api(base, cookie, `/state?session=${encodeURIComponent(PROBE_SESSION)}`)
        check('closed session reports session.open=false', closedState.json?.session?.open === false, JSON.stringify(closedState.json?.session))
        // The browser PROCESS is intentionally kept warm between sessions (idle
        // shutdown owns it), so `running` may stay true here; what must end is
        // this session's page.
        check('browser process reuse is reported consistently', typeof after.json?.running === 'boolean', `running=${after.json?.running}`)
    }

    const failed = checks.filter((row) => !row.ok)
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} routes-smoke — ${checks.length - failed.length} passed, ${failed.length} failed`)
    process.exit(failed.length === 0 ? 0 : 1)
}
catch (error)
{
    console.error(`\nFAIL routes-smoke — ${error.stack ?? error.message}`)
    process.exit(1)
}
