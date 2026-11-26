/**
 * The host half of the WebPilot effect layer.
 *
 * The panel is only a canvas mirror of one Chrome tab, so an agent action is
 * legible to a human only if the panel gets a moment to animate it before the
 * page actually changes. This module owns the pure part of that contract
 * (`docs/INTERFACE.md` §2): the fx vocabulary, the pacing policy, and the box
 * filtering used by the reading effect. `BrowserManager` owns the CDP dispatch
 * and calls in here; this file touches neither Chrome nor the panel.
 *
 * @module dsh-webpilot/fx
 */

/** Pacing used when the plugin config does not name one. */
export const DEFAULT_EFFECT_LEAD_MS = 260

/** Hard ceiling for one lead, so a bad config cannot wedge the agent. */
const MAX_EFFECT_LEAD_MS = 2_000

/** How long after the last action a session's effects are allowed to settle. */
export const EFFECT_IDLE_MS = 420

/** Visible text blocks a single reading effect may cover. */
export const MAX_READ_BLOCKS = 40

/** Element boxes a single reading effect may cover. */
const MAX_READ_ELEMENT_BOXES = 40

/** Every fx kind the host emits (`docs/INTERFACE.md` §2). */
export const FX_KINDS = Object.freeze(['click', 'drag', 'type', 'read', 'scroll', 'nav', 'key', 'idle'])

/** Whether this activation should emit fx events at all. */
export function effectsEnabled(config) {
  return config?.effects !== false
}

/**
 * How long the panel may animate before the real CDP action lands, in ms.
 *
 * Zero when effects are switched off, negative or absurd values included — a
 * misconfigured lead must degrade into "no animation", never into "the agent
 * hangs".
 */
export function effectLeadMs(config) {
  if (!effectsEnabled(config)) return 0
  const raw = Number(config?.effectLeadMs ?? DEFAULT_EFFECT_LEAD_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, MAX_EFFECT_LEAD_MS)
}

/** Clamp a page-space box to whole CSS pixels; `undefined` when unusable. */
export function normalizeBox(box) {
  if (box === null || typeof box !== 'object') return undefined
  const x = Number(box.x)
  const y = Number(box.y)
  const w = Number(box.w ?? box.width)
  const h = Number(box.h ?? box.height)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return undefined
  return { x: Math.round(x), y: Math.round(y), w: Math.max(0, Math.round(w)), h: Math.max(0, Math.round(h)) }
}

/** Whether a page-space box intersects the emulated viewport. */
export function onScreen(box, viewport) {
  if (box === undefined || viewport === undefined) return false
  const width = Number(viewport.width ?? 0)
  const height = Number(viewport.height ?? 0)
  return box.w > 0 && box.h > 0 && box.x + box.w > 0 && box.y + box.h > 0 && box.x < width && box.y < height
}

/**
 * Build the `boxes` payload of one reading effect.
 *
 * Element boxes come first (they are the things the model may act on next),
 * then visible text blocks. Both are limited and viewport-filtered so the panel
 * never scans something the human cannot see.
 *
 * @param input - snapshot elements, snapshot blocks, and the viewport size.
 * @returns boxes tagged `element` or `text`, ready for the `read` fx event.
 */
export function readBoxes({ elements = [], blocks = [], viewport } = {}) {
  const boxes = []
  for (const element of elements.slice(0, MAX_READ_ELEMENT_BOXES)) {
    const box = normalizeBox(element?.box)
    if (box === undefined || !onScreen(box, viewport)) continue
    boxes.push({ ...box, kind: 'element' })
  }
  for (const raw of blocks.slice(0, MAX_READ_BLOCKS)) {
    const box = normalizeBox(raw)
    if (box === undefined || !onScreen(box, viewport)) continue
    boxes.push({ ...box, kind: 'text' })
  }
  return boxes
}
