#!/usr/bin/env node
/**
 * Run the whole dsh-webpilot acceptance suite against the isolated dev
 * instance on port 3090.
 *
 * Steps, in order:
 *   1. backend-smoke.mjs   host half over a real Chrome (no DSH runtime)
 *   2. routes-smoke.mjs    the panel HTTP routes + browser lifecycle
 *   3. auto-reveal.mjs     fresh profile: /open makes the side column appear by itself
 *   4. address-bar.mjs     typing a bare host in the panel navigates the tab
 *   5. gui-verify.mjs      the real GUI: panel renders, an agent run turns it LIVE
 *
 * Prerequisites (see README.md): the dev instance is already running and
 * `.dsh-dev/dev.log` carries its launch-token line.
 *
 * Run (from the plugin root):
 *   TZ=Asia/Shanghai node e2e/run-all.mjs
 *   TZ=Asia/Shanghai node e2e/run-all.mjs --no-backend --no-gui
 *   TZ=Asia/Shanghai node e2e/run-all.mjs --keep-open     # keeps the GUI browser
 *
 * Exit: 0 = every step passed, 1 = at least one step failed, 2 = dev instance
 * is not reachable (nothing ran).
 *
 * Artifacts: e2e/shots/run-all-<stamp>/summary.json plus each step's own
 * e2e/shots/<step>-<stamp>/ directory.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ ??= 'Asia/Shanghai'

import { DEV_HOME, api, loginCookie, readDevLaunch } from './lib/dev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = join(HERE, 'shots', `run-all-${STAMP}`)

const has = (flag) => process.argv.includes(flag)
const keepOpen = has('--keep-open')

/** `[name, script, enabled]`; a disabled step is reported as skipped, never silently dropped. */
const STEPS = [
    ['backend-smoke', 'e2e/backend-smoke.mjs', !has('--no-backend')],
    ['routes-smoke', 'e2e/routes-smoke.mjs', !has('--no-routes')],
    ['auto-reveal', 'e2e/auto-reveal.mjs', !has('--no-auto')],
    ['address-bar', 'e2e/address-bar.mjs', !has('--no-address')],
    ['gui-verify', 'e2e/gui-verify.mjs', !has('--no-gui')],
]

/** Run one step, streaming its output while keeping the tail for the summary. */
function runStep(name, script)
{
    return new Promise((resolve) =>
    {
        const startedAt = Date.now()
        const args = [script, ...(name === 'gui-verify' && keepOpen ? ['--keep-open'] : [])]
        const child = spawn(process.execPath, args, {
            cwd: PLUGIN,
            env: { ...process.env, TZ: 'Asia/Shanghai' },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const lines = []
        const collect = (chunk) =>
        {
            for (const line of chunk.toString().split('\n'))
            {
                if (line === '') continue
                lines.push(line)
                console.log(`    ${line}`)
            }
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        child.on('close', (code) =>
        {
            const okLines = lines.filter((line) => /^\s*ok\s/.test(line)).length
            const failLines = lines.filter((line) => /^\s*FAIL\s/.test(line)).length
            const artefacts = lines.filter((line) => /^evidence:/.test(line)).map((line) => line.replace(/^evidence:\s*/, ''))
            resolve({
                step: name,
                script,
                status: code === 0 ? 'pass' : 'fail',
                exitCode: code,
                elapsedMs: Date.now() - startedAt,
                ok: okLines,
                failed: failLines,
                artifacts: artefacts,
                tail: lines.slice(-14),
            })
        })
    })
}

const { base, token } = readDevLaunch()
const cookie = await loginCookie(base, token)
const health = await api(base, cookie, '/health')
if (health.status !== 200 || health.json?.ok !== true)
{
    console.error(`dsh-webpilot dev instance is not answering at ${base} (/health -> ${health.status}).`)
    console.error(`Start it first (see e2e/README.md):  cd ${DEV_HOME} && TZ=Asia/Shanghai DSH_HOME=${DEV_HOME} dsh --profile dev --port 3090 --no-open`)
    process.exit(2)
}

mkdirSync(OUT, { recursive: true })
console.log(`dev instance: ${base}`)
console.log(`artifacts:    ${OUT}`)

const results = []
for (const [name, script, enabled] of STEPS)
{
    if (!enabled)
    {
        results.push({ step: name, script, status: 'skipped' })
        console.log(`\n== ${name} — skipped (flag)`)
        continue
    }
    console.log(`\n== ${name}`)
    // GUI steps must start from a clean browser state: an earlier step (or an
    // interrupted run) may have left a session — and its sidebar tab — open,
    // which changes both the auto-reveal and the STANDBY preconditions.
    if (name === 'auto-reveal' || name === 'gui-verify')
    {
        try
        {
            const { base, token } = readDevLaunch()
            const cookie = await loginCookie(base, token)
            const listed = await api(base, cookie, '/sessions')
            for (const row of listed.json?.sessions ?? [])
            {
                if (typeof row?.id === 'string') await api(base, cookie, '/close', { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
            }
            const open = (listed.json?.sessions ?? []).length
            if (open > 0) console.log(`   cleaned ${open} stale browser session(s) before ${name}`)
        }
        catch (error)
        {
            console.log(`   session cleanup before ${name} skipped: ${error.message}`)
        }
    }
    const result = await runStep(name, script)
    results.push(result)
}

const passed = results.filter((row) => row.status === 'pass').length
const failed = results.filter((row) => row.status === 'fail').length
const skipped = results.filter((row) => row.status === 'skipped').length
const summaryPath = join(OUT, 'summary.json')
writeFileSync(summaryPath, JSON.stringify({ stamp: STAMP, dev: base, plugin: PLUGIN, passed, failed, skipped, results }, null, 2) + '\n')

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} run-all — ${passed} passed, ${failed} failed, ${skipped} skipped`)
console.log(`summary: ${summaryPath}`)
process.exitCode = failed === 0 ? 0 : 1
