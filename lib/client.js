/**
 * dsh-webpilot — browser half (the right-Sidebar panel).
 *
 * One Chrome lives on the DSH host and **every DSH session owns one tab in it**.
 * This half puts that tab in the Web UI as an **on-demand right-Sidebar tab**,
 * painted as a cyber-spider control room:
 *
 * - `ctx.sidebarRightTabs` declares the page type (`kind` {@link TAB_KIND}, id
 *   {@link TAB_ID}), and the keyed `sidebar.right.pane.tab` /
 *   `sidebar.right.pane.tab.title` seats draw its body and chip. Registering a
 *   type is not opening one — no session shows a 浏览器 tab until it actually
 *   has a browser, which is what keeps the surface out of everybody else's way.
 * - The body is the live picture of *this* session's tab. The untouched base
 *   plumbing still replays the human's mouse, wheel, keyboard and IME into the
 *   very CDP target the AI drives; the rewrite in this file is the **visual and
 *   effect layer** around that picture: a dark glass frame, a terminal-style URL
 *   bar, a status strip (LIVE / STANDBY / HUMAN-TAKEOVER + fps + viewport), a
 *   bottom-left telemetry HUD, and an **fx overlay canvas** that turns the
 *   host's `{type:'fx', kind:…}` messages (click / type / read / scroll / nav /
 *   key / idle) into a pilot spider, ripples, bracket highlights, reading
 *   scanlines, data particles, scroll streaks and nav glitches.
 * - The effect renderer is deliberately self-contained and exposed on
 *   `window.WebPilotFx`, so `dev/harness.html` can drive the exact same renderer
 *   with synthetic events and a fake screenshot when no DSH is running.
 * - The slot entry is session-scoped, so the component always knows which tab it
 *   shows, and its mount/unmount lifetime *is* the focus protocol (mount asks
 *   the host to put this tab in front and stream it at full rate, unmount gives
 *   it back — unmount never closes the tab). A docked body stays mounted while
 *   its tab is inactive; the socket is still driven by visibility, so a hidden
 *   tab never steals the browser's foreground.
 * - {@link watchSessions} opens that tab by itself the moment the session has a
 *   browser, or a human request lands in a session whose tab is closed. It is
 *   the only reason a tab ever appears: nothing is pinned per session any more.
 *
 * Nothing here is ever injected into the visited page: all chrome, HUD and
 * effects are DOM/CSS/canvas of the GUI itself (INTERFACE.md §4, §6).
 *
 * Plain JavaScript on purpose: the module loader factory must not depend on a
 * build step or on npm packages beyond React, which the host provides.
 */

/* ==========================================================================
 * WebPilot FX engine — canvas renderer shared with dev/harness.html.
 *
 * Coordinates are **page viewport CSS px** (INTERFACE.md §1). The overlay
 * canvas covers the whole stage; the picture is contain-fitted inside it, so
 * every effect maps page space → overlay space with
 *   scale = min(cw / vw, ch / vh), ox = (cw - vw*scale)/2, oy = (ch - vh*scale)/2
 *   screen = (x*scale + ox, y*scale + oy)
 * The backing store is sized at devicePixelRatio and the 2D context is scaled
 * by DPR, so drawing code stays in CSS px.
 * ========================================================================== */

