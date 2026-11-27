#!/usr/bin/env bash
# Install dsh-webpilot into the live DSH web profile, then restart the service
# and prove the plugin is actually serving its routes.
#
# Run detached from the agent's turn, because the restart kills the DSH process
# that hosts the agent — see README.md ("安装") for the exact invocation.
#
# Idempotent: running it twice changes nothing the second time. If the service
# does not come back or the plugin health check fails, the profile manifest is
# restored and the service is restarted again with the old roster.
#
# Everything is logged to scripts/install.log (append, timestamped).
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
SERVICE="${DSH_SERVICE:-deepseek-harness}"
WEB_PORT="${DSH_WEB_PORT:-3080}"
WEB_HOST="${DSH_WEB_HOST:-127.0.0.1}"
BASE="http://${WEB_HOST}:${WEB_PORT}"
LOG="$PLUGIN_DIR/scripts/install.log"
BACKUP="$PROFILE_DIR/package.json.webpilot.bak"
JAR="$(mktemp /tmp/webpilot-cookies.XXXXXX)"
PKG="$PROFILE_DIR/package.json"
LINK="$PROFILE_DIR/node_modules/dsh-webpilot"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

say() { printf '%s  %s\n' "$(date -Is)" "$*"; }
fail() { say "FAILED: $*"; }

say "==================== install start (pid $$) ===================="
# The service runs on one specific Node build (nvm). systemd's own PATH may
# resolve `node` to a much older version without a global WebSocket, so resolve
# the same binary the service uses and use it for every node call below.
NODE_BIN=""
if svc_exec="$(systemctl show -p ExecStart --value "$SERVICE" 2>/dev/null)"; then
  svc_dir="$(printf '%s\n' "$svc_exec" | sed -n 's/.*path=\([^ ;]*\)\/[^/]* ;.*/\1/p' | head -1)"
  if [ -n "$svc_dir" ] && [ -x "$svc_dir/node" ]; then NODE_BIN="$svc_dir/node"; fi
fi
[ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { fail "no node binary found (service ExecStart unparsable and node not on PATH)"; exit 2; }


# ---------------------------------------------------------------- preflight
[ "$(id -u)" -eq 0 ] || { fail "must run as root"; exit 2; }
for f in package.json lib/index.js lib/client.js cordis.patch.yml; do
  [ -f "$PLUGIN_DIR/$f" ] || { fail "missing $PLUGIN_DIR/$f"; exit 2; }
done
"$NODE_BIN" --check "$PLUGIN_DIR/lib/index.js" || { fail "lib/index.js has a syntax error"; exit 3; }
"$NODE_BIN" --check "$PLUGIN_DIR/lib/client.js" || { fail "lib/client.js has a syntax error"; exit 3; }
"$NODE_BIN" --check "$PLUGIN_DIR/lib/browser.js" || { fail "lib/browser.js has a syntax error"; exit 3; }
[ -f "$PKG" ] || { fail "no profile manifest at $PKG"; exit 2; }
say "preflight ok (plugin=$PLUGIN_DIR profile=$PROFILE_DIR service=$SERVICE node=$NODE_BIN $("$NODE_BIN" -v 2>/dev/null))"

# ---------------------------------------------------------------- snapshot
if [ ! -f "$BACKUP" ]; then
  cp -p "$PKG" "$BACKUP" || { fail "cannot back up $PKG"; exit 4; }
  say "backup written: $BACKUP"
else
  say "backup already exists, keeping it: $BACKUP"
fi
OLD_LINK_TARGET=""
[ -L "$LINK" ] && OLD_LINK_TARGET="$(readlink "$LINK")"

# ---------------------------------------------------------------- manifest
# dependencies["dsh-webpilot"] = "link:<path-to-checkout>"
# dsh.profile.bundles gains "dsh-webpilot" (right after the app bundles).
"$NODE_BIN" - "$PKG" "$PLUGIN_DIR" <<'NODE' || { fail "manifest edit failed"; exit 5; }
const fs = require('fs')
const [pkgPath, pluginDir] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const nextDeps = { ...manifest.dependencies, 'dsh-webpilot': `link:${pluginDir}` }
const nextBundles = bundles.includes('dsh-webpilot') ? bundles : [...bundles, 'dsh-webpilot']
const changed = JSON.stringify(nextDeps) !== JSON.stringify(manifest.dependencies)
  || JSON.stringify(nextBundles) !== JSON.stringify(bundles)
if (!changed) {
  console.log('manifest already lists dsh-webpilot; nothing to write')
  process.exit(0)
}
manifest.dependencies = nextDeps
manifest.dsh.profile.bundles = nextBundles
fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`manifest updated: dependency=dsh-webpilot@link:${pluginDir}, bundles=${nextBundles.length}`)
NODE

# ---------------------------------------------------------------- module link
rm -f "$LINK"
ln -s "$PLUGIN_DIR" "$LINK" || { fail "cannot link $LINK"; exit 6; }
say "linked $LINK -> $PLUGIN_DIR"

