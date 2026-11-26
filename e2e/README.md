# dsh-webpilot e2e acceptance

Browser-level acceptance for the WebPilot side panel, driven through a **real
DSH Web GUI on an isolated dev instance** with raw CDP. There is no Playwright
dependency: `e2e/lib/cdp.mjs` is a ~150-line zero-dependency CDP client built on
Node's `WebSocket`, and Chrome comes from the Playwright cache already on this
box.

- dev instance: `http://127.0.0.1:3090` (`DSH_HOME=/root/workspace/.dsh-dev`)
- **never** touches the live DSH on `:3080` or `/root/.dsh`
- artifacts: `e2e/shots/` (`png` screenshots + `summary.json` per run)

## Layout

| file | scope | what it checks |
| --- | --- | --- |
| `backend-smoke.mjs` | host half, no DSH runtime | `BrowserManager` over real Chrome: clean UA, nav/read/click/scroll effects in contract order, page-space boxes, screenshots, quiet run with `effects:false`; plus the agent-ergonomics batch — link `href`s in the inventory, a real drag (press → held moves → release), `wait` on late text / timeout / disappearance, and an `ask_human` handover that refreshes an expired QR and reports `loginState` |
| `routes-smoke.mjs` | HTTP | auth gate, `GET /health`, `/sessions`, `/state`, `/state` GET-only, `POST /open` → session appears with URL/title → `POST /close`, session gone; browser-process warm reuse is reported consistently |
| `auto-reveal.mjs` | GUI, fresh Chrome profile | first use (right column never opened) + `POST /open` from the page ⇒ side column expands **by itself**, WebPilot tab exists & is selected, panel stage/fx/frame render, no console error; then a manual collapse must stick (no auto re-expand) |
| `gui-verify.mjs` | GUI, full agent turn | GUI boots from the launch-token URL; Start guide opens the tab; panel shows STANDBY; an agent turn calling `webpilot_navigate` + `webpilot_snapshot` on `https://example.com` turns it LIVE (picture canvas, NAV/READ HUD lines, fx pixels painted); `health`/`state` answer 200; no console error |
| `run-all.mjs` | orchestration | runs the steps in the order above, writes one combined `summary.json` |

`e2e/lib/cdp.mjs` — vendored CDP client: `launch`, `newPage`, `evaluate`, `navigate`, `sleep`.
`e2e/lib/dev.mjs` — dev-instance helpers: read the launch token from
`.dsh-dev/dev.log`, log in for the auth cookie, call the panel API, `waitFor`.

## Prerequisites

Node ≥ 22 (uses the built-in `WebSocket`), Chromium at
`/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` (override with
`WEBPILOT_CHROME` for the host smoke), no X server needed.

The dev instance must be running. It is a separate profile under
`/root/workspace/.dsh-dev`; the live service on `:3080` is never touched.

```bash
# 1. one-time profile (already present in this box)
#    .dsh-dev/profiles/dev/{package.json,cordis.yml,cordis.patch.yml}
#    node_modules/dsh-webpilot -> /root/workspace/plugins/dsh-webpilot
#    cordis.patch.yml carries llm-pi-ai + agent-default-model rows and
#    .dsh-dev/.credentials.yaml is a mode-600 copy of the live credentials.

# 2. start the isolated dev instance (TZ is required, see note below)
cd /root/workspace/.dsh-dev && \
  TZ=Asia/Shanghai DSH_HOME=/root/workspace/.dsh-dev \
  dsh --profile dev --port 3090 --no-open > /root/workspace/.dsh-dev/dev.log 2>&1 &

# 3. the launch token lives on the first line of dev.log
head -1 /root/workspace/.dsh-dev/dev.log
```

**`TZ=Asia/Shanghai` is required.** This box's `/etc/localtime` points at
`Asia/Beijing`, which is not an IANA name, so with `TZ` unset both Node and
headless Chrome report `undefined` as their time zone and the GUI rejects every
send with `clientTimeZone must be UTC or a valid IANA Area/Location name`. The
scripts set `TZ` themselves; keep it when starting DSH by hand.

