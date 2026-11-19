/**
 * Dev-instance helpers for the dsh-webpilot e2e checks.
 *
 * The e2e harness talks to an ISOLATED dev DSH (default
 * `$DSH_DEV_HOME=/root/workspace/.dsh-dev`, profile `dev`, port 3090). It never
 * touches the live service on 3080: the dev instance is started by
 * `e2e/dev-instance.sh` and prints its one-time launch URL into
 * `<DSH_DEV_HOME>/dev.log`.
 *
 * Auth: `dsh web` gates every route behind a cookie it hands out when the
 * printed `?token=…` URL is opened. `loginCookie()` replays that redirect so
 * plain `fetch` can call the plugin's `/api/dsh-webpilot/*` routes without a
 * browser.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEV_HOME = process.env.DSH_DEV_HOME ?? '/root/workspace/.dsh-dev'

/** The dev instance's HTTP origin. Override with DSH_DEV_URL when reusing another port. */
export function devBase()
{
    const explicit = process.env.DSH_DEV_URL
    if (explicit !== undefined && explicit !== '') return explicit.replace(/\/$/, '')
    const { url } = readDevLaunch()
    return url.replace(/\/$/, '')
}

/** Parse the newest launch URL out of `<DEV_HOME>/dev.log`. */
export function readDevLaunch()
{
    const logPath = join(DEV_HOME, 'dev.log')
    let text = ''
    try
    {
        text = readFileSync(logPath, 'utf8')
    }
    catch (error)
    {
        throw new Error(`cannot read ${logPath}: ${error.message} — is the dev instance running?`)
    }
    const match = text.match(/dsh web: (http:\/\/[^\s?]+)\/\?token=([A-Za-z0-9_-]+)/)
    if (match === null) throw new Error(`no "dsh web: …?token=…" line in ${logPath}`)
    return { base: match[1], token: match[2], url: `${match[1]}/?token=${match[2]}`, logPath }
}

/**
 * Exchange the launch token for the auth cookie `dsh web` hands out.
 * @param {string} base origin, e.g. `http://127.0.0.1:3090`
 * @param {string} token one-time token from the printed URL
 * @returns {Promise<string>} a `Cookie:` header value
 */
export async function loginCookie(base, token)
{
    const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''].filter(Boolean)
    const pairs = setCookies.map((row) => row.split(';')[0]).filter((row) => row.includes('='))
    if (pairs.length === 0)
    {
        throw new Error(`no auth cookie in response ${response.status} for ${base}/?token=…`)
    }
    return pairs.join('; ')
}

/** One JSON call against a dsh-webpilot route. */
export async function api(base, cookie, path, init = {})
{
    const headers = { ...(init.headers ?? {}), cookie }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${base}/api/dsh-webpilot${path}`, { ...init, headers })
    const text = await response.text()
    let json
    try
    {
        json = JSON.parse(text)
    }
    catch
    {
        json = undefined
    }
    return { status: response.status, json, text }
}

/** Poll `probe` until it returns truthy or the deadline passes. */
export async function waitFor(probe, { timeoutMs = 20000, intervalMs = 500, label = 'condition' } = {})
{
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline)
    {
        last = await probe()
        if (last) return last
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}
