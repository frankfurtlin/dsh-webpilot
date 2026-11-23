# dsh-webpilot — embedded browser

**A real browser that lives inside the DSH host: one tab per session, driven by `webpilot_*` tools, watched and taken over by a human in the right sidebar.**

A vendored fork of [`imroc/dsh-embedded-browser`](https://github.com/imroc/dsh-embedded-browser) v0.3.0 (MIT) with the WebPilot visual and effects layer on top.

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/DSH-DeepSeek%20Harness-5b5ef7)](https://github.com/frankfurtlin/dsh-pocket)

[中文](README.md) · [English](README.en.md)

![WebPilot sidebar panel: live page, address bar and action HUD](e2e/shots/run-2026-11-18T11-38-09/hero/hero-panel.png)

## What it is

dsh-webpilot keeps one Chrome instance for the whole DSH host and gives every session its own tab in it. The agent drives its tab through `webpilot_*` tools; the human watches that same tab in the right-sidebar panel and can type, click or log in at any time. All sessions share one persistent Chrome profile, so a QR-code or password login performed once works everywhere — and across host restarts. Because the browser lives in the host, the plugin works on a machine with no display at all.

## Why it exists

Agents run on machines without a screen, and the sites they need sit behind a login. Pure headless automation gets stuck at the first step that needs a person: SSO redirects, SMS or email codes, QR-code login, image CAPTCHAs. WebPilot hands that step back to the human **on the same tab the agent is already working on**; the agent continues with the same login state, and the result is stored in the persistent profile.

## Features

### Model tools (`webpilot_*`)

| Tool | What it does |
|---|---|
| `webpilot_status` | Whether the browser is up, this session's tab URL/title, and whether a human handover is pending |
| `webpilot_navigate` | Open a URL in this session's tab (starts the browser on first call) |
| `webpilot_snapshot` | Read the page: title, URL, numbered interactive elements with `box` coordinates, visible text |
| `webpilot_click` | Click by element number or visible label; dispatches real input events |
| `webpilot_type` | Focus a field and insert text (works with React/Vue controlled inputs), optionally submit with Enter |
| `webpilot_press` | Press one key (Enter/Tab/Escape/arrows/PageUp/Down/…) |
| `webpilot_scroll` | Scroll (down/up/left/right/top/bottom) |
| `webpilot_screenshot` | Capture the page and return it as an image attachment |
| `webpilot_ask_human` | **Ask the person**: bring this tab into the panel and block until they press "Done" (this is what QR-code login uses) |
| `webpilot_close` | Close this session's tab; the profile and every login survive |

### Right-sidebar panel

- Opens automatically when a session has a browser tab; the sidebar guide page also has a "WebPilot" entry.
- The panel is a **live picture** (CDP screencast → canvas) and accepts real mouse, wheel, keyboard and IME input, which is replayed into the tab the agent is using. It is not a screenshot viewer.
- The address bar actually works: click it, type, press `Enter` (`Ctrl/⌘+L` focuses, `Esc` cancels; a bare domain gets `https://`, `localhost` gets `http://`). Back / forward / reload sit next to it, so the human never has to ask the agent just to change URL.
- Light theme that follows the Web GUI palette: white glass, blue-grey hairlines, a deepened accent colour.
- Status bar shows `● LIVE` / `STANDBY` / `HUMAN-TAKEOVER`; the bottom-left HUD logs every agent action.
- Agent action effects are drawn on the panel's own overlay canvas, never injected into the visited page: spider-cursor flight, click ripples with a target bracket, a reading scanline with data particles, scroll light bands, a navigation glitch flash. `prefers-reduced-motion` is respected.
- The takeover banner only appears in the panel of the session that requested it; pressing "Done" resolves the waiting tool call, optionally with a short note.

## Requirements

- DSH with a `web` profile; `dsh` engine `>= 0.1.5-rc.2` (`package.json` → `dsh.engines`).
- Node.js `>= 22.19`.
- Chrome or Chromium on the host (auto-detected; override with `browserPath`).
- Optional: Xvfb for `mode: auto` headed rendering on a machine without X; SwiftShader for WebGL there.

## Install

Adding a plugin row is a **startup-time** composition change; the web profile has no HMR. Restarting the DSH process also kills the agent turn that is running in the same process, so the installer must run **detached from the agent's process tree**.

```sh
# Idempotent: backs up the profile manifest → registers dependency (link:) + bundle
#              → creates the node_modules symlink → restarts the service → waits for
#              the port → swaps the token cookie → probes /api/dsh-webpilot/health.
# On failure it rolls back (manifest + symlink) and restarts once more.
# The whole run is logged to scripts/install.log.
sudo systemd-run --unit=dsh-webpilot-install --collect --property=Type=oneshot \
  /bin/bash /root/workspace/plugins/dsh-webpilot/scripts/install.sh

# Equivalent without systemd (needs its own process group and must not be killed
# by the agent's cgroup):
#   setsid nohup /bin/bash /root/workspace/plugins/dsh-webpilot/scripts/install.sh >/dev/null 2>&1 &
```

Refresh the Web UI afterwards; the "WebPilot" entry appears in the right-sidebar guide page. No X server is required: `mode: auto` starts a private Xvfb and runs headed there (the page sees a real 1440x900 screen), falling back to `--headless=new` only if that fails.

Manual install (when you edit the manifest yourself): add `"dsh-webpilot": "link:/root/workspace/plugins/dsh-webpilot"` to `dependencies`, append `"dsh-webpilot"` to the `dsh.profile.bundles` array, create a symlink with the same name under the profile's `node_modules/`, then restart.

Uninstall (keeps the Chrome profile and logins; add `--purge` to delete the profile too):

```sh
sudo systemd-run --unit=dsh-webpilot-uninstall --collect --property=Type=oneshot \
  /bin/bash /root/workspace/plugins/dsh-webpilot/scripts/uninstall.sh
```

## Configuration

Override any field in the profile's patch layer. `config` is a whole-key replacement, not a deep merge:

```yaml
- id: webpilot
  config:
    mode: headless              # auto | headed | headless
    viewport: 1440x900          # page viewport; also the effect coordinate space
    idleShutdownMinutes: 30     # stop the browser after N idle minutes; 0 = never
    effects: true               # false = host stops emitting fx events
    effectLeadMs: 260           # time reserved for the animation before the action lands
    lazyTools: false            # true = publish tools only after the browser-use skill gate
    languages: 'zh-CN,zh,en'    # empty = inherit the host; otherwise --lang / --accept-lang
    timezone: 'Asia/Shanghai'   # empty = inherit the host; otherwise TZ for the Chrome process
    extraArgs:                  # extra Chrome switches, e.g. software rendering without a GPU
      - --enable-unsafe-swiftshader
```

Common fields and defaults (full list in `DEFAULT_CONFIG` in `lib/index.js`):

| Field | Default | Meaning |
|---|---|---|
| `browserPath` | `''` | Explicit Chrome/Chromium binary; empty = auto-detect |
| `profileDir` | `''` | Persistent profile; empty = `$DSH_HOME/webpilot/profile` |
| `mode` | `auto` | Headed on a private Xvfb when possible, otherwise headless |
| `screen` / `windowSize` / `viewport` | `1440x900x24` / `1440x900` / `1440x900` | Virtual display, Chrome window, page viewport |
| `port` | `0` | Fixed DevTools port; 0 picks a free one |
| `startUrl` | `about:blank` | First URL of a fresh session tab |
| `snapshotMaxChars` / `maxElements` | `4000` / `80` | Snapshot text budget and element cap |
| `screencastQuality` / `screencastMaxWidth` | `60` / `1440` | Panel picture quality and max streamed width |
| `askHumanTimeoutSeconds` | `600` | Default budget of `webpilot_ask_human` |
| `idleShutdownMinutes` | `10` | Idle shutdown; `0` keeps the browser alive |
| `autoStart` | `false` | Launch Chrome with the host instead of on first tool call |
| `startTimeoutMs` | `20000` | Wait for the DevTools endpoint after launch |
| `effectLeadMs` / `effects` | `260` / `true` | Panel effect timing and on/off switch |

Host environment variables:

| Variable | Used by | Meaning |
|---|---|---|
| `DSH_HOME` | plugin | Base for the default profile (`$DSH_HOME/webpilot/profile`) |
| `DSH_PROFILE_DIR` | `scripts/install.sh` | Profile directory to modify (default `/root/.dsh/profiles/web`) |
| `DSH_SERVICE` | `scripts/install.sh` | systemd unit to restart (default `deepseek-harness`) |
| `DSH_WEB_HOST` / `DSH_WEB_PORT` | `scripts/install.sh` | Where the health probe goes (default `127.0.0.1:3080`) |

`languages` and `timezone` matter for sites you log into: headless Chrome answers `en-US` and `Etc/Unknown` (offset 0), while the account's timezone may be UTC+8 — an egress IP in one country and a browser locale in another is one of the strongest bot-wall signals. `mode: auto` plus Xvfb also reports a real `1440x900` screen (headless says `800x600`), and WebGL needs the SwiftShader fallback, otherwise `getContext('webgl')` returns `null`.

## Usage

**Human**: open WebPilot in the right sidebar, watch the page the agent is on, and when a login is needed the agent calls `webpilot_ask_human`; scan the code or type the password, then press "Done".

**Agent** (example prompts):

> Open https://example.com with webpilot_navigate, read the page with webpilot_snapshot, then click the first link.

> Open https://console.cloud.tencent.com; if it asks for a login, call webpilot_ask_human and say "please scan the QR code and press Done when finished".

Login state lives in `$DSH_HOME/webpilot/profile` by default and is shared by every session; `webpilot_close` and idle reclamation do not affect it.

## Verification

```sh
node e2e/backend-smoke.mjs   # host half: real Chrome, fx ordering, clicks land on the page, screenshots (no DSH needed)
node e2e/routes-smoke.mjs    # HTTP: auth gate, health/sessions/state, open→close
node e2e/auto-reveal.mjs     # fresh Chrome profile: panel reveals in the sidebar, stays closed after manual collapse
node e2e/address-bar.mjs     # panel address bar: type → Enter → real navigation, bare-word rejection, Ctrl+L/Esc, no text overlap
node e2e/gui-verify.mjs      # one real agent turn: panel LIVE, picture, NAV/READ HUD, fx painted, 0 console errors
node e2e/run-all.mjs         # runs the above and writes e2e/shots/run-all-*/summary.json
```

The e2e suite uses an **isolated dev instance** (`DSH_HOME=/root/workspace/.dsh-dev`, port 3090, raw CDP, no Playwright) and never touches production on 3080. Steps and artifacts are described in `e2e/README.md`.

Local run (2026-11-18): `run-all` **5/5 PASS** — backend 57/57, routes 23/23, auto-reveal 15/15, address-bar 16/16, gui-verify 24/24; screenshots in `e2e/shots/<run>/` (`hero/hero-panel.png` is the finished panel shot, `03-panel-standby.png` is the empty state). After installing to production, `scripts/postinstall-gui.mjs` runs 9 probes (GUI boots, right-sidebar shell mounted, health 200, no uncaught exceptions); `scripts/install.sh` runs it after the health check, and a failed probe does not change the install result.

Production check (2026-11-18, port 3080, after install):

- `scripts/install-result.json`: `ok:true`, health `200`, service `active`;
- `scripts/postinstall-gui.json`: **9/9 PASS**;
- the same `gui-verify` run against production: **24/24 PASS** — a real agent turn opened example.com via `webpilot_navigate`, read it via `webpilot_snapshot`, the panel went LIVE, `NAV`/`READ` appeared in the HUD, fx actually painted, 0 console errors; evidence in `e2e/shots/live-2026-11-18/`.

> Tools are injected per session: **new sessions** opened after the plugin is installed see `webpilot_*`; sessions that already existed at install time may not.

## Security

- The panel and its WebSocket use the **same authentication** as the DSH Web UI (`connection.requestRejection`). Anyone who can open the panel could already drive the host browser.
- Sessions are isolated by **page state**, not identity: one shared profile means every session shares the same logins. That is the point of the product, and also its main risk.
- The profile holds real session cookies and stays on the host; it is never uploaded.
- The CDP port binds to `127.0.0.1`; input replay only uses baseline-whitelisted messages and never exposes `Runtime.evaluate` to the page.
- Run Chrome as a non-root user with the sandbox on where possible; `--no-sandbox` is only added when the host itself is root.
- Anti-bot note: headless UA is corrected and `AutomationControlled` is disabled; interactive human challenges can be solved in the panel, but a **silent managed challenge is a hard block** (e.g. `zh.minecraft.wiki`). The plugin reports that honestly instead of pretending to get through.

## Known limitations

- Installing or removing the plugin restarts the host, which kills a running agent turn; that is why the scripts must be started detached (see Install).
- No display and no Xvfb means headless: the page sees `800x600` unless `screen`/`viewport` say otherwise, and WebGL may be unavailable without SwiftShader.
- `webpilot_snapshot` truncates page text (`snapshotMaxChars`, default 4000) and lists at most `maxElements` (default 80) elements; long pages need scrolling or a second snapshot.
- Idle shutdown (default 10 minutes) stops Chrome and all session tabs; logins stay in the profile. Set `idleShutdownMinutes: 0` to keep the browser up.
- The panel picture is a screencast, not a remote desktop: native dialogs, file pickers and browser chrome are outside it, and very high frame rates degrade to polling on panels that cannot own the foreground stream.
- Tools appear only in sessions created after installation (see the note above).
- `lazyTools: true` hides the tools until the browser-use skill opens the gate; if you expect the tools to be listed immediately, keep it `false`.

## Directory layout

```
package.json            plugin manifest: dsh.bundle.patch, dsh.client (web), engines
cordis.patch.yml        bundle patch: insert id=webpilot
lib/index.js            host half: config, Chrome lifecycle, routes, tool registration, prompt hint
lib/browser.js          BrowserManager: one Chrome, session tabs, profile, Xvfb/headless launch
lib/cdp.js              minimal CDP client (raw WebSocket, no Puppeteer)
lib/screencast.js       screencast hub: frame streaming to panels
lib/ws.js               WebSocket upgrade for the panel stream
lib/routes.js           /api/dsh-webpilot/{state,sessions,open,close,human-done,health,stream}
lib/fx.js               fx event payloads (element box, pre-action, reading area)
lib/human.js            ask-human broker (pending handover, Done signal, timeout)
lib/tools.js            the ten webpilot_* tool definitions
lib/lazy.js             browser-use skill gate for the tools
lib/define-tool.js      local shim replacing @deepseek-ai/dsh-tools at runtime
lib/client.js           client half: right-sidebar panel, picture, effects overlay, address bar
docs/                   RESEARCH.md, INTERFACE.md, HANDOFF.md, upstream README (zh)
e2e/                    e2e scripts, isolated dev harness and screenshot runs
dev/harness.html        standalone panel harness used during development
scripts/                install.sh / uninstall.sh / postinstall-gui.mjs / logs and result JSON
```

## Upstream and license

- Baseline: `imroc/dsh-embedded-browser` v0.3.0, MIT. The original README is kept at [docs/UPSTREAM-README.zh.md](docs/UPSTREAM-README.zh.md); the license and copyright notice are in [LICENSE](LICENSE).
- This fork renames tools, routes and the profile directory; drops runtime dependencies on `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` (local shims instead); adds the fx event layer (element box, pre-action event, reading area), Chrome UA and anti-automation switches, and the rewritten client visual/effects layer. It is released under MIT as well and keeps the upstream copyright notice.
- Note: `LICENSE` carries `Copyright (c) 2026 roc`, which is the notice kept from upstream; this repository does not add a separate copyright line.