The agent step needs a model: `dsh-webpilot`'s dev profile composes
`llm-pi-ai` + `agent-default-model` (`opencode-go` / `deepseek-v4.1-flash`) from
the live profile, with a read-only copy of the credentials file. Without it only
use `--no-agent` and the non-model checks.

## Run

From the plugin root (`/root/workspace/plugins/dsh-webpilot`):

```bash
# everything (host smoke, routes, auto-reveal, GUI+agent)
TZ=Asia/Shanghai node e2e/run-all.mjs

# skip slow/partial steps
TZ=Asia/Shanghai node e2e/run-all.mjs --no-backend --no-gui

# a single step
TZ=Asia/Shanghai node e2e/routes-smoke.mjs
TZ=Asia/Shanghai node e2e/auto-reveal.mjs
TZ=Asia/Shanghai node e2e/gui-verify.mjs [--no-agent] [--keep-open]
```

Environment knobs:

| variable | default | meaning |
| --- | --- | --- |
| `DSH_DEV_URL` | parsed from `dev.log` | override dev instance base URL |
| `E2E_SHOTS` | `e2e/shots` | artifact root |
| `CDP_PORT` | `9333` | debug port of the test Chrome |
| `E2E_CHROME_PROFILE` | `.dsh-dev/e2e/chrome-profile` | GUI Chrome profile (reused; the script opens a fresh session) |
| `E2E_WORKSPACE` | `.dsh-dev/e2e/workspace` | workspace added on first boot |
| `E2E_AGENT_TIMEOUT_MS` | `180000` | agent-turn wait |
| `E2E_REVEAL_TIMEOUT_MS` | `10000` | auto-reveal wait (the watcher polls 1.5 s and is woken by WS state) |
| `E2E_PROMPT` | navigate+snapshot prompt | agent prompt override |
| `WEBPILOT_CHROME` | Playwright cache chrome | host smoke binary |

Exit codes: `0` PASS, `1` FAIL, `2` dev instance unreachable (`run-all.mjs`).

## Artifacts

Each script writes `e2e/shots/<step>-<stamp>/`:

- `01-gui-boot.png`, `02-sidebar-empty.png`, `03-panel-standby.png` — GUI boot, empty right column, panel STANDBY
- `04-agent-submitted.png`, `05-panel-live.png` — prompt sent, panel LIVE during the agent turn
- `05b-fx-peak.png`, `05c-panel-live-clip.png`, `06-panel-closeup.png` — clipped panel close-ups at the fx peak and the live moment (delivery evidence)
- `06-final-gui.png` — whole workbench at the end
- `summary.json` — every named check with `ok`/`detail`, console errors, timing
  (`runTrace.elapsedMs`, `maxPainted` fx pixels), and screenshot paths

`run-all.mjs` adds `e2e/shots/run-all-<stamp>/summary.json` with per-step
status, exit codes, ok/FAIL counts and each step's evidence path.

## Cleanup

`gui-verify.mjs` closes its Chrome and kills its own process on exit (unless
`--keep-open`). Browser sessions it opened are closed through the panel API.
Chrome processes belonging to other projects (`/tmp/cdp/profile-*`) are left
alone; only the `CDP_PORT`/`E2E_CHROME_PROFILE` of this suite are owned.

The dev instance may be left running (it is isolated) or stopped with its
background job. Live DSH on `:3080` is never restarted or written to.

## Not covered

- The human-takeover flow (`webpilot_ask_human` + human reply) is not automated.
- Mobile/narrow viewport rendering and real remote-host latency are out of scope.
- The model-dependent step needs working `opencode-go` credentials; when they
  are absent, run `--no-agent` and treat the agent assertions as unverified.
- Screenshots are headless Chrome captures; the live GUI on `:3080` is not
  exercised by this suite.