;(function (root) {
  'use strict'

  var MONO = 'ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Consolas,monospace'
  var TAU = Math.PI * 2
  var PALETTE = {
    cyan: [10, 124, 147],
    mint: [13, 138, 95],
    violet: [106, 79, 208],
    amber: [162, 104, 15],
    red: [207, 52, 80],
    text: [27, 43, 59],
    dim: [92, 113, 134],
    faint: [148, 167, 184]
  }

  function rgba(color, alpha) {
    var a = alpha === undefined ? 1 : Math.max(0, Math.min(1, alpha))
    return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + a + ')'
  }
  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value
  }
  function lerp(a, b, t) {
    return a + (b - a) * t
  }
  function easeOutCubic(t) {
    var u = 1 - t
    return 1 - u * u * u
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }
  function easeOutBack(t) {
    var c1 = 1.70158
    var c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  }
  function rand(min, max) {
    return min + Math.random() * (max - min)
  }
  function num(value, fallback) {
    var n = typeof value === 'number' ? value : Number(value)
    return isFinite(n) ? n : fallback
  }
  function roundRect(g, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2)
    g.beginPath()
    g.moveTo(x + radius, y)
    g.lineTo(x + w - radius, y)
    g.arcTo(x + w, y, x + w, y + radius, radius)
    g.lineTo(x + w, y + h - radius)
    g.arcTo(x + w, y + h, x + w - radius, y + h, radius)
    g.lineTo(x + radius, y + h)
    g.arcTo(x, y + h, x, y + h - radius, radius)
    g.lineTo(x, y + radius)
    g.arcTo(x, y, x + radius, y, radius)
    g.closePath()
  }

  /* ---------------------------------------------------------------- spider */

  /**
   * Draw the eight-legged pilot cursor. Local space faces +x, so the caller
   * rotates by the flight heading; legs breathe slowly when resting and
   * scuttle fast while flying.
   *
   * @param g - 2D context already translated to the cursor centre.
   * @param sc - size factor in screen px.
   * @param angle - heading in radians.
   * @param alpha - 0..1 fade.
   * @param moving - whether it is flying.
   * @param time - seconds, drives the gait.
   */
  function drawSpiderShape(g, sc, angle, alpha, moving, time) {
    if (alpha <= 0.01) return
    g.save()
    g.rotate(angle)
    g.globalAlpha = clamp(alpha, 0, 1)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    var gaitSpeed = moving ? 13 : 2.4
    var swingAmp = moving ? 0.5 : 0.12
    var L1 = 9 * sc
    var L2 = 12 * sc
    var side, i, pass
    // Three passes: a pale halo keeps the pilot readable over dark page content,
    // then a wide glow and finally the thin wire.
    for (pass = 0; pass < 3; pass += 1) {
      if (pass === 0) {
        g.shadowBlur = 0
        g.strokeStyle = 'rgba(255,255,255,0.75)'
        g.lineWidth = 3.8
      } else if (pass === 1) {
        g.shadowColor = rgba(PALETTE.cyan, 0.55)
        g.shadowBlur = 9
        g.strokeStyle = rgba(PALETTE.cyan, 0.42)
        g.lineWidth = 2.8
      } else {
        g.shadowBlur = 0
        g.strokeStyle = rgba(PALETTE.cyan, 0.95)
        g.lineWidth = 1.3
      }
      for (side = -1; side <= 1; side += 2) {
        for (i = 0; i < 4; i += 1) {
          var spread = (i - 1.5) * 0.46
          var gait = Math.sin(time * gaitSpeed + i * 1.8 + (side > 0 ? 0 : Math.PI)) * swingAmp
          var ang = side * (Math.PI * 0.5 + spread + gait * 0.35)
          var hx = side * 2.2 * sc
          var hy = spread * 2.0 * sc
          var kx = hx + Math.cos(ang) * L1 * (1 + Math.abs(gait) * 0.12)
          var ky = hy + Math.sin(ang) * L1
          var fang = ang + side * (0.62 + gait * 0.45)
          var fx = kx + Math.cos(fang) * L2
          var fy = ky + Math.sin(fang) * L2
          g.beginPath()
          g.moveTo(hx, hy)
          g.lineTo(kx, ky)
          g.lineTo(fx, fy)
          g.stroke()
          if (pass === 1) {
            g.fillStyle = rgba(PALETTE.mint, 0.9)
            g.beginPath()
            g.arc(fx, fy, Math.max(0.7, 0.9 * sc), 0, TAU)
            g.fill()
          }
        }
      }
    }
    // abdomen, thorax, head: frosted glass body with a coloured wireframe.
    g.shadowBlur = 0
    g.fillStyle = 'rgba(255,255,255,0.94)'
    g.strokeStyle = rgba(PALETTE.cyan, 0.9)
    g.lineWidth = 1.1
    g.shadowColor = rgba(PALETTE.cyan, 0.45)
    g.shadowBlur = 9
    g.beginPath()
    g.ellipse(-5.5 * sc, 0, 5.8 * sc, 4.4 * sc, 0, 0, TAU)
    g.fill()
    g.stroke()
    g.beginPath()
    g.ellipse(2.4 * sc, 0, 3.6 * sc, 3.1 * sc, 0, 0, TAU)
    g.fill()
    g.stroke()
    g.shadowBlur = 0
    g.beginPath()
    g.arc(6.8 * sc, 0, 2.1 * sc, 0, TAU)
    g.fill()
    g.stroke()
    g.fillStyle = rgba(PALETTE.mint, 0.95)
    g.beginPath()
    g.arc(7.6 * sc, -1.1 * sc, Math.max(0.5, 0.7 * sc), 0, TAU)
    g.fill()
    g.beginPath()
    g.arc(7.6 * sc, 1.1 * sc, Math.max(0.5, 0.7 * sc), 0, TAU)
    g.fill()
    g.fillStyle = rgba(PALETTE.violet, 0.9)
    g.font = '600 ' + Math.round(5 * sc) + 'px ' + MONO
    g.fillText('W', -7 * sc, 1.8 * sc)
    g.restore()
  }

  /* ----------------------------------------------------------------- engine */

  /**
   * Create one fx engine bound to an overlay canvas.
   *
   * @param options.canvas - overlay canvas (covers the stage, click-through).
   * @param options.stage - element whose box is the overlay coordinate space.
   * @param options.viewport - `{width, height}` page viewport in CSS px.
   * @returns engine API, or null without a canvas.
   */
  function createFxEngine(options) {
    var o = options || {}
    var canvas = o.canvas
    if (canvas === null || canvas === undefined || typeof canvas.getContext !== 'function') return null
    var stage = o.stage || canvas
    var g = canvas.getContext('2d')
    if (g === null) return null

    var media =
      typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-reduced-motion: reduce)') : null
    var reduced = !!(media && media.matches)
    var view = {
      width: Math.max(1, Math.round(num(o.viewport && o.viewport.width, 1440))),
      height: Math.max(1, Math.round(num(o.viewport && o.viewport.height, 900)))
    }
    var layout = { cw: 0, ch: 0, dpr: 1, scale: 1, ox: 0, oy: 0, spiderScale: 1 }
    var items = []
    var spider = {
      x: 0,
      y: 0,
      angle: -Math.PI / 2,
      alpha: 0,
      moving: false,
      flight: null,
      trail: [],
      lastActivity: 0,
      seed: rand(0, 9)
    }
    var offset = 0
    var rafId = 0
    var destroyed = false
    var observer = null
    var lastLayoutRect = null

    function nowMs() {
      return (root.performance ? root.performance.now() : Date.now()) + offset
    }

    /* ------- coordinate mapping (INTERFACE.md §1) ------- */

    function syncLayout(force) {
      if (!stage || typeof stage.getBoundingClientRect !== 'function') return
      var rect = stage.getBoundingClientRect()
      var cw = Math.max(1, Math.round(rect.width))
      var ch = Math.max(1, Math.round(rect.height))
      var dpr = Math.min(3, Math.max(1, root.devicePixelRatio || 1))
      if (force !== true && cw === layout.cw && ch === layout.ch && dpr === layout.dpr) return
      layout.cw = cw
      layout.ch = ch
      layout.dpr = dpr
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      layout.scale = Math.min(cw / view.width, ch / view.height)
      layout.ox = (cw - view.width * layout.scale) / 2
      layout.oy = (ch - view.height * layout.scale) / 2
      layout.spiderScale = clamp(Math.min(cw, ch) / 340, 0.7, 1.35)
      canvas.style.width = cw + 'px'
      canvas.style.height = ch + 'px'
    }

    function toScreen(x, y) {
      return { x: x * layout.scale + layout.ox, y: y * layout.scale + layout.oy }
    }

    function frameBox() {
      return {
        x: layout.ox,
        y: layout.oy,
        w: view.width * layout.scale,
        h: view.height * layout.scale
      }
    }

    /* ------- effect bookkeeping ------- */

    function requestDraw() {
      if (destroyed || rafId !== 0) return
      rafId = root.requestAnimationFrame(loop)
    }

    function spawn(item, delay) {
      item.t0 = nowMs() + Math.max(0, num(delay, 0))
      items.push(item)
      requestDraw()
    }

    function clipBox(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object') return null
      var x = num(raw.x, NaN)
      var y = num(raw.y, NaN)
      if (!isFinite(x) || !isFinite(y)) return null
      var w = num(raw.w, 2)
      var h = num(raw.h, 2)
      x = clamp(x, 0, view.width)
      y = clamp(y, 0, view.height)
      return {
        x: x,
        y: y,
        w: Math.max(2, Math.min(w, view.width - x)),
        h: Math.max(2, Math.min(h, view.height - y)),
        kind: raw.kind === 'element' ? 'element' : 'text'
      }
    }

    /** 一个页面坐标点（夹到视口内）；形状不对时返回 null。 */
    function pointOf(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object') return null
      var x = num(raw.x, NaN)
      var y = num(raw.y, NaN)
      if (!isFinite(x) || !isFinite(y)) return null
      return { x: clamp(x, 0, view.width), y: clamp(y, 0, view.height) }
    }

    function pointBox(x, y, size) {
      var s = size || 46
      return {
        x: clamp(x - s / 2, 0, Math.max(0, view.width - s)),
        y: clamp(y - s / 2, 0, Math.max(0, view.height - s)),
        w: s,
        h: s,
        kind: 'element'
      }
    }

    function eventBox(evt) {
      var box = clipBox(evt.box)
      if (box !== null) return box
      var x = num(evt.x, NaN)
      var y = num(evt.y, NaN)
      if (!isFinite(x) || !isFinite(y)) return null
      return pointBox(x, y, 46)
    }

    function boxCenter(box) {
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    }

    /* ------- spider flight ------- */

    function entryPoint() {
      return { x: view.width * 0.93, y: view.height * 0.88 }
    }

    function bezier(p0, p1, p2, p3, t) {
      var u = 1 - t
      var uu = u * u
      var tt = t * t
      return {
        x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
        y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y
      }
    }

    /**
     * Fly the pilot to a page coordinate along a bowed bezier.
     *
     * @returns flight duration in ms (the delay callers use to line effects up
     *   with the landing), 0 when motion is reduced.
     */
    function flyTo(now, targetX, targetY) {
      var target = {
        x: clamp(num(targetX, view.width / 2), 0, view.width),
        y: clamp(num(targetY, view.height / 2), 0, view.height)
      }
      spider.alpha = 1
      spider.lastActivity = now
      if (reduced) {
        spider.x = target.x
        spider.y = target.y
        spider.moving = false
        spider.flight = null
        spider.alpha = 0
        return 0
      }
      var start
      if (spider.flight !== null) start = { x: spider.x, y: spider.y }
      else if (spider.alpha < 0.05) start = entryPoint()
      else start = { x: spider.x, y: spider.y }
      var dx = target.x - start.x
      var dy = target.y - start.y
      var distance = Math.hypot(dx, dy)
      var duration = clamp(190 + distance * 0.42, 240, 700)
      var nx = distance > 0.001 ? -dy / distance : 0
      var ny = distance > 0.001 ? dx / distance : 0
      var bow = Math.min(120, 30 + distance * 0.16) * (Math.random() < 0.5 ? -1 : 1)
      spider.flight = {
        p0: start,
        p1: { x: start.x + dx * 0.28 + nx * bow, y: start.y + dy * 0.28 + ny * bow },
        p2: { x: start.x + dx * 0.72 + nx * bow * 0.5, y: start.y + dy * 0.72 + ny * bow * 0.5 },
        p3: target,
        t0: now,
        dur: duration
      }
      spider.moving = true
      return duration
    }

    /* ------- effect spawners ------- */

    function spawnBracket(box, colorName, delay, options) {
      var opts = options || {}
      spawn(
        {
          type: 'bracket',
          box: box,
          color: PALETTE[colorName] || PALETTE.cyan,
          dur: num(opts.dur, 1500),
          tag: typeof opts.tag === 'string' ? opts.tag.slice(0, 12) : ''
        },
        delay
      )
    }

    function spawnRipple(x, y, colorName, delay, radius) {
      spawn(
        {
          type: 'ripple',
          x: x,
          y: y,
          color: PALETTE[colorName] || PALETTE.cyan,
          r0: 2,
          r1: num(radius, 30),
          dur: 640,
          fill: true
        },
        delay
      )
    }

    function spawnSparks(x, y, colorName, count, delay) {
      var total = num(count, 10)
      for (var i = 0; i < total; i += 1) {
        var angle = rand(0, TAU)
        var speed = rand(26, 62)
        spawn(
          {
            type: 'particle',
            x0: x,
            y0: y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            gravity: 60,
            size: rand(1.2, 2.6),
            color: PALETTE[i % 3 === 0 ? 'mint' : 'cyan'],
            dur: rand(420, 760)
          },
          delay + rand(0, 40)
        )
      }
    }

    function spawnFlashBox(box, colorName, delay) {
      spawn(
        { type: 'flash', box: box, color: PALETTE[colorName] || PALETTE.cyan, dur: 460 },
        delay
      )
    }

    function spawnScan(box, colorName, delay) {
      spawn(
        {
          type: 'scan',
          box: box,
          color: PALETTE[colorName] || PALETTE.cyan,
          dur: 620 + Math.min(560, box.w * 0.55)
        },
        delay
      )
    }

    function spawnReadParticles(box, delay) {
      var glyphs = '01·10⠁⠂⠄+/\\<>[]{}=│'
      var count = clamp(Math.round((box.w * box.h) / 9000), 4, 12)
      for (var i = 0; i < count; i += 1) {
        var useGlyph = Math.random() < 0.5
        spawn(
          {
            type: 'particle',
            x0: box.x + rand(0.06, 0.94) * box.w,
            y0: box.y + rand(0.2, 0.95) * box.h,
            vx: rand(-7, 7),
            vy: rand(-40, -14),
            gravity: -8,
            size: rand(1.2, 2.8),
            font: rand(9, 14),
            char: useGlyph ? glyphs.charAt(Math.floor(rand(0, glyphs.length))) : null,
            color: PALETTE[i % 4 === 0 ? 'violet' : i % 2 === 0 ? 'mint' : 'cyan'],
            dur: rand(800, 1500)
          },
          delay + rand(0, 260)
        )
      }
    }

    function spawnTypeChars(box, text, delay) {
      var chars = Array.from(String(text === null || text === undefined ? '' : text))
      var count = Math.min(18, chars.length)
      var cx = box.x + box.w / 2
      var cy = box.y + box.h / 2
      for (var i = 0; i < count; i += 1) {
        spawn(
          {
            type: 'particle',
            x0: cx + rand(-box.w * 0.34, box.w * 0.34),
            y0: cy + rand(-2, 8),
            vx: rand(-10, 10),
            vy: rand(-56, -22),
            gravity: 4,
            size: rand(1.4, 2.4),
            font: rand(10, 15),
            char: chars[i] === ' ' ? null : chars[i],
            color: PALETTE[i % 2 === 0 ? 'mint' : 'cyan'],
            dur: rand(680, 1150)
          },
          delay + i * 30
        )
      }
      // caret at the end of the target box
      spawn({ type: 'caret', box: box, color: PALETTE.mint, dur: 980 }, delay)
    }

    function spawnScroll(dir) {
      var lanes = []
      for (var i = 0; i < 7; i += 1) {
        lanes.push({
          across: rand(0.08, 0.92),
          phase: rand(0, 0.85),
          len: rand(0.18, 0.42),
          alpha: rand(0.42, 0.92),
          width: rand(1.6, 3.2)
        })
      }
      spawn({ type: 'streaks', dir: dir, lanes: lanes, dur: 980 }, 0)
    }

    function spawnGlitch(phase) {
      var strong = phase !== 'done'
      var bands = []
      for (var i = 0; i < 6; i += 1) {
        bands.push({
          y: rand(0.04, 0.94),
          h: rand(2, 15),
          dx: rand(-28, 28),
          alpha: rand(0.14, 0.42),
          color: PALETTE[i % 3 === 0 ? 'red' : i % 3 === 1 ? 'cyan' : 'violet']
        })
      }
      spawn({ type: 'glitch', bands: bands, strong: strong, dur: strong ? 560 : 380 }, 0)
    }

    function spawnBadge(key, slot) {
      spawn(
        {
          type: 'badge',
          key: String(key === null || key === undefined ? '?' : key).slice(0, 10).toUpperCase(),
          slot: num(slot, 0),
          dur: 1150
        },
        0
      )
    }

    /**
     * 拖拽轨迹：一条整段虚线底轨 + 一条随拖拽生长的实线 + 会呼吸的头部亮点。
     *
     * `dur` 是轨迹长到终点的时间，和宿主真实拖拽的 durationMs 对齐；整个特效
     * 多活 320ms 用于淡出。
     */
    function spawnDragTrail(from, to, delay, options) {
      var opts = options || {}
      var growMs = clamp(num(opts.dur, 420), 120, 4000)
      spawn(
        {
          type: 'drag',
          from: from,
          to: to,
          color: PALETTE[opts.color] || PALETTE.violet,
          head: PALETTE[opts.head] || PALETTE.cyan,
          grow: growMs,
          dur: growMs + 320
        },
        delay
      )
    }

    /* ------- push: host fx -> effects ------- */

    function push(event) {
      if (event === null || event === undefined || typeof event !== 'object') return false
      var kind = event.kind
      if (typeof kind !== 'string') return false
      var now = nowMs()
      var flight = 0
      var i
      if (kind === 'click') {
        var clickPoint = {
          x: num(event.x, NaN),
          y: num(event.y, NaN)
        }
        var clickBox = eventBox(event)
        if (!isFinite(clickPoint.x) || !isFinite(clickPoint.y)) {
          if (clickBox === null) return false
          var cc = boxCenter(clickBox)
          clickPoint = { x: cc.x, y: cc.y }
        }
        var box = clickBox || pointBox(clickPoint.x, clickPoint.y, 46)
        flight = flyTo(now, clickPoint.x, clickPoint.y)
        spawnBracket(box, 'cyan', flight, {
          tag: typeof event.label === 'string' ? event.label : 'CLICK'
        })
        spawnRipple(clickPoint.x, clickPoint.y, 'mint', flight, 34)
        spawnRipple(clickPoint.x, clickPoint.y, 'cyan', flight + 90, 58)
        spawnRipple(clickPoint.x, clickPoint.y, 'violet', flight + 180, 78)
        spawnSparks(clickPoint.x, clickPoint.y, 'cyan', 10, flight)
        spawnFlashBox(box, 'cyan', flight)
        return true
      }
      if (kind === 'drag') {
        var dragFrom = pointOf(event.from)
        var dragTo = pointOf(event.to)
        if (dragFrom === null || dragTo === null) return false
        var dragMs = clamp(num(event.durationMs, 420), 120, 4000)
        // 光标先落到起点，轨迹按真实拖拽时长长到终点，落点补一个 DROP 括号。
        var approach = flyTo(now, dragFrom.x, dragFrom.y)
        spawnDragTrail(dragFrom, dragTo, approach, { dur: dragMs })
        spawnBracket(pointBox(dragTo.x, dragTo.y, 44), 'mint', approach + dragMs, { tag: 'DROP', dur: 900 })
        spawnRipple(dragTo.x, dragTo.y, 'mint', approach + dragMs, 26)
        return true
      }
      if (kind === 'read') {
        var boxes = Array.isArray(event.boxes) ? event.boxes : []
        var clipped = []
        for (i = 0; i < boxes.length && clipped.length < 10; i += 1) {
          var readBox = clipBox(boxes[i])
          if (readBox !== null) clipped.push(readBox)
        }
        if (clipped.length === 0) {
          var fallback = eventBox(event)
          if (fallback === null) return false
          clipped.push(fallback)
        }
        var first = boxCenter(clipped[0])
        flight = flyTo(now, first.x, first.y)
        for (i = 0; i < clipped.length; i += 1) {
          var targetBox = clipped[i]
          var isElement = targetBox.kind === 'element'
          var delay = flight + i * 80
          spawnBracket(targetBox, isElement ? 'violet' : 'cyan', delay, {
            tag: (isElement ? 'EL:' : 'TX:') + String(i + 1).padStart(2, '0'),
            dur: 1650
          })
          spawnScan(targetBox, isElement ? 'violet' : 'cyan', delay + 90)
          spawnReadParticles(targetBox, delay + 140)
        }
        return true
      }
      if (kind === 'type') {
        var typeBox = eventBox(event)
        if (typeBox === null) return false
        var tc = boxCenter(typeBox)
        flight = flyTo(now, tc.x, tc.y)
        spawnBracket(typeBox, 'mint', flight, { tag: 'TYPE', dur: 1400 })
        spawnFlashBox(typeBox, 'mint', flight)
        spawnTypeChars(typeBox, event.text, flight)
        return true
      }
      if (kind === 'scroll') {
        var direction = event.direction
        if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
          direction = num(event.dy, 0) < 0 ? 'up' : 'down'
        }
        spawnScroll(direction)
        return true
      }
      if (kind === 'nav') {
        spawnGlitch(event.phase === 'done' ? 'done' : 'start')
        return true
      }
      if (kind === 'key') {
        spawnBadge(event.key, 0)
        return true
      }
      if (kind === 'idle') {
        spider.lastActivity = Math.min(spider.lastActivity, now - 1200)
        requestDraw()
        return true
      }
      // Unknown kinds are ignored on purpose (INTERFACE.md §2).
      return false
    }

    /* ------- draw: one effect ------- */

    /** Trace the four corner brackets of one rect, leaving a reusable path. */
    function bracketPath(g, x, y, w, h, length) {
      g.beginPath()
      g.moveTo(x, y + length)
      g.lineTo(x, y)
      g.lineTo(x + length, y)
      g.moveTo(x + w - length, y)
      g.lineTo(x + w, y)
      g.lineTo(x + w, y + length)
      g.moveTo(x + w, y + h - length)
      g.lineTo(x + w, y + h)
      g.lineTo(x + w - length, y + h)
      g.moveTo(x + length, y + h)
      g.lineTo(x, y + h)
      g.lineTo(x, y + h - length)
    }

    function drawBracket(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var fade = p < 0.1 ? p / 0.1 : p > 0.8 ? Math.max(0, (1 - p) / 0.2) : 1
      if (fade <= 0) return
      var box = it.box
      var topLeft = toScreen(box.x, box.y)
      var w = Math.max(8, box.w * layout.scale)
      var h = Math.max(8, box.h * layout.scale)
      var grow = (1 - easeOutCubic(Math.min(1, p / 0.22))) * 12
      var x = topLeft.x - grow
      var y = topLeft.y - grow
      var ww = w + grow * 2
      var hh = h + grow * 2
      var length = clamp(Math.min(ww, hh) * 0.34, 10, 26)
      var color = it.color
      g.save()
      // A faint tint plus a dark halo keep the brackets legible both over a
      // dark console and over a plain white article.
      if (ww > 26 && hh > 20) {
        g.fillStyle = rgba(color, 0.06 * fade)
        g.fillRect(x, y, ww, hh)
      }
      bracketPath(g, x, y, ww, hh, length)
      g.lineWidth = 2.6
      g.strokeStyle = 'rgba(255,255,255,' + 0.62 * fade + ')'
      g.stroke()
      g.lineWidth = 1.7
      g.strokeStyle = rgba(color, 0.95 * fade)
      g.shadowColor = rgba(color, 0.75 * fade)
      g.shadowBlur = 10
      g.stroke()
      if (it.tag !== '') {
        g.shadowBlur = 0
        g.font = '600 9px ' + MONO
        g.strokeStyle = 'rgba(255,255,255,0.7)'
        g.lineWidth = 2.6
        g.strokeText(it.tag, x + 1, y - 5)
        g.fillStyle = rgba(color, 0.98 * fade)
        g.fillText(it.tag, x + 1, y - 5)
      }
      g.restore()
    }

    function drawScan(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var box = it.box
      var topLeft = toScreen(box.x, box.y)
      var w = Math.max(6, box.w * layout.scale)
      var h = Math.max(6, box.h * layout.scale)
      var sweep = easeInOutCubic(p)
      var x = topLeft.x + w * sweep
      var fade = p < 0.06 ? p / 0.06 : p > 0.9 ? (1 - p) / 0.1 : 1
      if (fade <= 0) return
      var color = it.color
      g.save()
      g.beginPath()
      g.rect(topLeft.x, topLeft.y, w, h)
      g.clip()
      var band = Math.min(52, Math.max(20, w * 0.18))
      var gradient = g.createLinearGradient(x - band, 0, x, 0)
      gradient.addColorStop(0, rgba(color, 0))
      gradient.addColorStop(0.72, rgba(color, 0.16 * fade))
      gradient.addColorStop(1, rgba(color, 0.4 * fade))
      g.fillStyle = gradient
      g.fillRect(x - band, topLeft.y, band, h)
      // pale halo underneath the coloured core: the beam reads on dark pages too
      g.fillStyle = 'rgba(255,255,255,' + 0.55 * fade + ')'
      g.fillRect(x - 1.9, topLeft.y, 3.8, h)
      g.shadowColor = rgba(color, 0.9)
      g.shadowBlur = 14
      g.fillStyle = rgba(color, 0.92 * fade)
      g.fillRect(x - 1.1, topLeft.y, 2.2, h)
      g.fillStyle = rgba([255, 255, 255], 0.85 * fade)
      g.fillRect(x - 2, topLeft.y + h * 0.5 - 1.2, 4, 2.4)
      g.restore()
    }

    function drawRipple(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var radius = lerp(it.r0, it.r1, easeOutCubic(p))
      var alpha = (1 - p) * (1 - p) * 0.95
      var center = toScreen(it.x, it.y)
      g.save()
      g.beginPath()
      g.arc(center.x, center.y, radius, 0, TAU)
      g.lineWidth = 3.4
      g.strokeStyle = 'rgba(255,255,255,' + 0.6 * alpha + ')'
      g.stroke()
      g.lineWidth = 1.7
      g.strokeStyle = rgba(it.color, alpha)
      g.shadowColor = rgba(it.color, alpha)
      g.shadowBlur = 12
      g.stroke()
      if (it.fill) {
        g.shadowBlur = 0
        g.fillStyle = rgba(it.color, alpha * 0.1)
        g.fill()
      }
      g.restore()
    }

    function drawParticle(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var seconds = (p * it.dur) / 1000
      var x = it.x0 + it.vx * seconds
      var y = it.y0 + it.vy * seconds + 0.5 * num(it.gravity, 0) * seconds * seconds
      var screen = toScreen(x, y)
      var alpha = Math.sin(Math.min(1, p * 4) * (Math.PI / 2)) * (1 - p)
      g.save()
      g.globalAlpha = clamp(alpha, 0, 1)
      if (it.char !== null && it.char !== undefined) {
        g.font = '600 ' + Math.round(num(it.font, 10)) + 'px ' + MONO
        g.lineWidth = 2.6
        g.strokeStyle = 'rgba(255,255,255,0.75)'
        g.strokeText(it.char, screen.x, screen.y)
        g.fillStyle = rgba(it.color, 0.98)
        g.shadowColor = rgba(it.color, 0.7)
        g.shadowBlur = 7
        g.fillText(it.char, screen.x, screen.y)
      } else {
        g.fillStyle = rgba(it.color, 0.95)
        g.shadowColor = rgba(it.color, 0.8)
        g.shadowBlur = 7
        var size = Math.max(1.5, it.size)
        g.fillRect(screen.x, screen.y, size, size)
      }
      g.restore()
    }

    function drawFlash(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var alpha = Math.sin(p * Math.PI)
      var screen = toScreen(it.box.x, it.box.y)
      var w = Math.max(8, it.box.w * layout.scale)
      var h = Math.max(8, it.box.h * layout.scale)
      g.save()
      g.fillStyle = 'rgba(255,255,255,' + 0.55 * alpha + ')'
      g.fillRect(screen.x, screen.y, w, h)
      g.fillStyle = rgba(it.color, 0.26 * alpha)
      g.fillRect(screen.x, screen.y, w, h)
      g.strokeStyle = rgba(it.color, 0.9 * alpha)
      g.lineWidth = 2
      g.shadowColor = rgba(it.color, 0.7)
      g.shadowBlur = 10
      g.strokeRect(screen.x, screen.y, w, h)
      g.restore()
    }

    function drawCaret(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var blink = Math.floor(now / 170) % 2 === 0 ? 1 : 0.15
      var screen = toScreen(it.box.x + it.box.w, it.box.y)
      var h = Math.max(10, Math.min(26, it.box.h * layout.scale * 0.8))
      g.save()
      g.globalAlpha = blink * (1 - p * 0.6)
      g.fillStyle = rgba(it.color, 0.9)
      g.shadowColor = rgba(it.color, 0.8)
      g.shadowBlur = 8
      g.fillRect(screen.x - 1, screen.y + 2, 2, h - 4)
      g.restore()
    }

    function drawBadge(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var inP = Math.min(1, p / 0.14)
      var alpha = inP * (p > 0.82 ? (1 - p) / 0.18 : 1)
      if (alpha <= 0) return
      var pop = p < 0.14 ? easeOutBack(inP) : 1
      var frame = frameBox()
      g.save()
      g.font = '600 10px ' + MONO
      var textWidth = g.measureText(it.key).width
      var w = Math.max(56, textWidth + 26)
      var h = 27
      var x = frame.x + frame.w - w - 14
      var y = frame.y + frame.h - 44 - num(it.slot, 0) * 31 - h
      g.translate(x + w / 2, y + h / 2)
      g.scale(pop, pop)
      g.translate(-w / 2, -h / 2)
      g.fillStyle = 'rgba(255,255,255,' + 0.95 * alpha + ')'
      roundRect(g, 0, 0, w, h, 4)
      g.fill()
      g.strokeStyle = rgba(PALETTE.mint, 0.78 * alpha)
      g.lineWidth = 1
      g.shadowColor = rgba(PALETTE.mint, 0.6 * alpha)
      g.shadowBlur = 10
      g.stroke()
      g.shadowBlur = 0
      g.fillStyle = rgba(PALETTE.mint, 0.95 * alpha)
      g.fillText(it.key, 12, h / 2 + 3.5)
      g.font = '600 7px ' + MONO
      g.fillStyle = rgba(PALETTE.dim, 0.9 * alpha)
      g.fillText('KEY', 12, -5)
      g.restore()
    }

    function drawStreaks(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var fade = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1
      var frame = frameBox()
      var vertical = it.dir === 'up' || it.dir === 'down'
      var forward = it.dir === 'down' || it.dir === 'right' ? 1 : -1
      g.save()
      g.beginPath()
      g.rect(frame.x, frame.y, frame.w, frame.h)
      g.clip()
      for (var i = 0; i < it.lanes.length; i += 1) {
        var lane = it.lanes[i]
        var travel = (p * 1.15 + lane.phase) % 1
        var pos = forward > 0 ? travel : 1 - travel
        var alpha = Math.sin(Math.PI * travel) * lane.alpha * fade
        if (vertical) {
          var x = frame.x + lane.across * frame.w
          var y0 = frame.y + (pos - lane.len / 2) * frame.h
          var len = lane.len * frame.h
          var gradient = g.createLinearGradient(0, y0, 0, y0 + len)
          gradient.addColorStop(0, rgba(PALETTE.cyan, 0))
          gradient.addColorStop(0.5, rgba(PALETTE.cyan, alpha))
          gradient.addColorStop(1, rgba(PALETTE.cyan, 0))
          g.strokeStyle = 'rgba(255,255,255,' + 0.6 * alpha + ')'
          g.lineWidth = lane.width + 2.6
          g.beginPath()
          g.moveTo(x, y0)
          g.lineTo(x, y0 + len)
          g.stroke()
          g.strokeStyle = gradient
          g.lineWidth = lane.width
          g.beginPath()
          g.moveTo(x, y0)
          g.lineTo(x, y0 + len)
          g.stroke()
        } else {
          var y = frame.y + lane.across * frame.h
          var x0 = frame.x + (pos - lane.len / 2) * frame.w
          var lenX = lane.len * frame.w
          var gradientX = g.createLinearGradient(x0, 0, x0 + lenX, 0)
          gradientX.addColorStop(0, rgba(PALETTE.cyan, 0))
          gradientX.addColorStop(0.5, rgba(PALETTE.cyan, alpha))
          gradientX.addColorStop(1, rgba(PALETTE.cyan, 0))
          g.strokeStyle = 'rgba(255,255,255,' + 0.6 * alpha + ')'
          g.lineWidth = lane.width + 2.6
          g.beginPath()
          g.moveTo(x0, y)
          g.lineTo(x0 + lenX, y)
          g.stroke()
          g.strokeStyle = gradientX
          g.lineWidth = lane.width
          g.beginPath()
          g.moveTo(x0, y)
          g.lineTo(x0 + lenX, y)
          g.stroke()
        }
      }
      // three chevrons drift toward the scroll direction at the frame centre
      var cx = frame.x + frame.w / 2
      var cy = frame.y + frame.h / 2
      g.strokeStyle = rgba(PALETTE.mint, 0.55 * fade)
      g.lineWidth = 1.6
      for (var k = 0; k < 3; k += 1) {
        var off = ((p * 1.6 + k * 0.24) % 1) - 0.5
        var ax = cx
        var ay = cy
        var size = 9
        if (vertical) ay = cy + off * frame.h * 0.3 * forward
        else ax = cx + off * frame.w * 0.3 * forward
        g.beginPath()
        if (it.dir === 'down') {
          g.moveTo(ax - size, ay - size / 2)
          g.lineTo(ax, ay + size / 2)
          g.lineTo(ax + size, ay - size / 2)
        } else if (it.dir === 'up') {
          g.moveTo(ax - size, ay + size / 2)
          g.lineTo(ax, ay - size / 2)
          g.lineTo(ax + size, ay + size / 2)
        } else if (it.dir === 'right') {
          g.moveTo(ax - size / 2, ay - size)
          g.lineTo(ax + size / 2, ay)
          g.lineTo(ax - size / 2, ay + size)
        } else {
          g.moveTo(ax + size / 2, ay - size)
          g.lineTo(ax - size / 2, ay)
          g.lineTo(ax + size / 2, ay + size)
        }
        g.lineWidth = 3.6
        g.strokeStyle = 'rgba(255,255,255,0.65)'
        g.stroke()
        g.lineWidth = 1.8
        g.strokeStyle = rgba(PALETTE.mint, 0.85 * fade)
        g.shadowColor = rgba(PALETTE.mint, 0.5)
        g.shadowBlur = 8
        g.stroke()
        g.shadowBlur = 0
      }
      g.restore()
    }

    /**
     * 画一次拖拽：底轨是整条路径的虚线，实线跟着头部生长，落点有 DROP 括号。
     * 拖拽进行中顺便把蜘蛛压到头部，人看到的「手」就是正在拖的那个点。
     */
    function drawDragTrail(g, it, now) {
      var age = now - it.t0
      if (age < 0) return
      var grow = it.grow > 0 ? clamp(age / it.grow, 0, 1) : 1
      // 淡入淡出按绝对毫秒算：早期按寿命比例淡入会让长拖拽（durationMs 很大）
      // 前几秒几乎看不见——这正是第一版在深色背景上"好像没画"的原因。
      var fade = Math.min(clamp(age / 140, 0, 1), it.dur > 0 ? clamp((it.dur - age) / 300, 0, 1) : 1)
      if (fade <= 0) return
      var a = toScreen(it.from.x, it.from.y)
      var b = toScreen(it.to.x, it.to.y)
      var hx = a.x + (b.x - a.x) * grow
      var hy = a.y + (b.y - a.y) * grow
      g.save()
      // 三层画法：先用白色描边打底（面板底色有白也有深蓝，纯紫 1px 线在深色上
      // 看不见），再铺一层柔和光晕，最后才是本体。
      g.setLineDash([3, 5])
      g.globalAlpha = fade * 0.5
      g.strokeStyle = 'rgba(255,255,255,0.30)'
      g.lineWidth = 3
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
      g.globalAlpha = fade * 0.55
      g.strokeStyle = rgba(it.color, 0.7)
      g.lineWidth = 1.4
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
      // 已走过的实线
      g.setLineDash([])
      g.globalAlpha = fade * 0.22
      g.strokeStyle = rgba(it.head, 1)
      g.lineWidth = 9
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(hx, hy)
      g.stroke()
      g.globalAlpha = fade
      g.strokeStyle = 'rgba(255,255,255,0.35)'
      g.lineWidth = 3.5
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(hx, hy)
      g.stroke()
      g.strokeStyle = rgba(it.color, 1)
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(hx, hy)
      g.stroke()
      // 头部亮点 + 呼吸圈
      g.globalAlpha = fade
      g.fillStyle = rgba(it.head, 0.95)
      g.beginPath()
      g.arc(hx, hy, 2.8, 0, TAU)
      g.fill()
      g.globalAlpha = fade * (0.4 + 0.22 * Math.sin(now / 130))
      g.strokeStyle = rgba(it.head, 0.9)
      g.lineWidth = 1
      g.beginPath()
      g.arc(hx, hy, 6.4, 0, TAU)
      g.stroke()
      g.restore()
      if (grow < 1 && spider.flight === null) {
        spider.x = it.from.x + (it.to.x - it.from.x) * grow
        spider.y = it.from.y + (it.to.y - it.from.y) * grow
        spider.alpha = 1
        spider.lastActivity = now
      }
    }

    function drawGlitch(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var amp = Math.sin(Math.PI * Math.min(1, p * 1.15)) * (it.strong ? 1 : 0.55)
      var frame = frameBox()
      g.save()
      g.beginPath()
      g.rect(frame.x, frame.y, frame.w, frame.h)
      g.clip()
      g.fillStyle = rgba([150, 210, 255], 0.05 * amp)
      g.fillRect(frame.x, frame.y, frame.w, frame.h)
      for (var i = 0; i < it.bands.length; i += 1) {
        var band = it.bands[i]
        var flicker = 0.45 + 0.55 * Math.abs(Math.sin(now * 0.03 + i * 2.3))
        g.fillStyle = rgba(band.color, band.alpha * amp * flicker)
        g.fillRect(frame.x + band.dx * amp, frame.y + band.y * frame.h, frame.w, Math.max(1, band.h))
        if (i % 2 === 0) {
          g.fillStyle = rgba([220, 245, 255], 0.32 * amp * flicker)
          g.fillRect(frame.x + band.dx * amp, frame.y + band.y * frame.h, frame.w, 1)
        }
      }
      for (var j = 0; j < 3; j += 1) {
        var yy = frame.y + ((j + 0.35) / 3) * frame.h + Math.sin(now * 0.02 + j) * 6
        g.fillStyle = rgba(PALETTE.cyan, 0.2 * amp)
        g.fillRect(frame.x, yy, frame.w, 1)
      }
      g.globalCompositeOperation = 'lighter'
      g.fillStyle = rgba(PALETTE.red, 0.05 * amp)
      g.fillRect(frame.x + Math.sin(now * 0.08) * 5, frame.y, frame.w, frame.h * 0.5)
      g.globalCompositeOperation = 'source-over'
      g.restore()
    }

    function drawReducedItem(g, it, now) {
      var p = (now - it.t0) / it.dur
      if (p < 0 || p > 1) return
      var fade = p < 0.2 ? p / 0.2 : p > 0.8 ? (1 - p) / 0.2 : 1
      var frame = frameBox()
      if (it.type === 'bracket') {
        var topLeft = toScreen(it.box.x, it.box.y)
        g.save()
        g.globalAlpha = fade * 0.85
        g.strokeStyle = rgba(it.color, 0.85)
        g.lineWidth = 1
        g.strokeRect(
          topLeft.x - 0.5,
          topLeft.y - 0.5,
          Math.max(2, it.box.w * layout.scale) + 1,
          Math.max(2, it.box.h * layout.scale) + 1
        )
        if (it.tag !== '') {
          g.font = '600 8px ' + MONO
          g.fillStyle = rgba(it.color, 0.9)
          g.fillText(it.tag, topLeft.x + 1, topLeft.y - 4)
        }
        g.restore()
        return
      }
      if (it.type === 'drag') {
        // 降级成一张静止的路线图：不生长、不呼吸，只淡入淡出。
        var dragA = toScreen(it.from.x, it.from.y)
        var dragB = toScreen(it.to.x, it.to.y)
        g.save()
        g.globalAlpha = fade * 0.7
        g.strokeStyle = rgba(it.color, 0.85)
        g.lineWidth = 1
        g.setLineDash([3, 5])
        g.beginPath()
        g.moveTo(dragA.x, dragA.y)
        g.lineTo(dragB.x, dragB.y)
        g.stroke()
        g.setLineDash([])
        g.fillStyle = rgba(it.head, 0.9)
        g.beginPath()
        g.arc(dragB.x, dragB.y, 2.2, 0, TAU)
        g.fill()
        g.restore()
        return
      }
      if (it.type === 'flash' || it.type === 'glitch' || it.type === 'streaks') {
        g.save()
        g.globalAlpha = fade * (it.strong === false ? 0.05 : 0.08)
        g.fillStyle = rgba(PALETTE.cyan, 1)
        g.fillRect(frame.x, frame.y, frame.w, frame.h)
        g.restore()
      }
    }

    /* ------- draw: frame ------- */

    function drawSpider(g, now) {
      if (spider.alpha <= 0.01) return
      var body = toScreen(spider.x, spider.y)
      drawSpiderShape(
        g,
        layout.spiderScale,
        spider.angle,
        spider.alpha,
        spider.moving,
        spider.seed + now / 1000
      )
      // move the drawing into place: drawSpiderShape expects the origin already
      // translated, so re-draw properly anchored (kept separate for clarity).
      void body
    }

    function drawSpiderAt(g, x, y) {
      // drawSpiderShape works in local space; translate to the cursor.
      g.save()
      g.translate(x, y)
      drawSpiderShape(g, layout.spiderScale, spider.angle, spider.alpha, spider.moving, spider.seed + nowMs() / 1000)
      g.restore()
    }

    function drawTrail(g, now) {
      for (var i = 0; i < spider.trail.length; i += 1) {
        var point = spider.trail[i]
        var age = (now - point.t) / 640
        if (age < 0 || age > 1) continue
        var screen = toScreen(point.x, point.y)
        var alpha = (1 - age) * 0.45 * (i / spider.trail.length)
        g.fillStyle = rgba(PALETTE.cyan, alpha)
        g.beginPath()
        g.arc(screen.x, screen.y, 2.1 * (1 - age) + 0.6, 0, TAU)
        g.fill()
      }
    }

    function render(now) {
      syncLayout(false)
      g.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0)
      g.clearRect(0, 0, layout.cw, layout.ch)
      if (layout.cw <= 0 || layout.ch <= 0) return
      var i
      for (i = 0; i < items.length; i += 1) {
        var it = items[i]
        if (now < it.t0) continue
        if (reduced) {
          drawReducedItem(g, it, now)
          continue
        }
        switch (it.type) {
          case 'bracket':
            drawBracket(g, it, now)
            break
          case 'scan':
            drawScan(g, it, now)
            break
          case 'ripple':
            drawRipple(g, it, now)
            break
          case 'particle':
            drawParticle(g, it, now)
            break
          case 'flash':
            drawFlash(g, it, now)
            break
          case 'caret':
            drawCaret(g, it, now)
            break
          case 'badge':
            drawBadge(g, it, now)
            break
          case 'streaks':
            drawStreaks(g, it, now)
            break
          case 'glitch':
            drawGlitch(g, it, now)
            break
          case 'drag':
            drawDragTrail(g, it, now)
            break
          default:
            break
        }
      }
      if (!reduced) drawTrail(g, now)
      if (!reduced && spider.alpha > 0.01) {
        var body = toScreen(spider.x, spider.y)
        g.save()
        g.translate(body.x, body.y)
        drawSpiderShape(
          g,
          layout.spiderScale,
          spider.angle,
          spider.alpha,
          spider.moving,
          spider.seed + now / 1000
        )
        g.restore()
      }
    }

    /* ------- clock / loop ------- */

    function update(now) {
      var flight = spider.flight
      if (flight !== null) {
        var t = clamp((now - flight.t0) / flight.dur, 0, 1)
        var eased = easeInOutCubic(t)
        var previousX = spider.x
        var previousY = spider.y
        spider.x = bezier(flight.p0, flight.p1, flight.p2, flight.p3, eased).x
        spider.y = bezier(flight.p0, flight.p1, flight.p2, flight.p3, eased).y
        var dx = spider.x - previousX
        var dy = spider.y - previousY
        if (Math.hypot(dx, dy) > 0.4) spider.angle = Math.atan2(dy, dx)
        if (t >= 1) {
          spider.flight = null
          spider.moving = false
        }
      }
      if (spider.alpha > 0 && (spider.moving || now - spider.lastActivity < 700)) {
        var trailSize = spider.trail.length
        if (trailSize === 0 || now - spider.trail[trailSize - 1].t >= 34) {
          spider.trail.push({ x: spider.x, y: spider.y, t: now })
          if (spider.trail.length > 16) spider.trail.shift()
        }
      }
      var idle = now - spider.lastActivity
      if (!spider.moving && idle > 2200) {
        spider.alpha = clamp(1 - (idle - 2200) / 800, 0, 1)
      }
      for (var i = items.length - 1; i >= 0; i -= 1) {
        var it = items[i]
        if (now > it.t0 + it.dur + 220) items.splice(i, 1)
      }
    }

    function needsFrame(now) {
      if (spider.flight !== null || spider.moving) return true
      if (spider.alpha > 0.01) return true
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].t0 + items[i].dur + 220 > now) return true
      }
      return false
    }

    function loop() {
      rafId = 0
      if (destroyed) return
      var now = nowMs()
      update(now)
      render(now)
      if (needsFrame(now)) requestDraw()
    }

    /* ------- public API ------- */

    function setViewport(width, height) {
      var w = Math.max(1, Math.round(num(width, view.width)))
      var h = Math.max(1, Math.round(num(height, view.height)))
      if (w === view.width && h === view.height) return
      view.width = w
      view.height = h
      syncLayout(true)
      requestDraw()
    }

    function onWindowResize() {
      syncLayout(true)
      requestDraw()
    }

    function onMotionChange() {
      reduced = media ? media.matches === true : false
      requestDraw()
    }

    function clear() {
      items.length = 0
      spider.flight = null
      spider.moving = false
      spider.alpha = 0
      spider.trail.length = 0
      requestDraw()
    }

    function skip(ms) {
      offset += Math.max(0, num(ms, 0))
      requestDraw()
    }

    function renderNow() {
      syncLayout(true)
      var now = nowMs()
      update(now)
      render(now)
    }

    function destroy() {
      if (destroyed) return
      destroyed = true
      if (rafId !== 0) root.cancelAnimationFrame(rafId)
      rafId = 0
      if (observer !== null) {
        try {
          observer.disconnect()
        } catch (error) {
          void error
        }
        observer = null
      }
      if (typeof root.removeEventListener === 'function') root.removeEventListener('resize', onWindowResize)
      if (media !== null) {
        if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onMotionChange)
        else if (typeof media.removeListener === 'function') media.removeListener(onMotionChange)
      }
      items.length = 0
    }

    function stats() {
      return {
        reduced: reduced,
        viewport: { width: view.width, height: view.height },
        layout: { cw: layout.cw, ch: layout.ch, dpr: layout.dpr, scale: layout.scale, ox: layout.ox, oy: layout.oy },
        items: items.length,
        spider: { x: spider.x, y: spider.y, alpha: spider.alpha, moving: spider.moving },
        slots: canvas.width + 'x' + canvas.height
      }
    }

    // Observe the stage: the panel width changes with the Sidebar, and the
    // picture aspect changes when the page viewport is re-emulated.
    if (typeof root.ResizeObserver === 'function') {
      try {
        observer = new root.ResizeObserver(function () {
          syncLayout(false)
          requestDraw()
        })
        observer.observe(stage)
      } catch (error) {
        observer = null
        void error
      }
    }
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('resize', onWindowResize)
    }
    if (media !== null) {
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onMotionChange)
      else if (typeof media.addListener === 'function') media.addListener(onMotionChange)
    }
    syncLayout(true)
    renderNow()
    requestDraw()

    return {
      push: push,
      setViewport: setViewport,
      resize: function () {
        syncLayout(true)
        requestDraw()
      },
      clear: clear,
      skip: skip,
      renderNow: renderNow,
      destroy: destroy,
      stats: stats,
      toScreen: toScreen,
      get reduced() {
        return reduced
      }
    }
  }

  /* ==========================================================================
   * Panel stylesheet — cyber-spider control room.
   * Scoped to `[data-dsh-webpilot]`; nothing leaks into the GUI or the page.
   * ======================================================================== */

  var CSS = `
[data-dsh-webpilot]{
  --wp-bg:#f3f6fa;--wp-bg2:#ffffff;--wp-panel:#ffffff;--wp-panel2:#f7f9fc;
  --wp-line:rgba(20,50,80,.12);--wp-line-soft:rgba(20,50,80,.06);
  --wp-cyan:#0a7c93;--wp-mint:#0d8a5f;--wp-violet:#6a4fd0;--wp-amber:#a2680f;--wp-red:#cf3450;
  --wp-text:#1b2b3b;--wp-dim:#5c7186;--wp-faint:#94a7b8;
  --wp-mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Consolas,"Liberation Mono",monospace;
  position:relative;display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;overflow:hidden;
  background:
    radial-gradient(620px 340px at 18% -10%,rgba(10,124,147,.10) 0%,transparent 62%),
    radial-gradient(520px 300px at 110% 108%,rgba(106,79,208,.08) 0%,transparent 58%),
    linear-gradient(180deg,var(--wp-bg2),var(--wp-bg) 58%);
  color:var(--wp-text);font-family:var(--wp-mono);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;isolation:isolate;
}
[data-dsh-webpilot] *,[data-dsh-webpilot] *::before,[data-dsh-webpilot] *::after{box-sizing:border-box}
[data-dsh-webpilot]::before{
  content:"";position:absolute;inset:0;z-index:0;pointer-events:none;
  background-image:
    linear-gradient(rgba(10,124,147,.055) 1px,transparent 1px),
    linear-gradient(90deg,rgba(10,124,147,.055) 1px,transparent 1px);
  background-size:26px 26px;opacity:.5;
  -webkit-mask-image:radial-gradient(ellipse 90% 70% at 50% 40%,#000 20%,transparent 100%);
  mask-image:radial-gradient(ellipse 90% 70% at 50% 40%,#000 20%,transparent 100%);
}
[data-dsh-webpilot]::after{
  content:"";position:absolute;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(ellipse 78% 62% at 50% 46%,transparent 52%,rgba(20,50,80,.05) 100%);
}
[data-dsh-webpilot] > *{position:relative;z-index:1}

/* top scan line: one thin beam drifting down the whole panel */
[data-dsh-webpilot] .wp-scanline{
  position:absolute;left:0;right:0;top:0;height:2px;z-index:8;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(10,124,147,.26) 18%,rgba(10,124,147,.42) 50%,rgba(10,124,147,.26) 82%,transparent);
  box-shadow:0 0 12px rgba(10,124,147,.16);opacity:.45;
  animation:wp-scan 7.5s linear infinite;
}
@keyframes wp-scan{0%{transform:translateY(0);opacity:0}6%{opacity:.42}50%{opacity:.36}94%{opacity:.3}100%{transform:translateY(100vh);opacity:0}}

/* ---------------- status strip ---------------- */
[data-dsh-webpilot] .wp-head{
  flex:none;display:flex;align-items:center;gap:9px;padding:8px 10px 7px;
  border-bottom:1px solid var(--wp-line);
  background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(246,249,252,.72));
  backdrop-filter:blur(6px);
}
[data-dsh-webpilot] .wp-mark{display:flex;align-items:center;gap:7px;flex:none;min-width:0}
[data-dsh-webpilot] .wp-mark-badge{
  width:23px;height:23px;flex:none;display:grid;place-items:center;border-radius:4px;
  border:1px solid rgba(10,124,147,.34);background:rgba(10,124,147,.06);
  color:var(--wp-cyan);font:700 9.5px/1 var(--wp-mono);letter-spacing:.04em;
  box-shadow:0 1px 6px rgba(20,50,80,.08);
}
[data-dsh-webpilot] .wp-mark-name{display:flex;flex-direction:column;gap:2px;min-width:0}
[data-dsh-webpilot] .wp-mark-name b{font:600 10px/1 var(--wp-mono);letter-spacing:.17em;color:#16273a;white-space:nowrap}
[data-dsh-webpilot] .wp-mark-name span{font:8px/1 var(--wp-mono);letter-spacing:.14em;color:#7a8fa3;white-space:nowrap}
[data-dsh-webpilot] .wp-status{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0}
[data-dsh-webpilot] .wp-pill{
  display:inline-flex;align-items:center;gap:6px;flex:none;
  padding:3px 8px 3px 7px;border-radius:99px;border:1px solid rgba(10,124,147,.26);
  background:rgba(10,124,147,.06);color:#0a6b80;
  font:9px/1 var(--wp-mono);letter-spacing:.12em;white-space:nowrap;
}
[data-dsh-webpilot] .wp-pill b{font-weight:600;letter-spacing:.12em}
[data-dsh-webpilot] .wp-dot{
  width:5px;height:5px;border-radius:50%;flex:none;background:var(--wp-mint);
  box-shadow:0 0 0 2px rgba(13,138,95,.16);animation:wp-blink 1.8s ease-in-out infinite;
}
[data-dsh-webpilot] .wp-metrics{display:flex;align-items:center;gap:9px;min-width:0}
[data-dsh-webpilot] .wp-metric{font:8.5px/1 var(--wp-mono);letter-spacing:.09em;color:#7a8fa3;white-space:nowrap}
[data-dsh-webpilot] .wp-metric b{color:#3a5570;font-weight:500;letter-spacing:.06em}
[data-dsh-webpilot][data-tone="standby"] .wp-pill{border-color:rgba(92,113,134,.24);background:rgba(92,113,134,.07);color:#5c7186}
[data-dsh-webpilot][data-tone="standby"] .wp-dot{background:#94a7b8;box-shadow:none;animation:none}
[data-dsh-webpilot][data-tone="takeover"] .wp-pill{border-color:rgba(162,104,15,.42);background:rgba(162,104,15,.08);color:#7d4f08}
[data-dsh-webpilot][data-tone="takeover"] .wp-dot{background:var(--wp-amber);box-shadow:0 0 0 2px rgba(162,104,15,.16)}
[data-dsh-webpilot][data-tone="offline"] .wp-pill{border-color:rgba(207,52,80,.38);background:rgba(207,52,80,.07);color:#a52a41}
[data-dsh-webpilot][data-tone="offline"] .wp-dot{background:var(--wp-red);box-shadow:0 0 0 2px rgba(207,52,80,.16)}
[data-dsh-webpilot][data-tone="link"] .wp-dot{background:var(--wp-cyan);box-shadow:0 0 0 2px rgba(10,124,147,.16)}

/* ---------------- terminal URL bar ---------------- */
[data-dsh-webpilot] .wp-urlrow{
  flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;
  border-bottom:1px solid var(--wp-line);
  background:rgba(20,50,80,.03);
}
[data-dsh-webpilot] .wp-location{
  flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:26px;padding:0 9px;
  border:1px solid rgba(20,50,80,.12);border-radius:4px;
  background:linear-gradient(180deg,#ffffff,#f4f7fa);
  box-shadow:inset 0 1px 2px rgba(20,50,80,.05);overflow:hidden;
}
[data-dsh-webpilot] .wp-prompt{flex:none;color:var(--wp-cyan);opacity:.85;font:10px/1 var(--wp-mono)}
[data-dsh-webpilot] .wp-url-site{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--wp-mint);font:10.5px/1 var(--wp-mono);letter-spacing:.02em}
[data-dsh-webpilot] .wp-url-path{
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:#65798d;font:10.5px/1 var(--wp-mono);
}
[data-dsh-webpilot] .wp-caret{
  width:5px;height:11px;flex:none;background:var(--wp-cyan);opacity:.7;
  box-shadow:0 0 0 1px rgba(10,124,147,.2);animation:wp-caret 1.15s steps(2) infinite;
}
[data-dsh-webpilot] .wp-location{position:relative;cursor:text}
[data-dsh-webpilot] .wp-address{
  position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0 9px;
  border:0;border-radius:4px;background:transparent;outline:none;
  color:#14273b;caret-color:var(--wp-cyan);
  font:10.5px/1 var(--wp-mono);letter-spacing:.02em;
}
[data-dsh-webpilot] .wp-address--ghost{color:transparent;caret-color:transparent}
[data-dsh-webpilot] .wp-address--ghost::placeholder{color:transparent}
[data-dsh-webpilot] .wp-address::placeholder{color:#8ba0b3;opacity:.9}
[data-dsh-webpilot] .wp-location--edit{
  border-color:rgba(10,124,147,.55);
  box-shadow:0 0 0 3px rgba(10,124,147,.12);
}
[data-dsh-webpilot] .wp-location--edit .wp-caret{display:none}
[data-dsh-webpilot] .wp-navbtns{display:flex;align-items:center;gap:4px;flex:none}
[data-dsh-webpilot] .wp-navbtn{
  width:24px;height:24px;display:grid;place-items:center;padding:0;cursor:pointer;
  border:1px solid rgba(20,50,80,.16);border-radius:3px;background:#ffffff;
  color:#3b5672;font:12px/1 var(--wp-mono);
}
[data-dsh-webpilot] .wp-navbtn:hover:not(:disabled){border-color:rgba(10,124,147,.5);color:#0a6175;background:rgba(10,124,147,.07);box-shadow:0 1px 6px rgba(20,50,80,.1)}
[data-dsh-webpilot] .wp-navbtn:disabled{opacity:.32;cursor:default}

/* ---------------- tool chips ---------------- */
[data-dsh-webpilot] .wp-tools{
  flex:none;display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:5px 8px;
  border-bottom:1px solid var(--wp-line);background:rgba(20,50,80,.025);
}
[data-dsh-webpilot] .wp-chip{
  border:1px solid rgba(20,50,80,.14);border-radius:3px;background:#ffffff;
  color:#4c627a;cursor:pointer;padding:4px 7px;
  font:9px/1.1 var(--wp-mono);letter-spacing:.07em;text-transform:uppercase;white-space:nowrap;
}
[data-dsh-webpilot] .wp-chip:hover:not(:disabled){border-color:rgba(10,124,147,.42);color:#0a6175;background:rgba(10,124,147,.07);box-shadow:0 1px 6px rgba(20,50,80,.1)}
[data-dsh-webpilot] .wp-chip:disabled{opacity:.34;cursor:default}
[data-dsh-webpilot] .wp-chip.danger{color:#b02a42;border-color:rgba(207,52,80,.24)}
[data-dsh-webpilot] .wp-chip.danger:hover:not(:disabled){border-color:rgba(207,52,80,.55);background:rgba(207,52,80,.07);color:#8c1e35}
[data-dsh-webpilot] .wp-tools-spacer{flex:1}

/* ---------------- human takeover banner ---------------- */
[data-dsh-webpilot] .wp-banner{
  flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;
  background:linear-gradient(90deg,rgba(162,104,15,.09),rgba(162,104,15,.03));
  border-bottom:1px solid rgba(162,104,15,.34);
  animation:wp-breathe 2.8s ease-in-out infinite;
}
@keyframes wp-breathe{
  0%,100%{box-shadow:inset 0 0 0 rgba(162,104,15,0),inset 0 -1px 0 rgba(162,104,15,.18)}
  50%{box-shadow:inset 0 0 22px rgba(162,104,15,.08),inset 0 -1px 0 rgba(162,104,15,.4)}
}
[data-dsh-webpilot] .wp-banner strong{flex:none;color:var(--wp-amber);font:600 9.5px/1 var(--wp-mono);letter-spacing:.12em;text-transform:uppercase}
[data-dsh-webpilot] .wp-banner-text{flex:1;min-width:120px;font:11px/1.45 var(--wp-mono);color:#7d4f08}
[data-dsh-webpilot] .wp-banner input{
  flex:1 1 130px;min-width:100px;padding:4px 7px;border-radius:3px;
  border:1px solid rgba(162,104,15,.3);background:#ffffff;color:#4d3006;
  font:10.5px var(--wp-mono);outline:none;
}
[data-dsh-webpilot] .wp-banner input::placeholder{color:#a08b6c}
[data-dsh-webpilot] .wp-banner input:focus{border-color:rgba(162,104,15,.6);box-shadow:0 0 0 3px rgba(162,104,15,.12)}

/* ---------------- stage ---------------- */
[data-dsh-webpilot] .wp-stage{
  position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  overflow:hidden;
  /* The contain-fit letterbox bands are most of a tall panel, so they get the
     console treatment instead of flat void: a hatch field, a centre bloom and
     a slow sweep that only shows outside the page. */
  background:
    repeating-linear-gradient(135deg,rgba(20,50,80,.028) 0 1px,transparent 1px 9px),
    radial-gradient(ellipse 74% 52% at 50% 48%,#fbfcfe 0%,#eef3f9 58%,#e2eaf3 100%);
}
[data-dsh-webpilot] .wp-stage::before{
  content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background-image:
    linear-gradient(rgba(20,50,80,.05) 1px,transparent 1px),
    linear-gradient(90deg,rgba(20,50,80,.05) 1px,transparent 1px);
  background-size:20px 20px;opacity:.55;
}
[data-dsh-webpilot] .wp-stage::after{
  content:"";position:absolute;inset:-10% 0;pointer-events:none;z-index:0;
  background:linear-gradient(180deg,transparent 0%,rgba(10,124,147,.012) 38%,rgba(10,124,147,.03) 47%,rgba(10,124,147,.045) 50%,rgba(10,124,147,.03) 53%,rgba(10,124,147,.012) 62%,transparent 100%);
  animation:wp-band-sweep 6.5s linear infinite;
}
@keyframes wp-band-sweep{
  0%{transform:translateY(-42%)}
  100%{transform:translateY(42%)}
}
[data-dsh-webpilot] .wp-frame{
  display:block;max-width:100%;max-height:100%;outline:none;position:relative;z-index:1;
  background:#ffffff;cursor:crosshair;
  box-shadow:
    0 0 0 1px rgba(20,50,80,.22),
    0 0 0 4px rgba(255,255,255,.85),
    0 18px 44px -20px rgba(20,50,80,.42);
}
[data-dsh-webpilot] .wp-fx{
  position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;display:block;
}
[data-dsh-webpilot] .wp-corner{
  position:absolute;z-index:3;width:15px;height:15px;pointer-events:none;
  border:0 solid rgba(10,124,147,.4);
}
[data-dsh-webpilot] .wp-corner.tl{top:8px;left:8px;border-top-width:1px;border-left-width:1px}
[data-dsh-webpilot] .wp-corner.tr{top:8px;right:8px;border-top-width:1px;border-right-width:1px}
[data-dsh-webpilot] .wp-corner.bl{bottom:8px;left:8px;border-bottom-width:1px;border-left-width:1px}
[data-dsh-webpilot] .wp-corner.br{bottom:8px;right:8px;border-bottom-width:1px;border-right-width:1px}

/* ---------------- HUD ---------------- */
[data-dsh-webpilot] .wp-hud{
  position:absolute;left:11px;bottom:10px;z-index:4;pointer-events:none;
  display:flex;flex-direction:column;gap:1px;max-width:calc(100% - 96px);
}
[data-dsh-webpilot] .wp-hud-line{
  display:flex;align-items:baseline;gap:6px;min-width:0;
  padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.92);
  border:1px solid rgba(20,50,80,.08);
  font:9px/1.55 var(--wp-mono);color:#26465f;
  animation:wp-log-in .22s ease both;
}
[data-dsh-webpilot] .wp-hud-time{flex:none;color:#6a8098;font-variant-numeric:tabular-nums}
[data-dsh-webpilot] .wp-hud-tag{flex:none;width:44px;letter-spacing:.08em;color:#55708a}
[data-dsh-webpilot] .wp-hud-msg{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-webpilot] .wp-hud-line[data-kind="click"] .wp-hud-tag{color:var(--wp-cyan)}
[data-dsh-webpilot] .wp-hud-line[data-kind="drag"] .wp-hud-tag{color:var(--wp-violet)}
[data-dsh-webpilot] .wp-hud-line[data-kind="read"] .wp-hud-tag{color:var(--wp-mint)}
[data-dsh-webpilot] .wp-hud-line[data-kind="type"] .wp-hud-tag{color:var(--wp-violet)}
[data-dsh-webpilot] .wp-hud-line[data-kind="scroll"] .wp-hud-tag{color:#2d7f96}
[data-dsh-webpilot] .wp-hud-line[data-kind="nav"] .wp-hud-tag{color:var(--wp-amber)}
[data-dsh-webpilot] .wp-hud-line[data-kind="key"] .wp-hud-tag{color:var(--wp-mint)}
[data-dsh-webpilot] .wp-hud-line[data-kind="human"] .wp-hud-tag{color:var(--wp-amber)}
[data-dsh-webpilot] .wp-hud-line[data-kind="err"] .wp-hud-tag,
[data-dsh-webpilot] .wp-hud-line[data-kind="err"] .wp-hud-msg{color:#b02a42}
[data-dsh-webpilot] .wp-hud-line[data-kind="link"] .wp-hud-tag{color:var(--wp-cyan)}
@keyframes wp-log-in{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:none}}
[data-dsh-webpilot] .wp-hud-foot{
  position:absolute;right:11px;bottom:10px;z-index:4;pointer-events:none;text-align:right;
  padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.92);
  border:1px solid rgba(20,50,80,.08);
  font:8px/1.55 var(--wp-mono);letter-spacing:.13em;color:#576f88;
}
[data-dsh-webpilot] .wp-hud-foot-line{white-space:nowrap}

/* ---------------- overlays / standby ---------------- */
[data-dsh-webpilot] .wp-overlay{
  position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;
  pointer-events:none;padding:20px;text-align:center;
}
[data-dsh-webpilot] .wp-overlay-note{
  max-width:92%;padding:5px 10px;border-radius:3px;
  border:1px solid rgba(20,50,80,.14);background:rgba(255,255,255,.92);
  font:9.5px/1.6 var(--wp-mono);letter-spacing:.14em;color:#5c7186;text-transform:uppercase;
}
[data-dsh-webpilot] .wp-standby{
  position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:10px;padding:26px;text-align:center;pointer-events:auto;
}
[data-dsh-webpilot] .wp-standby-mark{
  font:700 clamp(17px,5vw,23px)/1.1 var(--wp-mono);letter-spacing:.2em;color:#12293d;
}
[data-dsh-webpilot] .wp-standby-mark em{font-style:normal;color:var(--wp-cyan)}
[data-dsh-webpilot] .wp-standby-line{
  width:136px;height:1px;margin:2px 0;
  background:linear-gradient(90deg,transparent,rgba(10,124,147,.5),transparent);
}
[data-dsh-webpilot] .wp-standby-sub{max-width:320px;font:9.5px/1.75 var(--wp-mono);letter-spacing:.08em;color:#5c7186}
[data-dsh-webpilot] .wp-open{
  margin-top:4px;padding:8px 18px;border-radius:4px;cursor:pointer;
  border:1px solid rgba(10,124,147,.5);background:rgba(10,124,147,.07);color:#0a6175;
  font:600 10.5px/1 var(--wp-mono);letter-spacing:.14em;text-transform:uppercase;
  box-shadow:0 2px 10px rgba(20,50,80,.1);
  transition:box-shadow .2s ease,background .2s ease;
}
[data-dsh-webpilot] .wp-open:hover:not(:disabled){background:rgba(10,124,147,.13);box-shadow:0 4px 16px rgba(20,50,80,.16)}
[data-dsh-webpilot] .wp-open:disabled{opacity:.5;cursor:default}
[data-dsh-webpilot] .wp-standby-error{max-width:340px;font:9.5px/1.6 var(--wp-mono);color:#b02a42;word-break:break-word}
[data-dsh-webpilot] .wp-hint{
  position:absolute;right:11px;bottom:38px;z-index:4;max-width:58%;pointer-events:none;
  padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.88);
  border:1px solid rgba(20,50,80,.08);
  font:8.5px/1.55 var(--wp-mono);letter-spacing:.05em;color:#576f88;
  text-align:right;
}
[data-dsh-webpilot] .wp-sink{
  position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;z-index:-1;
}
[data-dsh-webpilot] .wp-notice{
  display:flex;align-items:center;justify-content:center;flex:1;min-height:0;padding:24px;
  text-align:center;font:10px/1.8 var(--wp-mono);color:#5c7186;
}

/* sidebar tab chip (outside the shell) */
.wp-tab-title{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%}
.wp-tab-title .wp-tab-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-tab-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--wp-amber,#a2680f);box-shadow:none}

@keyframes wp-blink{0%,100%{opacity:1}50%{opacity:.28}}
@keyframes wp-caret{0%,49%{opacity:.9}50%,100%{opacity:0}}

@media (max-width:430px){
  [data-dsh-webpilot] .wp-metrics .wp-metric{display:none}
  [data-dsh-webpilot] .wp-metric-view{display:inline}
}
@media (prefers-reduced-motion: reduce){
  [data-dsh-webpilot] *,[data-dsh-webpilot] *::before,[data-dsh-webpilot] *::after{
    animation:none !important;transition:none !important;
  }
}
`

  root.WebPilotFx = {
    createFxEngine: createFxEngine,
    palette: PALETTE,
    css: CSS,
    mono: MONO,
    version: '1.0.0'
  }
})(typeof window !== 'undefined' ? window : globalThis)

