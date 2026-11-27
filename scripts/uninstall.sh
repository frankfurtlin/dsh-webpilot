#!/usr/bin/env bash
# Remove dsh-webpilot from the live DSH web profile and restart the service.
# Keeps the Chrome profile on disk ($DSH_HOME/webpilot/profile) so a later
# reinstall is still logged in. Pass --purge to delete that profile too.
#
# Same detached invocation pattern as install.sh; see README.md.
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SERVICE="${DSH_SERVICE:-deepseek-harness}"
WEB_PORT="${DSH_WEB_PORT:-3080}"
BASE="http://127.0.0.1:${WEB_PORT}"
LOG="$PLUGIN_DIR/scripts/install.log"
PKG="$PROFILE_DIR/package.json"
BACKUP="$PROFILE_DIR/package.json.webpilot.bak"
LINK="$PROFILE_DIR/node_modules/dsh-webpilot"
PURGE=0

[ "${1:-}" = "--purge" ] && PURGE=1

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
say() { printf '%s  %s\n' "$(date -Is)" "$*"; }

say "==================== uninstall start (purge=$PURGE) ===================="
[ "$(id -u)" -eq 0 ] || { say "FAILED: must run as root"; exit 2; }

node - "$PKG" <<'NODE' || exit 5
const fs = require('fs')
const pkgPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
const had = (manifest.dependencies ?? {})['dsh-webpilot'] !== undefined
  || (Array.isArray(bundles) && bundles.includes('dsh-webpilot'))
if (!had) {
  console.log('profile does not list dsh-webpilot; nothing to remove')
  process.exit(0)
}
if (manifest.dependencies) delete manifest.dependencies['dsh-webpilot']
if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-webpilot')
fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('manifest cleaned')
NODE

rm -f "$LINK"
say "removed $LINK"

if [ "$PURGE" -eq 1 ]; then
  rm -rf "${DSH_HOME_DIR}/webpilot/profile"
  say "purged Chrome profile ${DSH_HOME_DIR}/webpilot/profile (logins are gone)"
fi

systemctl restart "$SERVICE"
say "restart issued; waiting for $BASE ..."
for _ in $(seq 1 120); do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE/" || true)"
  if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "302" ]; then
    say "OK: service back (HTTP $code). dsh-webpilot uninstalled; backup kept at $BACKUP"
    say "==================== uninstall done ===================="
    exit 0
  fi
  sleep 1
done
say "service did not answer within 120s (state: $(systemctl is-active "$SERVICE"))"
exit 10
