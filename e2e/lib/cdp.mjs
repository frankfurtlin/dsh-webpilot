// Minimal CDP client over Node 24 built-in WebSocket. No npm deps.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultChrome, defaultHeadlessShell } from './chrome.mjs';

export const CHROME = defaultChrome();
export const SHELL = defaultHeadlessShell();

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // "method" or "method@session" -> [fn]
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' (' + msg.error.code + ')'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const key = msg.method;
        const keys = msg.sessionId ? [key, key + '@' + msg.sessionId] : [key];
        for (const k of keys) for (const fn of this.handlers.get(k) || []) {
          try { fn(msg.params, msg.sessionId); } catch (e) { console.error('handler err', e.message); }
        }
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error ' + url)), { once: true });
    });
    return new CDP(ws);
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export async function launch(opts = {}) {
  const {
    port = 9001, headless = true, userDataDir = '/tmp/cdp/profile-' + port,
    exe = CHROME, extraArgs = [], width = 1280, height = 800, shellMode = false,
  } = opts;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage',
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--disable-features=Translate,MediaRouter',
    ...extraArgs,
  ];
  if (shellMode) args.push('--headless');
  else if (headless) args.push('--headless=new');
  args.push('about:blank');

  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('exit', (code) => { proc.exitCode = code; });

  const deadline = Date.now() + 20000;
  let ver = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch {}
    await sleep(150);
  }
  if (!ver) { proc.kill('SIGKILL'); throw new Error('chrome did not start on ' + port + '\n' + stderr.slice(-2000)); }

  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
  cdp.proc = proc;
  cdp.version = ver;
  cdp.stderrTail = () => stderr.slice(-3000);
  return cdp;
}

export async function newPage(cdp, width = 1280, height = 800, dpr = 1) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
  return { targetId, sessionId };
}

export async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

export async function waitLoad(cdp, sessionId, timeout = 30000) {
  // Resolve on Page.loadEventFired after navigation starts.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    cdp.on('Page.loadEventFired@' + sessionId, finish);
    setTimeout(finish, timeout);
  });
}

export async function navigate(cdp, sessionId, url, timeout = 30000) {
  const p = waitLoad(cdp, sessionId, timeout);
  const res = await cdp.send('Page.navigate', { url }, sessionId);
  await p;
  return res;
}

export { sleep };

// CPU sampling from /proc/<pid>/stat: utime+stime delta over window.
export function cpuSampler(pid) {
  const read = () => {
    try {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      return (parseInt(f[11]) + parseInt(f[12])) / 100; // clock ticks -> seconds (100Hz)
    } catch { return null; }
  };
  const start = read();
  const t0 = Date.now();
  return () => {
    const now = read();
    const secs = (Date.now() - t0) / 1000;
    if (start == null || now == null) return null;
    return { cpuSec: +(now - start).toFixed(2), wallSec: +secs.toFixed(2), pctOfOneCore: +(((now - start) / secs) * 100).toFixed(1) };
  };
}