window.__ModuleLoader__.load({
  id: 'dsh-webpilot',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** Tab type identity: the `id` both keyed seats (body, title) register under. */
    const TAB_ID = 'dsh-webpilot/panel'
    /** Page kind the type opens; `sidebarRight.openTabIn(session, TAB_KIND)` names it. */
    const TAB_KIND = 'webpilot'
    /** Every route this plugin owns; all same-origin, all cookie-authenticated. */
    const BASE = '/api/dsh-webpilot'
    const STREAM_PATH = `${BASE}/stream`
    const STATE_PATH = `${BASE}/state`
    const SESSIONS_PATH = `${BASE}/sessions`
    const OPEN_PATH = `${BASE}/open`
    const CLOSE_PATH = `${BASE}/close`
    const DONE_PATH = `${BASE}/human-done`
    /** Session state poll, used only while the websocket is not live. */
    const STATE_POLL_MS = 2000
    /** Reconnect backoff, so a host restart does not become a request storm. */
    const RECONNECT_BASE_MS = 800
    const RECONNECT_MAX_MS = 15000
    /** Pointer moves are throttled to ~25/s; a page does not need more. */
    const MOVE_THROTTLE_MS = 40
    /**
     * Auto-open poll, the *fallback* path only.
     *
     * Pushed `hello`/`state` messages and the Sidebar's `mounted` store wake the
     * watcher within ~60ms (see `notifySessionsChanged`), so this timer is what
     * catches the cases no message covers: a host that never pushes, or a
     * route that failed once while the websocket was down. It still stays out
     * of the request storm's way — the live tab holds a WebSocket, and on
     * HTTP/1.1 a browser allows about six connections per origin shared by
     * every tab, which streaming plugins each sit on (references/PITFALLS.md
     * #18) — but an open that nobody sees for five seconds is a broken feature,
     * so the fallback is 1.5s.
     */
    const REVEAL_POLL_MS = 1500
    /** Auto-open poll while the document is hidden: nothing is being watched. */
    const REVEAL_IDLE_POLL_MS = 8000
    /** The chip's hand-over dot is decoration: a slow poll is enough. */
    const TITLE_POLL_MS = 5000
    /** Page viewport before the host tells us its real one (INTERFACE.md §1). */
    const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
    /** Bottom-left HUD keeps the last six telemetry lines. */
    const HUD_MAX_LINES = 6
    /** Shared renderer, exposed by the fx engine IIFE above. */
    const FX = (typeof window !== 'undefined' && window.WebPilotFx) || {}
    const CSS = typeof FX.css === 'string' ? FX.css : ''
    const createFxEngine = typeof FX.createFxEngine === 'function' ? FX.createFxEngine : () => null

    /** Copy for both shipped locales. */
    const DICT = {
      zh: {
        title: '浏览器',
        guideTitle: '内嵌浏览器',
        guideDescription: '在容器内自带 Chrome 里打开一个页面，可在此查看并接管（登录、扫码、验证码）。',
        back: '后退',
        forward: '前进',
        reload: '刷新',
        refresh: '重绘',
        addressLabel: '地址栏：输入网址后回车打开',
        addressPlaceholder: '输入网址，回车打开（例 example.com）',
        addressTitle: '点这里输入网址，回车打开；Esc 取消；Ctrl+L 选中当前网址',
        closeTab: '结束并清理',
        closeTabTitle: '关闭这个会话的浏览器标签页（未提交的页面状态会丢失）',
        closeTabConfirm: '关闭这个会话的浏览器标签页？未提交的表单与页面状态会丢失；登录态存在共享 profile 里，不会丢。',
        connecting: '连接中…',
        connected: '已连接',
        offline: '连接断开，正在重连…',
        stopped: '浏览器未启动',
        failed: '浏览器启动失败',
        checking: '正在检查这个会话的浏览器…',
        empty: '这个会话还没有打开浏览器',
        emptyHint: '打开后这里就是 AI 正在操作的页面；登录、扫码、验证码都可以直接在这里完成。',
        standbySub: '等待 Agent 打开浏览器 —— 页面画面、操作轨迹与特效会实时投射在这里。',
        open: '在此会话打开浏览器',
        starting: '正在打开…',
        openFailed: '打开失败',
        waitingFrame: '正在获取画面…',
        humanTitle: '需要你操作',
        humanDone: '我已完成',
        humanHint: '完成上方操作后点此按钮，AI 会接着往下做；也可以留一句话再回复。',
        reply: '回复',
        replyPlaceholder: '留一句话给 AI（可选）',
        pollHint: '降帧快照 ~7fps（标签页不在前台）',
        noSession: '这里拿不到会话 id，无法确定这个标签页对应哪个浏览器标签页。',
        pending: '需要你',
        tab: '把焦点移到下一个可输入元素（免鼠标定位）',
        shiftTab: '焦点移到上一个元素',
        enter: '回车（提交 / 确认）',
        hintLive: '点画面聚焦 · 键盘/输入法直接回灌 · AI 看到同一页面',
        instructions: '点画面任意处即可聚焦，然后用键盘/输入法打字（登录页常用）；表单还可以用工具栏的 Tab / Enter 逐项跳转提交。AI 看到的是同一个页面。',
      },
      en: {
        title: 'Browser',
        guideTitle: 'Embedded browser',
        guideDescription: 'Open a page in a Chrome that lives in this container, and watch or take it over here (logins, QR codes, CAPTCHAs).',
        back: 'Back',
        forward: 'Forward',
        reload: 'Reload',
        refresh: 'Repaint',
        addressLabel: 'Address bar: type a URL and press Enter',
        addressPlaceholder: 'Type a URL, Enter to open (e.g. example.com)',
        addressTitle: 'Click to type an address, Enter opens it; Esc cancels; Ctrl+L selects the current URL',
        closeTab: 'Close tab',
        closeTabTitle: 'Close this session’s browser tab (its page state is discarded)',
        closeTabConfirm: 'Close this session’s browser tab? Unsaved form and page state are lost — logins live in the shared profile and stay.',
        connecting: 'Connecting…',
        connected: 'Connected',
        offline: 'Disconnected — reconnecting…',
        stopped: 'Browser not running',
        failed: 'Browser failed to start',
        checking: 'Checking this session’s browser…',
        empty: 'This session has no browser open yet',
        emptyHint: 'Once opened, this is the page the AI is working on — logins, QR codes and CAPTCHAs can be done right here.',
        standbySub: 'Waiting for the agent to open a browser — the live page, action trails and effects are projected here.',
        open: 'Open a browser in this session',
        starting: 'Opening…',
        openFailed: 'Could not open',
        waitingFrame: 'Fetching the first frame…',
        humanTitle: 'Your turn',
        humanDone: 'Done',
        humanHint: 'Finish the step above, then press this — the AI continues from there. You can also leave a note in the reply field.',
        reply: 'Reply',
        replyPlaceholder: 'Leave the AI a note (optional)',
        pollHint: 'Low-rate stills ~7fps (tab not in front)',
        noSession: 'No session id here, so this tab cannot tell which browser tab it shows.',
        pending: 'Needs you',
        tab: 'Move focus to the next field (no mouse aiming needed)',
        shiftTab: 'Move focus to the previous element',
        enter: 'Enter (submit / confirm)',
        hintLive: 'Click the picture to focus · keyboard / IME is replayed · the AI sees the same page',
        instructions: 'Click anywhere in the picture to focus it, then type with your keyboard or IME (handy for logins); use the Tab / Enter buttons to walk a form without aiming the mouse. The AI sees the same page.',
      },
    }

    /** Pick the dictionary that matches the GUI language. */
    function pickDict(locale) {
      const code = String(locale ?? '').toLowerCase()
      return code.startsWith('zh') ? DICT.zh : DICT.en
    }

    /** Modifier list for the host's key dispatch. */
    const modifiersOf = (event) => {
      const list = []
      if (event.altKey) list.push('alt')
      if (event.ctrlKey) list.push('ctrl')
      if (event.metaKey) list.push('meta')
      if (event.shiftKey) list.push('shift')
      return list
    }

    /** Keys forwarded explicitly; everything else is typed through the sink. */
    const SPECIAL_KEYS = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    }

    /**
     * Fetch one JSON document on the GUI's own origin.
     *
     * Every route is protected by the Web UI's session cookie, so the request
     * must stay same-origin and credentialed; a non-2xx answer is an error the
     * caller renders instead of a silently empty panel.
     */
    async function requestJson(url, options) {
      const { method = 'GET', body } = options ?? {}
      const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * Announce that session state moved, so the auto-open watcher can look now.
     *
     * A pushed `hello`/`state` message is exactly the moment "this session just
     * got a browser" can become true, and waiting for the fallback poll after
     * it is what made the panel appear seconds late. A window event keeps both
     * halves decoupled: the panel needs no reference to the watcher, and a
     * page without a watcher simply has no listener.
     */
    function notifySessionsChanged() {
      try {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
        window.dispatchEvent(new CustomEvent('webpilot:sessions'))
      } catch {
        /* a host without CustomEvent keeps the fallback poll */
      }
    }

    /** Normalize a viewport record (`{width,height}`) or return null. */
    function normalizeViewport(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object') return null
      const width = Number(raw.width)
      const height = Number(raw.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
      return { width: Math.round(width), height: Math.round(height) }
    }

    /**
     * Normalize the `/state` payload (`GET /state`, the body of `POST /open`, and
     * the `status` field of a `hello` message) into the few fields the panel uses.
     */
    function snapshotFromState(payload) {
      const session = payload?.session ?? {}
      return {
        open: session.open === true,
        running: payload?.running === true,
        url: typeof session.url === 'string' ? session.url : null,
        title: typeof session.title === 'string' ? session.title : null,
        viewport: normalizeViewport(session.viewport),
        human: payload?.human ?? null,
        stream: payload?.stream === 'poll' || payload?.stream === 'screencast' ? payload.stream : null,
      }
    }

    /** Normalize a pushed `{ type: 'state' }` message (a flatter shape). */
    function snapshotFromMessage(message) {
      return {
        open: message.open === true,
        running: message.running === true,
        url: typeof message.url === 'string' ? message.url : null,
        title: typeof message.title === 'string' ? message.title : null,
        viewport: normalizeViewport(message.viewport),
        human: message.human ?? null,
        stream: message.stream === 'poll' || message.stream === 'screencast' ? message.stream : null,
      }
    }

    /** Whether two pending-request snapshots describe the same request. */
    function sameHuman(left, right) {
      if (left === right) return true
      if (left === undefined || left === null || right === undefined || right === null) return false
      return left.id === right.id && left.instruction === right.instruction
    }

    /** Split a URL into the terminal-ish pieces the URL bar renders. */
    function splitUrl(raw) {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '' || text === 'about:blank') {
        return { site: 'about:blank', path: '', secure: false }
      }
      try {
        const parsed = new URL(text)
        if (parsed.protocol === 'about:') return { site: 'about:blank', path: '', secure: false }
        const path = `${parsed.pathname === '/' ? '/' : parsed.pathname}${parsed.search}${parsed.hash}`
        return { site: parsed.host || text, path, secure: parsed.protocol === 'https:' }
      } catch {
        return { site: text, path: '', secure: text.startsWith('https:') }
      }
    }

    /** HH:MM:SS for HUD lines. */
    function stampNow() {
      const date = new Date()
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    /** Short, single-line version of a HUD message. */
    function truncate(value, max) {
      const text = String(value ?? '')
      return text.length > max ? `${text.slice(0, max - 1)}…` : text
    }

    /** Last few characters of an id, for the status strip. */
    function shortId(id) {
      const text = String(id ?? '')
      return text.length > 8 ? text.slice(-6) : text
    }

    /** The sidebar entry glyph: a small window with a cursor. */
    function BrowserIcon(props) {
      const { size = 16, active = false } = props ?? {}
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
        h('path', { d: 'M1.5 5.5h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 3.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('circle', { cx: 5.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('path', { d: 'M7 8.5l4.6 1.9-1.8.8-.8 1.8z', fill: 'currentColor' }),
      )
    }

    /**
     * One session's browser tab, drawn as the right-Sidebar tab body.
     *
     * The slot entry is session-scoped, so `sessionId` already identifies the
     * very browser tab this component must show. Its **visibility** is the focus
     * protocol: a docked body is mounted while its tab is the visible one, which
     * is the moment to ask the host to put this browser tab in front and stream
     * it at full rate; hiding hands the foreground back. **It never closes the
     * browser tab** — that belongs to the session, not to the surface.
     */
    function SessionPanel(props) {
      const { dict } = props
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : ''
      // A docked body stays mounted while its tab is inactive or the column is
      // collapsed, so "am I on screen" is not "am I mounted": the stream must be
      // driven by visibility, or a hidden tab would keep stealing the browser's
      // foreground and spend bandwidth nobody is looking at.
      const visible = props.visible !== false
      const stageRef = useRef(null)
      const fxRef = useRef(null)
      const engineRef = useRef(null)
      const canvasRef = useRef(null)
      const sinkRef = useRef(null)
      const socketRef = useRef(null)
      const bitmapRef = useRef(undefined)
      const decodingRef = useRef(false)
      const lastMoveRef = useRef(0)
      const rootRef = useRef(null)
      const addressRef = useRef(null)
      const viewportRef = useRef({ ...DEFAULT_VIEWPORT })
      const fpsRef = useRef({ count: 0, since: 0 })
      const logSeqRef = useRef(0)
      const [open, setOpen] = useState(undefined)
      const [connection, setConnection] = useState('idle')
      const [status, setStatus] = useState({})
      const [streamMode, setStreamMode] = useState(undefined)
      const [human, setHuman] = useState(undefined)
      const [failure, setFailure] = useState(undefined)
      const [hasFrame, setHasFrame] = useState(false)
      const [frameSpec, setFrameSpec] = useState(undefined)
      const [fps, setFps] = useState(0)
      const [logs, setLogs] = useState(() => [
        { id: 0, t: stampNow(), kind: 'system', tag: 'BOOT', text: 'webpilot panel ready' },
      ])
      const [busy, setBusy] = useState(false)
      const [reply, setReply] = useState('')
      const [address, setAddress] = useState(undefined)

      /** Append one telemetry line, keeping the last {@link HUD_MAX_LINES}. */
      const pushLog = useCallback((kind, tag, text) => {
        logSeqRef.current += 1
        const entry = { id: logSeqRef.current, t: stampNow(), kind, tag, text: String(text ?? '') }
        setLogs((current) => {
          const next = current.concat(entry)
          return next.length > HUD_MAX_LINES ? next.slice(next.length - HUD_MAX_LINES) : next
        })
      }, [])

      /**
       * Fold one normalized snapshot into render state.
       *
       * The functional setters keep object identities stable when nothing
       * changed, so the 2s poll cannot re-render the canvas away or fight a
       * half-typed reply.
       */
      const applySnapshot = useCallback((snapshot) => {
        if (snapshot === undefined || snapshot === null) return
        setOpen(snapshot.open === true)
        setStatus((current) => {
          const viewport = normalizeViewport(snapshot.viewport) ?? normalizeViewport(current.viewport)
          const sameViewport =
            viewport === current.viewport ||
            (viewport !== null &&
              current.viewport != null &&
              viewport.width === current.viewport.width &&
              viewport.height === current.viewport.height)
          if (
            current.running === snapshot.running &&
            current.url === snapshot.url &&
            current.title === snapshot.title &&
            sameViewport
          ) {
            return current
          }
          return { running: snapshot.running, url: snapshot.url, title: snapshot.title, viewport }
        })
        setHuman((current) => (sameHuman(current, snapshot.human) ? current : snapshot.human ?? undefined))
        setStreamMode((current) => {
          const next = snapshot.stream === 'screencast' || snapshot.stream === 'poll' ? snapshot.stream : undefined
          return current === next ? current : next
        })
      }, [])

      /**
       * Paint one JPEG frame onto the picture canvas.
       *
       * The bitmap's intrinsic size is the page viewport in CSS px (the host
       * streams at deviceScaleFactor 1), so it doubles as the coordinate space
       * for the fx overlay. Frames also drive the fps readout, which is why that
       * counter lives beside the decode instead of on a timer.
       */
      const paint = useCallback(async (buffer) => {
        const canvas = canvasRef.current
        if (canvas === null) return
        try {
          const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }))
          const previous = bitmapRef.current
          if (previous !== undefined && typeof previous.close === 'function') {
            try {
              previous.close()
            } catch {
              /* already released */
            }
          }
          bitmapRef.current = bitmap
          setHasFrame(true)
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          if (context !== null) context.drawImage(bitmap, 0, 0)
          setFrameSpec((current) =>
            current !== undefined && current.width === bitmap.width && current.height === bitmap.height
              ? current
              : { width: bitmap.width, height: bitmap.height },
          )
          const now = Date.now()
          const counter = fpsRef.current
          counter.count += 1
          if (counter.since === 0) counter.since = now
          else if (now - counter.since >= 1000) {
            setFps(Math.round((counter.count * 1000) / (now - counter.since)))
            counter.count = 0
            counter.since = now
          }
          // A frame that paints is the proof that whatever failed has recovered:
          // a genuinely broken browser stops sending them, and the note stays.
          setFailure(undefined)
        } catch {
          /* a torn frame is not worth surfacing */
        }
      }, [])

      /** Send one panel message when the socket is open; otherwise do nothing. */
      const send = useCallback((message) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(message))
      }, [])

      /**
       * Map a pointer event to page viewport coordinates. The picture canvas
       * displays one full viewport, so the ratio of the known page viewport to
       * the canvas' CSS width is the exact mapping (even when the stream is
       * scaled for bandwidth and the bitmap is not 1:1 with CSS px).
       */
      const toPageCoords = (event) => {
        const canvas = canvasRef.current
        const viewport = viewportRef.current
        if (canvas === null) return { x: 0, y: 0 }
        const rect = canvas.getBoundingClientRect()
        const scaleX = viewport.width / Math.max(1, rect.width)
        const scaleY = viewport.height / Math.max(1, rect.height)
        return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY }
      }

      /** Send one key and keep the keyboard sink focused for follow-up typing. */
      const pressKey = (spec, modifiers = []) => {
        send({ type: 'input', kind: 'key', event: 'down', ...spec, modifiers })
        send({ type: 'input', kind: 'key', event: 'up', ...spec, modifiers })
        sinkRef.current?.focus?.()
      }

      /** Route one host fx message into the overlay and the HUD. */
      const handleFx = useCallback(
        (message) => {
          if (message === null || message === undefined || typeof message !== 'object') return
          const kind = message.kind
          if (typeof kind !== 'string') return
          const engine = engineRef.current
          if (engine !== null) {
            try {
              engine.push(message)
            } catch (error) {
              console.warn('[dsh-webpilot] fx renderer rejected an event:', error)
            }
          }
          const x = Number(message.x)
          const y = Number(message.y)
          switch (kind) {
            case 'click': {
              const at = Number.isFinite(x) && Number.isFinite(y) ? `→ (${Math.round(x)}, ${Math.round(y)})` : '→ element'
              const label = typeof message.label === 'string' && message.label !== '' ? ` · ${truncate(message.label, 38)}` : ''
              pushLog('click', 'CLICK', `${at}${label}`)
              break
            }
            case 'drag': {
              const from = message.from !== null && typeof message.from === 'object' ? message.from : {}
              const to = message.to !== null && typeof message.to === 'object' ? message.to : {}
              const ms = Number(message.durationMs)
              const span = `(${Math.round(Number(from.x) || 0)}, ${Math.round(Number(from.y) || 0)}) → (${Math.round(Number(to.x) || 0)}, ${Math.round(Number(to.y) || 0)})`
              pushLog('drag', 'DRAG', Number.isFinite(ms) && ms > 0 ? `${span} · ${Math.round(ms)}ms` : span)
              break
            }
            case 'read': {
              const count = Array.isArray(message.boxes) ? message.boxes.length : 0
              const title =
                typeof message.title === 'string' && message.title !== ''
                  ? truncate(message.title, 28)
                  : typeof message.url === 'string' && message.url !== ''
                    ? truncate(message.url, 34)
                    : 'page'
              pushLog('read', 'READ', `${title} · ${count} blocks`)
              break
            }
            case 'type':
              pushLog('type', 'TYPE', `“${truncate(message.text, 32)}”`)
              break
            case 'scroll': {
              const direction = typeof message.direction === 'string' ? message.direction : 'down'
              const dy = Number(message.dy)
              pushLog('scroll', 'SCROLL', Number.isFinite(dy) && dy !== 0 ? `${direction} · dy ${Math.round(dy)}` : direction)
              break
            }
            case 'nav': {
              const url = truncate(message.url, 38)
              pushLog('nav', 'NAV', message.phase === 'done' ? `done · ${url}` : `start · ${url}`)
              break
            }
            case 'key':
              pushLog('key', 'KEY', `[${truncate(message.key, 12)}]`)
              break
            case 'idle':
              pushLog('system', 'IDLE', 'fx settle')
              break
            default:
              // Unknown kinds are ignored on purpose (INTERFACE.md §2).
              break
          }
        },
        [pushLog],
      )

      /**
       * The live channel of *this* session's tab.
       *
       * Reconnects with backoff while this tab is on screen, asks for `focus` on
       * (re)connect — the host then activates this browser tab and upgrades it to
       * a full-rate screencast — and seeds one frame with `play`, because a static
       * page produces no frames of its own. A session without a tab, or a tab the
       * human is not looking at, never holds a socket at all.
       */
      useEffect(() => {
        if (sessionId === '' || open !== true || visible !== true) {
          setConnection('idle')
          return undefined
        }
        let disposed = false
        let attempt = 0
        let timer
        const clearTimer = () => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
        }
        const schedule = () => {
          if (disposed) return
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) + Math.round(Math.random() * 250)
          attempt += 1
          clearTimer()
          timer = setTimeout(connect, delay)
        }
        const connect = () => {
          if (disposed) return
          setConnection('connecting')
          const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
          let socket
          try {
            socket = new WebSocket(`${scheme}//${window.location.host}${STREAM_PATH}?session=${encodeURIComponent(sessionId)}`)
          } catch {
            schedule()
            return
          }
          socket.binaryType = 'arraybuffer'
          socketRef.current = socket
          socket.onopen = () => {
            if (disposed) {
              try {
                socket.close()
              } catch {
                /* already closing */
              }
              return
            }
            attempt = 0
            setConnection('live')
            setFailure(undefined)
            if (document.visibilityState !== 'hidden') socket.send(JSON.stringify({ type: 'focus' }))
            // A static page emits nothing by itself: ask for one frame.
            socket.send(JSON.stringify({ type: 'play' }))
          }
          socket.onclose = () => {
            if (socketRef.current === socket) socketRef.current = null
            if (disposed) return
            setConnection('offline')
            schedule()
          }
          socket.onerror = () => {
            /* `onclose` always follows and owns the reconnect */
          }
          socket.onmessage = (event) => {
            if (typeof event.data !== 'string') {
              if (decodingRef.current) return
              decodingRef.current = true
              void paint(event.data).finally(() => {
                decodingRef.current = false
              })
              return
            }
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message.type === 'hello') {
              const snapshot = snapshotFromState(message.status ?? {})
              if (message.human !== undefined && message.human !== null) snapshot.human = message.human
              const helloViewport = normalizeViewport(message.viewport)
              if (helloViewport !== null) snapshot.viewport = helloViewport
              snapshot.stream = message.mode === 'screencast' || message.mode === 'poll' ? message.mode : null
              applySnapshot(snapshot)
              notifySessionsChanged()
              return
            }
            if (message.type === 'state') {
              applySnapshot(snapshotFromMessage(message))
              notifySessionsChanged()
              return
            }
            if (message.type === 'stream') {
              setStreamMode(message.mode === 'screencast' || message.mode === 'poll' ? message.mode : undefined)
              return
            }
            if (message.type === 'human-request') {
              setHuman(message.request ?? undefined)
              return
            }
            if (message.type === 'human-done' || message.type === 'human-timeout') {
              setHuman((current) => (current !== undefined && current.id === message.id ? undefined : current))
              return
            }
            if (message.type === 'fx') {
              handleFx(message)
              return
            }
            if (message.type === 'error') {
              setFailure(String(message.message ?? 'failed'))
              return
            }
            if (message.type === 'browser-stopped') {
              setFailure(undefined)
              setHasFrame(false)
              setFrameSpec(undefined)
              setFps(0)
              engineRef.current?.clear?.()
            }
            // `sessions` overview messages belong to the sidebar panel, not here.
          }
        }
        connect()
        return () => {
          disposed = true
          clearTimer()
          const socket = socketRef.current
          socketRef.current = null
          if (socket !== null) {
            try {
              if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'blur' }))
            } catch {
              /* the socket may already be gone */
            }
            try {
              socket.close()
            } catch {
              /* already closed */
            }
          }
          setConnection('idle')
        }
      }, [sessionId, open, visible, applySnapshot, paint, handleFx])

      /**
       * State poll for everything the socket cannot tell us yet: whether this
       * session has a tab at all, and what it shows while the socket is down
       * (reconnecting, or the host restarted). It stays out of the way while the
       * socket is live, which pushes state itself.
       */
      useEffect(() => {
        if (sessionId === '') return undefined
        let cancelled = false
        const tick = async () => {
          const socket = socketRef.current
          if (socket !== null && socket.readyState === 1) return
          try {
            const payload = await requestJson(`${STATE_PATH}?session=${encodeURIComponent(sessionId)}`)
            if (cancelled) return
            applySnapshot(snapshotFromState(payload))
          } catch {
            /* the GUI may be reloading; the next tick recovers */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), STATE_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, applySnapshot])

      /**
       * Mount the fx overlay once the stage exists; re-point it when the page
       * viewport is learned from the host or from the first bitmap.
       */
      useEffect(() => {
        const canvas = fxRef.current
        const stage = stageRef.current
        if (canvas === null || stage === null) return undefined
        const engine = createFxEngine({
          canvas,
          stage,
          viewport: viewportRef.current,
        })
        engineRef.current = engine
        return () => {
          engineRef.current = null
          if (engine !== null) engine.destroy()
        }
      }, [])

      /**
       * Keep the engine's page-coordinate space in sync with what the host is
       * actually projecting: `status.viewport` when the host reports it, else
       * the intrinsic size of the last frame (both are CSS px, INTERFACE.md §1).
       */
      const projectedViewport =
        status.viewport ?? (frameSpec !== undefined ? frameSpec : DEFAULT_VIEWPORT)
      const projectedWidth = projectedViewport.width
      const projectedHeight = projectedViewport.height
      useEffect(() => {
        const current = viewportRef.current
        if (current.width === projectedWidth && current.height === projectedHeight) return
        viewportRef.current = { width: projectedWidth, height: projectedHeight }
        engineRef.current?.setViewport?.(projectedWidth, projectedHeight)
      }, [projectedWidth, projectedHeight])

      /**
       * The wheel must reach the page instead of scrolling the GUI behind the
       * canvas. React registers `wheel` passively at its root, where
       * `preventDefault()` is a no-op, so this one listener is attached natively.
       */
      useEffect(() => {
        if (open !== true) return undefined
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.addEventListener !== 'function') return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const point = toPageCoords(event)
          send({ type: 'input', kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [open, send, sessionId])

      // Focus the keyboard sink as soon as a picture exists, so typing works
      // without an extra click (a click also focuses it — see onPointerDown).
      useEffect(() => {
        if (open !== true) return undefined
        const timer = setTimeout(() => sinkRef.current?.focus?.(), 120)
        return () => clearTimeout(timer)
      }, [open])

      /** A human arriving (or leaving) the page changes whether we want frames. */
      useEffect(() => {
        if (sessionId === '') return undefined
        const onVisibility = () => {
          const socket = socketRef.current
          if (socket === null || socket.readyState !== 1) return
          if (document.visibilityState === 'hidden') socket.send(JSON.stringify({ type: 'blur' }))
          else {
            socket.send(JSON.stringify({ type: 'focus' }))
            socket.send(JSON.stringify({ type: 'play' }))
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [sessionId])

      // Telemetry lines for the states the socket reports (not every render).
      const connectionRef = useRef('idle')
      useEffect(() => {
        const previous = connectionRef.current
        if (previous === connection) return
        connectionRef.current = connection
        if (connection === 'live') pushLog('link', 'LINK', 'screencast channel online')
        else if (connection === 'offline') pushLog('err', 'SIGNAL', 'lost · reconnecting')
        else if (connection === 'connecting' && previous !== 'idle') pushLog('system', 'LINK', 'handshake…')
      }, [connection, pushLog])

      const openRef = useRef(undefined)
      useEffect(() => {
        if (openRef.current === open) return
        if (openRef.current !== undefined) {
          pushLog('system', open === true ? 'OPEN' : 'CLOSE', open === true ? 'session browser attached' : 'session browser detached')
        }
        openRef.current = open
        if (open !== true) engineRef.current?.clear?.()
      }, [open, pushLog])

      const streamRef = useRef(undefined)
      useEffect(() => {
        if (streamMode === undefined || streamRef.current === streamMode) return
        streamRef.current = streamMode
        pushLog('system', 'MODE', streamMode === 'poll' ? 'poll fallback · stills ~7fps' : 'screencast · full rate')
      }, [streamMode, pushLog])

      useEffect(() => {
        if (human === undefined) return
        pushLog('human', 'HUMAN', 'takeover requested · your turn')
      }, [human?.id, pushLog])

      useEffect(() => {
        if (failure === undefined) return
        pushLog('err', 'ERROR', truncate(failure, 64))
      }, [failure, pushLog])

      useEffect(() => {
        if (connection !== 'live') setFps(0)
      }, [connection])

      /**
       * Answer a takeover request: over the socket when it is open, otherwise over
       * the HTTP endpoint, so a request can still be settled while the picture is
       * reconnecting.
       */
      const sendOrPost = (message, body) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) {
          socket.send(JSON.stringify(message))
          return
        }
        void requestJson(DONE_PATH, { method: 'POST', body }).catch(() => {})
      }

      /** 「我已完成」: settle the pending request without a reply. */
      const finishHuman = () => {
        const requestId = human?.id
        if (requestId === undefined) return
        sendOrPost({ type: 'human-done', requestId }, { id: requestId })
        setHuman(undefined)
      }

      /** Reply: settles the request with a note the waiting tool call receives. */
      const submitReply = () => {
        const requestId = human?.id
        const text = reply.trim()
        if (requestId === undefined || text === '') return
        sendOrPost({ type: 'human-reply', requestId, text }, { id: requestId, text })
        setReply('')
        setHuman(undefined)
      }

      /** Standby state: open this session's tab, then let the socket take over. */
      const openBrowser = async () => {
        if (sessionId === '') return
        setBusy(true)
        try {
          const payload = await requestJson(OPEN_PATH, { method: 'POST', body: { sessionId } })
          applySnapshot(snapshotFromState(payload))
          setFailure(undefined)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      /** Toolbar close: discards the page, so it always asks first. */
      const closeTab = async () => {
        if (sessionId === '') return
        if (typeof window.confirm === 'function' && !window.confirm(dict.closeTabConfirm)) return
        setBusy(true)
        try {
          await requestJson(CLOSE_PATH, { method: 'POST', body: { sessionId } })
          setHasFrame(false)
          setFrameSpec(undefined)
          setFailure(undefined)
          engineRef.current?.clear?.()
          applySnapshot({ open: false, running: status.running !== false, url: null, title: null, viewport: null, human: null, stream: null })
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const onPointerDown = (event) => {
        sinkRef.current?.focus?.()
        canvasRef.current?.setPointerCapture?.(event.pointerId)
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'down', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerUp = (event) => {
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'up', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerMove = (event) => {
        const now = Date.now()
        if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return
        lastMoveRef.current = now
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'move', x: point.x, y: point.y })
      }
      const onKeyDown = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special !== undefined) {
          event.preventDefault()
          send({
            type: 'input',
            kind: 'key',
            event: 'down',
            key: special.key,
            code: special.code,
            keyCode: special.keyCode,
            text: special.text,
            modifiers: modifiersOf(event),
          })
          return
        }
        // Everything else is typed: the sink's input event carries the glyph,
        // and IME composition arrives through compositionend.
      }
      const onKeyUp = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special === undefined) return
        send({
          type: 'input',
          kind: 'key',
          event: 'up',
          key: special.key,
          code: special.code,
          keyCode: special.keyCode,
          modifiers: modifiersOf(event),
        })
      }
      const onInput = (event) => {
        const text = event.target.value
        event.target.value = ''
        if (text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onCompositionEnd = (event) => {
        const text = event.data
        if (typeof text === 'string' && text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onPaste = (event) => {
        const text = event.clipboardData?.getData?.('text') ?? ''
        if (text !== '') {
          event.preventDefault()
          send({ type: 'input', kind: 'text', text })
        }
      }

      // Ctrl/Cmd+L focuses the address bar, like a browser — but only while the
      // panel (not the composer) has the focus, so the shell keeps its shortcut.
      useEffect(() => {
        const onKeyDown = (event) => {
          if ((event.ctrlKey || event.metaKey) !== true || event.altKey === true) return
          if (event.key !== 'l' && event.key !== 'L') return
          if (open !== true) return
          const root = rootRef.current
          if (root === null) return
          const active = typeof document === 'undefined' ? null : document.activeElement
          if (active !== null && active !== document.body && root.contains(active) !== true) return
          const current = typeof status.url === 'string' ? status.url : ''
          event.preventDefault()
          event.stopPropagation()
          setAddress(current)
          requestAnimationFrame(() => {
            const field = addressRef.current
            if (field === null) return
            field.focus()
            field.select()
          })
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open, status.url])

      if (sessionId === '') {
        return h('div', { 'data-dsh-webpilot': '', 'data-tone': 'standby' }, h('div', { className: 'wp-notice' }, dict.noSession))
      }

      const url = typeof status.url === 'string' ? status.url : ''
      const title = typeof status.title === 'string' ? status.title : ''
      const running = status.running !== false
      const live = connection === 'live'
      const canType = live && open === true
      const takeover = human !== undefined
      const urlParts = splitUrl(url)
      const viewportLabel = `${projectedWidth}×${projectedHeight}`
      const fpsLabel = live && fps > 0 ? String(fps) : live ? '--' : '--'
      const tone = takeover
        ? 'takeover'
        : open === true
          ? live
            ? 'live'
            : connection === 'offline'
              ? 'offline'
              : 'link'
          : 'standby'
      const stateLabel = takeover
        ? 'HUMAN-TAKEOVER'
        : open === true
          ? live
            ? 'LIVE'
            : connection === 'offline'
              ? 'OFFLINE'
              : 'LINKING'
          : open === undefined
            ? 'LINKING'
            : 'STANDBY'
      const modeLabel = open !== true ? 'NO SIGNAL' : streamMode === 'poll' ? 'POLL ~7FPS' : live ? 'SCREENCAST' : 'CHANNEL IDLE'
      const hint = open === true && live && hasFrame ? dict.hintLive : ''
      // The status words stay English (LIVE / READ / TAKEOVER) per INTERFACE.md §5.
      const overlayNote =
        open === true && failure !== undefined
          ? `ERR // ${dict.failed}: ${failure}`
          : open === true && failure === undefined && running === false
            ? `ERR // ${dict.stopped}`
            : open === true && failure === undefined && running && !hasFrame && live
              ? `LINK // ${dict.waitingFrame}`
              : ''

      const editingAddress = address !== undefined
      const commitAddress = () => {
        const raw = typeof address === 'string' ? address.trim() : ''
        setAddress(undefined)
        // The host owns address normalization and refuses what it cannot
        // navigate; an unchanged URL simply leaves the row alone.
        if (raw !== '' && raw !== url && !/\s/.test(raw)) send({ type: 'nav', action: 'goto', url: raw })
        const canvas = canvasRef.current
        if (canvas !== null) canvas.focus()
      }
      const cancelAddress = () => {
        setAddress(undefined)
        const canvas = canvasRef.current
        if (canvas !== null) canvas.focus()
      }

      return h(
        'div',
        { 'data-dsh-webpilot': '', 'data-tone': tone, ref: rootRef },
        h('i', { className: 'wp-scanline', 'aria-hidden': 'true' }),
        h(
          'header',
          { className: 'wp-head' },
          h(
            'div',
            { className: 'wp-mark' },
            h('span', { className: 'wp-mark-badge' }, 'WP'),
            h('span', { className: 'wp-mark-name' }, h('b', null, 'WEBPILOT'), h('span', null, 'CDP // LIVE VIEW')),
          ),
          h(
            'div',
            { className: 'wp-status' },
            h('span', { className: 'wp-pill' }, h('i', { className: 'wp-dot' }), h('b', null, stateLabel)),
            h(
              'div',
              { className: 'wp-metrics' },
              h('span', { className: 'wp-metric' }, 'FPS ', h('b', null, fpsLabel)),
              h('span', { className: 'wp-metric wp-metric-view' }, 'VIEW ', h('b', null, viewportLabel)),
            ),
          ),
        ),
        h(
          'div',
          { className: 'wp-urlrow' },
          h(
            'div',
            {
              className: editingAddress ? 'wp-location wp-location--edit' : 'wp-location',
              title: editingAddress ? dict.addressTitle : (url !== '' ? url : 'about:blank'),
            },
            editingAddress === false
              ? h('span', { className: 'wp-prompt' }, urlParts.secure ? 'https://' : '›')
              : null,
            editingAddress === false ? h('span', { className: 'wp-url-site' }, urlParts.site) : null,
            editingAddress === false ? h('span', { className: 'wp-url-path' }, urlParts.path) : null,
            editingAddress === false ? h('i', { className: 'wp-caret', 'aria-hidden': 'true' }) : null,
            h('input', {
              ref: addressRef,
              type: 'text',
              className: editingAddress ? 'wp-address' : 'wp-address wp-address--ghost',
              value: editingAddress ? address : url,
              // The hint belongs to the focused editor only: in the ghost state the
              // host may not have reported a URL yet, so an empty input would paint
              // the placeholder on top of the `about:blank` span.
              placeholder: editingAddress ? dict.addressPlaceholder : undefined,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': dict.addressLabel,
              title: dict.addressTitle,
              onFocus: (event) => {
                if (address !== undefined) return
                setAddress(url)
                const field = event.currentTarget
                const length = field.value.length
                requestAnimationFrame(() => field.setSelectionRange(0, length))
              },
              onChange: (event) => setAddress(event.target.value),
              onBlur: () => setAddress(undefined),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitAddress()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelAddress()
                }
              },
            }),
          ),
          h(
            'div',
            { className: 'wp-navbtns' },
            h('button', { type: 'button', className: 'wp-navbtn', disabled: !canType, title: dict.back, onClick: () => send({ type: 'nav', action: 'back' }) }, '←'),
            h('button', { type: 'button', className: 'wp-navbtn', disabled: !canType, title: dict.forward, onClick: () => send({ type: 'nav', action: 'forward' }) }, '→'),
            h('button', { type: 'button', className: 'wp-navbtn', disabled: !canType, title: dict.reload, onClick: () => send({ type: 'nav', action: 'reload' }) }, '⟳'),
            h('button', { type: 'button', className: 'wp-navbtn', disabled: !canType, title: dict.refresh, onClick: () => send({ type: 'play' }) }, '❐'),
          ),
        ),
        open === true
          ? h(
              'div',
              { className: 'wp-tools' },
              h('button', { type: 'button', className: 'wp-chip', disabled: !canType, title: dict.tab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }) }, '⇥ Tab'),
              h('button', { type: 'button', className: 'wp-chip', disabled: !canType, title: dict.shiftTab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }, ['shift']) }, '⇤ ⇧Tab'),
              h('button', { type: 'button', className: 'wp-chip', disabled: !canType, title: dict.enter, onClick: () => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }) }, '⏎ Enter'),
              h('span', { className: 'wp-tools-spacer' }),
              h('button', { type: 'button', className: 'wp-chip danger', disabled: busy, title: dict.closeTabTitle, onClick: () => void closeTab() }, dict.closeTab),
            )
          : null,
        takeover
          ? h(
              'div',
              { className: 'wp-banner' },
              h('strong', null, dict.humanTitle),
              h('span', { className: 'wp-banner-text' }, human.instruction),
              h('input', {
                className: 'wp-banner-input',
                value: reply,
                placeholder: dict.replyPlaceholder,
                onChange: (event) => setReply(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  submitReply()
                },
              }),
              h('button', { type: 'button', className: 'wp-chip', disabled: reply.trim() === '', onClick: submitReply }, dict.reply),
              h('button', { type: 'button', className: 'wp-chip danger', title: dict.humanHint, onClick: finishHuman }, dict.humanDone),
            )
          : null,
        h(
          'div',
          { className: 'wp-stage', ref: stageRef },
          open === true
            ? h('canvas', {
                ref: canvasRef,
                className: 'wp-frame',
                tabIndex: 0,
                'aria-label': title !== '' ? title : dict.title,
                onPointerDown,
                onPointerUp,
                onPointerMove,
                onFocus: () => sinkRef.current?.focus?.(),
              })
            : null,
          h('canvas', { ref: fxRef, className: 'wp-fx', 'aria-hidden': 'true' }),
          h('i', { className: 'wp-corner tl', 'aria-hidden': 'true' }),
          h('i', { className: 'wp-corner tr', 'aria-hidden': 'true' }),
          h('i', { className: 'wp-corner bl', 'aria-hidden': 'true' }),
          h('i', { className: 'wp-corner br', 'aria-hidden': 'true' }),
          h(
            'div',
            { className: 'wp-hud', 'aria-hidden': 'true' },
            logs.map((line) =>
              h(
                'div',
                { key: line.id, className: 'wp-hud-line', 'data-kind': line.kind },
                h('span', { className: 'wp-hud-time' }, line.t),
                h('span', { className: 'wp-hud-tag' }, line.tag),
                h('span', { className: 'wp-hud-msg' }, line.text),
              ),
            ),
          ),
          h(
            'div',
            { className: 'wp-hud-foot', 'aria-hidden': 'true' },
            h('div', { className: 'wp-hud-foot-line' }, modeLabel),
            h('div', { className: 'wp-hud-foot-line' }, sessionId !== '' ? `SID ${shortId(sessionId).toUpperCase()}` : 'NO SESSION'),
          ),
          hint !== '' ? h('div', { className: 'wp-hint' }, hint) : null,
          overlayNote !== ''
            ? h('div', { className: 'wp-overlay' }, h('div', { className: 'wp-overlay-note' }, overlayNote))
            : null,
          open === undefined
            ? h('div', { className: 'wp-overlay' }, h('div', { className: 'wp-overlay-note' }, dict.checking))
            : null,
          open === false
            ? h(
                'div',
                { className: 'wp-standby' },
                h('div', { className: 'wp-standby-mark' }, 'WEBPILOT ', h('em', null, 'STANDBY')),
                h('i', { className: 'wp-standby-line', 'aria-hidden': 'true' }),
                h('div', { className: 'wp-standby-sub' }, dict.standbySub),
                h('button', { type: 'button', className: 'wp-open', disabled: busy, onClick: () => void openBrowser() }, busy ? dict.starting : dict.open),
                failure !== undefined ? h('div', { className: 'wp-standby-error' }, `${dict.openFailed}：${failure}`) : null,
              )
            : null,
          open === true
            ? h('textarea', {
                ref: sinkRef,
                className: 'wp-sink',
                'aria-label': 'browser panel keyboard sink',
                onInput,
                onKeyDown,
                onKeyUp,
                onCompositionEnd,
                onPaste,
              })
            : null,
        ),
      )
    }

    /**
     * The tab chip: the glyph the type is recognised by, plus a dot while the
     * session it belongs to is waiting for a person.
     *
     * The chip is the discovery path for a request raised while the human is
     * looking at something else, so it polls on its own instead of reading the
     * body's state — a body is not even mounted while its tab is inactive.
     */
    function BrowserTabTitle(props) {
      const { dict, sessionId } = props
      const [waiting, setWaiting] = useState(false)
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const payload = await requestJson(SESSIONS_PATH)
            if (cancelled) return
            const pending = Array.isArray(payload?.pending) ? payload.pending : []
            setWaiting(pending.some((request) => request?.sessionId === sessionId))
          } catch {
            /* cosmetic badge: a failed poll keeps the last known value */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), TITLE_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId])
      return h(
        'span',
        { className: 'wp-tab-title' },
        h(BrowserIcon, { size: 14 }),
        h('span', { className: 'wp-tab-text' }, dict.title),
        waiting ? h('span', { className: 'wp-tab-dot', title: dict.pending }) : null,
      )
    }

    /** Guide-page glyph: the same mark, at the size that page asks for. */
    function GuideIcon(props) {
      return h(BrowserIcon, { size: props?.size ?? 16 })
    }

    /**
     * Open this plugin's tab by itself, the moment there is something to show.
     *
     * Nothing is pinned per session any more, so this watcher is the *only*
     * reason the tab appears. Two reasons count:
     *
     * - the session has a browser tab at all (the AI started driving one), once
     *   per stretch of "this session has a browser" — a human who closes the tab
     *   is obeyed until the browser itself comes back;
     * - a **new** hand-over request landed for this session, which reopens the
     *   tab even if the human closed it before: a request nobody can see is a
     *   request that hangs until it times out.
     *
     * It polls the **host-wide** state, because "does this session have a
     * browser" is exactly what a closed tab cannot tell us — but it only ever
     * acts on the session currently on screen. Opening into a session nobody is
     * looking at would move the Sidebar out from under whatever the human is
     * actually doing, and the chip's dot already covers discovery for the
     * sessions they switch to.
     *
     * @param ctx - client context; `sessions` and `sidebarRight` are optional.
     * @returns a disposer removing the poll and its subscription.
     */
    function watchSessions(ctx) {
      const sessions = ctx.get('sessions')
      const sidebar = ctx.get('sidebarRight')
      // `ctx.inject` already waited for both; these stay as the cheap guard for
      // a Sidebar build that provides the name without the Tab-domain method.
      if (sessions === undefined || sidebar === undefined) return () => {}
      if (typeof sidebar.openTabIn !== 'function') return () => {}
      const list = sessions.list
      if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return () => {}

      /** Sessions we already opened for the browser being present. */
      const openedForBrowser = new Set()
      /** Session → the hand-over request id we already opened for. */
      const openedForRequest = new Map()
      let disposed = false
      let timer
      /**
       * Columns the user collapsed by hand: the watcher leaves those alone for
       * the rest of the page's lifetime instead of fighting for the control.
       */
      const muted = new Set()
      /** Timers of the reveal ladder, cleared together with the watcher. */
      const timers = new Set()
      /** Unsubscribes the Sidebar's on-screen-session store, when it has one. */
      let unsubscribeMounted

      /**
       * The session currently on screen.
       *
       * `sessions.list` is a *list* projection (`ids`/`byId`/`phase`); it has no
       * `current` field, so reading `.current` from it always answered
       * `undefined` and this whole watcher used to be dead code (caught by the
       * e2e auto-reveal run). The Sidebar's own `mounted` snapshot is the
       * authority on what the human is looking at; the list field stays as a
       * fallback for builds that do project it.
       */
      const onScreenSessionId = () => {
        try {
          const mounted = sidebar.mounted
          if (mounted !== undefined && mounted !== null && typeof mounted.getSnapshot === 'function') {
            const id = mounted.getSnapshot()
            if (typeof id === 'string' && id !== '') return id
          }
        } catch {
          /* an unknown store shape is not an error */
        }
        try {
          const id = list.getSnapshot()?.current
          if (typeof id === 'string' && id !== '') return id
        } catch {
          /* same */
        }
        return undefined
      }

      const evaluate = async () => {
        if (disposed) return
        let payload
        try {
          payload = await requestJson(SESSIONS_PATH)
        } catch {
          return /* the GUI may be reloading; the next tick recovers */
        }
        if (disposed) return
        const current = onScreenSessionId()
        if (typeof current !== 'string' || current === '') return
        const rows = Array.isArray(payload?.sessions) ? payload.sessions : []
        const pending = Array.isArray(payload?.pending) ? payload.pending : []
        if (!rows.some((row) => row?.id === current)) {
          // The browser for this session is gone: forget it, so opening one
          // again later brings the tab back on its own.
          openedForBrowser.delete(current)
          openedForRequest.delete(current)
          return
        }
        const request = pending.find((entry) => entry?.sessionId === current)
        if (request !== undefined && openedForRequest.get(current) !== request.id) {
          openedForRequest.set(current, request.id)
          openedForBrowser.add(current)
          reveal(sidebar, current)
          return
        }
        if (openedForBrowser.has(current)) return
        openedForBrowser.add(current)
        reveal(sidebar, current)
      }

      const later = (ms, fn) => {
        const id = setTimeout(() => {
          timers.delete(id)
          if (!disposed) fn()
        }, ms)
        timers.add(id)
      }

      /** Read one session's tab records, when this build exposes them. */
      const tabsOf = (service, sessionId) => {
        try {
          if (typeof service.tabsIn !== 'function') return undefined
          const rows = service.tabsIn(sessionId)
          return Array.isArray(rows) ? rows : undefined
        } catch {
          return undefined
        }
      }

      const isBrowserTab = (row) =>
        row !== null &&
        row !== undefined &&
        (row.kind === TAB_KIND || row.type === TAB_KIND || row.id === TAB_ID)

      /** `undefined` means "this build does not say", never "no". */
      const tabPresent = (service, sessionId) => {
        const rows = tabsOf(service, sessionId)
        return rows === undefined ? undefined : rows.some(isBrowserTab)
      }

      const columnExpanded = (service) => {
        try {
          if (typeof service.isExpanded !== 'function') return undefined
          return service.isExpanded() === true
        } catch {
          return undefined
        }
      }

      /** Success test: the tab exists and the column is open (unknowns pass). */
      const revealSettled = (service, sessionId) =>
        tabPresent(service, sessionId) !== false && columnExpanded(service) !== false

      const openTabIn = (service, sessionId) => {
        try {
          service.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true })
          return true
        } catch (error) {
          console.warn('[dsh-webpilot] could not open the sidebar tab:', error)
          return false
        }
      }

      const openPublicTab = (service, sessionId) => {
        try {
          if (typeof service.openTab !== 'function') return false
          service.openTab(TAB_KIND, { params: { sessionId } })
          return true
        } catch (error) {
          console.warn('[dsh-webpilot] could not reveal the sidebar tab:', error)
          return false
        }
      }

      /** The built-in expand control, rendered only while the column is closed. */
      const clickExpandControl = () => {
        try {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
          const control = document.querySelector('[data-sidebar-right-expand]')
          if (control === null || typeof control.click !== 'function') return false
          control.click()
          return true
        } catch {
          return false
        }
      }

      /**
       * Put this session's browser tab on screen.
       *
       * A collapsed column is the failure this ladder exists for: the tab
       * record lands, but nothing draws it, so the guard has to cover the
       * column and not only the tab. Ask the plugin's own route first, press
       * the built-in expand control once when the column is closed, open again
       * after the column has had a frame to adopt the session, and only then
       * fall back to the public `openTab` on the mounted session. Every DOM
       * probe degrades to "not available" instead of throwing.
       */
      const reveal = (service, sessionId) => {
        if (disposed || muted.has(sessionId)) return
        openTabIn(service, sessionId)
        later(100, () => {
          if (muted.has(sessionId)) return
          if (revealSettled(service, sessionId)) return
          if (!clickExpandControl()) {
            openPublicTab(service, sessionId)
            return
          }
          later(150, () => {
            if (muted.has(sessionId)) return
            openTabIn(service, sessionId)
            later(180, () => {
              if (muted.has(sessionId)) return
              if (revealSettled(service, sessionId)) return
              openPublicTab(service, sessionId)
            })
          })
        })
      }

      const schedule = () => {
        if (disposed) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        clearTimeout(timer)
        timer = setTimeout(() => {
          void evaluate().finally(schedule)
        }, hidden ? REVEAL_IDLE_POLL_MS : REVEAL_POLL_MS)
      }

      /**
       * Wake the watcher now instead of waiting for the fallback timer.
       *
       * Coalesced through the same `timer` slot as `schedule`, so a burst of
       * state pushes produces one evaluation, not one per message.
       */
      const wake = () => {
        if (disposed) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          void evaluate().finally(schedule)
        }, 60)
      }

      const dispose = () => {
        if (disposed) return
        disposed = true
        clearTimeout(timer)
        for (const id of timers) clearTimeout(id)
        timers.clear()
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          try {
            document.removeEventListener('click', onDocumentClick, true)
          } catch {
            /* the document went away first */
          }
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          try {
            window.removeEventListener('webpilot:sessions', wake)
          } catch {
            /* the window went away first */
          }
        }
        unsubscribeMounted?.()
        unsubscribe?.()
      }

      /**
       * Remember a hand-collapse: once the user presses the Sidebar's own
       * toggle, the watcher stops fighting them for the rest of the page.
       */
      const rememberHandCollapse = () => {
        try {
          const current = onScreenSessionId()
          if (typeof current === 'string' && current !== '') muted.add(current)
        } catch {
          /* an unknown store shape is not an error */
        }
      }
      const onDocumentClick = (event) => {
        try {
          const target = event?.target
          if (target === null || target === undefined || typeof target.closest !== 'function') return
          if (target.closest('[data-sidebar-right-toggle]') !== null) rememberHandCollapse()
        } catch {
          /* a DOM shape we do not know is not an error */
        }
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        try {
          document.addEventListener('click', onDocumentClick, true)
        } catch {
          /* no document, no hand-collapse signal */
        }
      }

      // Pushed session state wakes the watcher (see `notifySessionsChanged`).
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        try {
          window.addEventListener('webpilot:sessions', wake)
        } catch {
          /* no window event bus: the fallback poll still runs */
        }
      }
      // The Sidebar's `mounted` store flips the moment the human switches
      // session, which is earlier than any poll could notice.
      try {
        const mounted = sidebar.mounted
        if (mounted !== undefined && mounted !== null && typeof mounted.subscribe === 'function') {
          unsubscribeMounted = mounted.subscribe(wake)
        }
      } catch {
        /* an unknown store shape is not an error */
      }

      const unsubscribe = list.subscribe(() => {
        // A new current session must be evaluated at once, not up to two
        // seconds later: that is exactly the moment its tab should appear.
        schedule()
      })
      void evaluate().finally(schedule)

      return () => {
        if (disposed) {
          unsubscribe()
          return
        }
        dispose()
      }
    }

    /**
     * Mount the surfaces: styles, the tab type, its two keyed seats, and the
     * watcher that opens the tab when there is something to show.
     *
     * @param ctx - the client context provided by the DSH web runtime.
     */
    function apply(ctx) {
      const dict = pickDict(typeof navigator !== 'undefined' ? navigator.language : 'en')

      // Styles: inserted once per plugin activation and removed with the fiber.
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-webpilot'
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(() => () => style.remove())

      // The tab type is two halves that must agree: a static definition in the
      // registry (what the type IS, and what `openTab` names) and a keyed slot
      // body under the very same id (what it looks like). A kind whose type
      // registered no body renders the owner's "nothing can view this" notice,
      // so both halves are installed together or not at all.
      //
      // **`ctx.get` is the wrong tool for a service that mounts later**, and on
      // the client half this plugin really is loaded before the Sidebar's
      // `provide()` runs even though the boot graph lists us last: reading it at
      // apply time came back `undefined` and the tab type was silently never
      // registered (found in the browser console, 2026-09-21). `ctx.inject`
      // waits for the declaration instead — the same rule the host half follows
      // for `webServer`/`connection`. A client without the Sidebar at all just
      // never runs these callbacks, which is the desired outcome: a browser-only
      // plugin must not take the workbench down with it.
      ctx.inject(['sidebarRightTabs'], (tabsCtx) =>
        tabsCtx.effect(
          () =>
            tabsCtx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => dict.title,
              guide: [
                {
                  order: 45,
                  title: () => dict.guideTitle,
                  description: () => dict.guideDescription,
                  icon: GuideIcon,
                },
              ],
            }),
          'webpilot: tab type',
        ),
      )

      // Slot declarations arrive with their owning plugin's fiber, which may
      // mount after this one: `slots.inject` waits for the declaration instead
      // of failing registration.
      const disposers = []
      const track = (dispose) => {
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      try {
        track(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, function Body(props) {
              const info = props.useTabInfo?.()
              return h(SessionPanel, { ...props, dict, visible: info?.tab?.visible !== false })
            }),
          ),
        )
        track(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, (props) =>
              h(BrowserTabTitle, { ...props, dict }),
            ),
          ),
        )
      } catch (error) {
        console.warn('[dsh-webpilot] slot registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      })

      // Same rule for the watcher: it drives `sidebarRight.openTabIn` and reads
      // the `sessions` list, so it waits for both rather than deciding from an
      // apply-time snapshot that they are missing.
      ctx.inject(['sessions', 'sidebarRight'], (watchCtx) =>
        watchCtx.effect(() => watchSessions(watchCtx), 'webpilot: tab reveal watcher'),
      )
    }

    /**
     * `__test` keeps the auto-open watcher reachable for `dev/harness.html`,
     * which drives the collapsed-column ladder with a fake Sidebar service.
     */
    const exports = { apply, inject: ['slots'], __test: { watchSessions } }
    return exports
  },
})
