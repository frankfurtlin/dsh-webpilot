# Harness verification log — client half (webpilot-ui)

`dev/harness.html` is the standalone demo/acceptance page: it loads the real
`lib/client.js`, injects the real `FX.css`, paints a procedural fake wiki page
as the "screenshot", mounts the same `createFxEngine()` overlay and fires
synthetic `{type:'fx',kind:…}` events. Buttons fire single effects; **replay
all** runs the staggered composition; **standby ⇄ live** shows the empty-panel
state. `window.__harness` exposes `{engine, compose, fire, standby, stats,
ladder}` for headless assertions.

## How to screenshot it

The line from the task brief works in a normal desktop environment:

```bash
/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  --headless=new --no-sandbox --disable-gpu --window-size=1280,900 \
  --screenshot=/tmp/webpilot-harness.png \
  file:///root/workspace/plugins/dsh-webpilot/dev/harness.html
```

On this host the one-shot `--screenshot` mode hangs inside the sandbox (no
writable `/dev/shm`, no unique `--user-data-dir`), so verification uses raw CDP
instead — same Chrome binary, no Playwright:

```bash
# /tmp/cdp/lib.mjs is the minimal CDP client used for this repo's checks
node /tmp/fxtest/final.mjs   # writes the four PNGs and prints the assertions
```

Captured artifacts (in `dev/screenshots/`):

| file | state |
| --- | --- |
| `live-fx.png` | LIVE panel at composition peak: read brackets + scanline, click ripple, flying spider, type box, scroll bands, key badge, nav glitch |
| `standby.png` | `WEBPILOT STANDBY` + OPEN BROWSER button, STANDBY pill, grayscale tone |
| `reduced-motion.png` | `prefers-reduced-motion: reduce` → static brackets/fades only, no flights or scanlines |

## Assertions of the last run (2026-11-18, Chrome for Testing 153, 1280×900)

- `node --check lib/client.js` → OK (3270 lines, 131 845 B)
- harness loaded with **0 console errors, 0 uncaught exceptions**
- live panel DOM: `[data-dsh-webpilot]`, `.wp-head`, `.wp-mark-badge`,
  `.wp-pill`, `.wp-urlrow`, `.wp-tools`, `.wp-stage`, `.wp-frame`, `.wp-fx`,
  `.wp-hud`, `.wp-hud-foot` — one each; no horizontal overflow
- contain-fit at 600×719 stage: frame 600×375 at y=316.9 (page 1440×900,
  scale 0.4167, oy 172), fx canvas painted 225 829 px at peak
- fx engine: 68 live items at peak, HUD exactly 6 lines
  (read/click/type/scroll/key/nav), `reduced` flag true only under the media
  emulation
- standby toggle: full-stage overlay, `data-tone="standby"`, label STANDBY,
  `Open browser` button present
- reveal-ladder self-test (`__harness.ladder`, fake Sidebar service):
  - hand-collapse during the first 100 ms → `openTabIn 0 / openTab 0`
  - never-expanded column → `openTabIn 2, expand 1, tabs 1, expanded true`
  - the `webpilot:sessions` wake event → one extra `/sessions` fetch within
    180 ms (fallback poll is 1500 ms)
  - overall `passed: true`

## Known limits of this harness

- The harness panel is a static mirror of the plugin DOM (hand-built), not a
  real DSH slot render: it proves the visual layer + fx renderer, not the
  Sidebar integration. That path is covered by `e2e/` against the live GUI.
- The fake page is a canvas, so the panel never receives real JPEG frames here;
  `paint()` / fps / input replay are exercised in the e2e runs only.
