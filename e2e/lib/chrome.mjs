// Resolve the Chromium binaries used by the e2e harness.
// Order: explicit env override > the playwright cache under the current user's
// home (any chromium-* build, newest last) > give up with a clear message.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(homedir(), '.cache', 'ms-playwright');

function pick(prefix, rel) {
  if (!existsSync(CACHE)) return '';
  const dirs = readdirSync(CACHE).filter((d) => d.startsWith(prefix)).sort();
  for (const d of dirs.reverse()) {
    const candidate = join(CACHE, d, rel);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export function defaultChrome() {
  return process.env.WEBPILOT_CHROME ?? pick('chromium-', 'chrome-linux64/chrome');
}

export function defaultHeadlessShell() {
  return process.env.WEBPILOT_HEADLESS_SHELL ?? pick('chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell');
}