# ---------------------------------------------------------------- restart
say "restarting $SERVICE ..."
systemctl restart "$SERVICE" || { fail "systemctl restart returned non-zero"; }
say "restart issued, waiting for $BASE ..."

UP=0
for _ in $(seq 1 120); do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE/" || true)"
  if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "302" ]; then UP=1; break; fi
  sleep 1
done
if [ "$UP" -ne 1 ]; then
  fail "service did not answer on $BASE within 120s — rolling back"
  cp -p "$BACKUP" "$PKG"
  if [ -n "$OLD_LINK_TARGET" ]; then ln -sfn "$OLD_LINK_TARGET" "$LINK"; else rm -f "$LINK"; fi
  systemctl restart "$SERVICE"
  say "rollback done; service state: $(systemctl is-active "$SERVICE")"
  exit 10
fi
say "service answered: HTTP $code"

# ---------------------------------------------------------------- health
# The GUI token is printed once per start; exchange it for a cookie, then ask
# the plugin's own health route (401 on that route means it is not mounted).
TOKEN=""
for _ in $(seq 1 20); do
  TOKEN="$(journalctl -u "$SERVICE" --since '-4 min' --no-pager 2>/dev/null \
    | grep -oE "http://[^ ?]+/\?token=[A-Za-z0-9_-]+" | tail -1 | sed 's/.*token=//')"
  [ -n "$TOKEN" ] && break
  sleep 1
done

HEALTH_CODE="000"
if [ -n "$TOKEN" ]; then
  curl -s -c "$JAR" -o /dev/null -m 5 "$BASE/?token=$TOKEN" || true
  HEALTH_CODE="$(curl -s -b "$JAR" -o /tmp/webpilot-health.json -m 5 -w '%{http_code}' "$BASE/api/dsh-webpilot/health" || true)"
  say "health route: HTTP $HEALTH_CODE $(head -c 240 /tmp/webpilot-health.json 2>/dev/null)"
else
  fail "no launch token found in journal; cannot verify health by cookie"
fi

for route in state sessions; do
  c="$(curl -s -b "$JAR" -o /dev/null -m 5 -w '%{http_code}' "$BASE/api/dsh-webpilot/$route?session=__probe__" || true)"
  say "route /$route: HTTP $c"
done

rm -f "$JAR"

# ---------------------------------------------------------------- GUI probe
# Health only proves the route exists. The probe drives a real headless browser
# through the GUI to prove the sidebar shell, the composer and the plugin tab
# mount on the live instance. Non-fatal: a probe failure must never roll back a
# working install, it only gets reported.
if [ -f "$PLUGIN_DIR/scripts/postinstall-gui.mjs" ]; then
  say "gui probe: starting (headless browser, ~20s)"
  if TZ="${TZ:-Asia/Shanghai}" WEBPILOT_TOKEN="$TOKEN" \
       "$NODE_BIN" "$PLUGIN_DIR/scripts/postinstall-gui.mjs" >>"$LOG" 2>&1; then
    say "gui probe: PASS ($PLUGIN_DIR/scripts/postinstall-gui.json)"
  else
    say "gui probe: FAIL (see scripts/postinstall-gui.json) — install is unaffected"
  fi
fi

# ---------------------------------------------------------------- plugin logs
# The health route proves the host half mounted; the journal lines below prove
# the panel surfaces and the tool suite came up with it.
PLUGIN_LOGS="$(journalctl -u "$SERVICE" --since '-5 min' --no-pager 2>/dev/null | grep -i 'webpilot' | tail -20 || true)"
say "--- plugin journal lines ---"
printf '%s\n' "$PLUGIN_LOGS" | sed 's/^/    /'
say "--- end plugin journal ---"

# ---------------------------------------------------------------- verdict
if [ "$HEALTH_CODE" = "200" ]; then
  STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || echo unknown)"
  say "OK: dsh-webpilot is installed and serving (health 200, service $STATE)"
  say "launch: $BASE/?token=<rotated>   service: $STATE"
  "$NODE_BIN" - "$PLUGIN_DIR/scripts/install-result.json" "$BASE" "$HEALTH_CODE" "$STATE" "$PLUGIN_LOGS" <<'NODE' || true
const fs = require('fs')
const [out, base, health, state, logs] = process.argv.slice(2)
fs.writeFileSync(out, JSON.stringify({
  ok: health === '200',
  checkedAt: new Date().toISOString(),
  base,
  health,
  serviceState: state,
  pluginLogLines: logs.split('\n').filter(Boolean),
}, null, 2) + '\n')
NODE
  say "result: $PLUGIN_DIR/scripts/install-result.json"
  say "==================== install done ===================="
  exit 0
fi

fail "health check got HTTP $HEALTH_CODE — plugin not serving; rolling back"
cp -p "$BACKUP" "$PKG"
if [ -n "$OLD_LINK_TARGET" ]; then ln -sfn "$OLD_LINK_TARGET" "$LINK"; else rm -f "$LINK"; fi
systemctl restart "$SERVICE"
say "rollback done; service state: $(systemctl is-active "$SERVICE")"
say "==================== install rolled back ===================="
exit 11
