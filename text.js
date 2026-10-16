/**
 * Text and value helpers shared by every module of the Minecraft agent.
 *
 * Minecraft chat arrives as a rich JSON component tree; the model reads plain
 * text, so this module owns the single conversion path used everywhere.
 */

const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Convert any Minecraft chat component into a plain single-line string.
 * @param value - A component, a string, or anything that stringifies.
 * @returns Readable text with colour codes removed and whitespace collapsed.
 */
export function plainText (value) {
  if (value === undefined || value === null) return ''
  let raw
  if (typeof value === 'string') raw = value
  else if (typeof value.toString === 'function') {
    try {
      raw = value.toString()
    } catch {
      raw = String(value)
    }
  } else raw = String(value)
  return String(raw).replace(ANSI, '').replace(/§./g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Clamp a string to a maximum length, marking elision with an ellipsis.
 * @param text - Source text.
 * @param max - Maximum characters to keep.
 * @returns The original or truncated text.
 */
export function clamp (text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Format a block position as coordinates the model can reuse verbatim.
 * @param position - An object with `x`, `y`, `z` numbers.
 * @returns `x,y,z` with integers.
 */
export function pos (position) {
  if (!position) return 'unknown'
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

/**
 * Await a promise but give up after a timeout, without cancelling the work.
 * @param promise - The promise to observe.
 * @param ms - Milliseconds to wait.
 * @param label - Text used in the timeout error and the optional callback.
 * @param onTimeout - Invoked when the timeout wins.
 * @returns The promise result.
 */
export function withTimeout (promise, ms, label, onTimeout) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          if (onTimeout) onTimeout()
        } catch {
          /* the timeout must still reject */
        }
        reject(new Error(`${label} timed out after ${ms} ms`))
      }, ms)
    })
  ])
}

/**
 * Sleep for a number of milliseconds.
 * @param ms - Duration.
 * @returns A promise resolved after the delay.
 */
export function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Parse a comma-separated coordinate triple.
 * @param value - `"x,y,z"` or `[x, y, z]`.
 * @param label - Field name used in error messages.
 * @returns The parsed coordinates.
 */
export function parseCoords (value, label = 'position') {
  if (Array.isArray(value)) {
    if (value.length !== 3) throw new Error(`${label} needs exactly three numbers`)
    const parsed = value.map(Number)
    if (parsed.some(part => !Number.isFinite(part))) throw new Error(`${label} needs exactly three numbers`)
    return { x: parsed[0], y: parsed[1], z: parsed[2] }
  }
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error(`${label} is required`)
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) {
    throw new Error(`${label} must look like "x,y,z" (received "${text}")`)
  }
  return { x: parts[0], y: parts[1], z: parts[2] }
}

/**
 * Normalise a Minecraft identifier for comparison.
 *
 * Modded ids carry a namespace (`create:cogwheel`) while vanilla ones are often
 * written bare (`oak_planks`). Comparing the unqualified form lets a blueprint
 * that says `minecraft:oak_planks` match an inventory reporting `oak_planks`.
 * @param name - Any identifier.
 * @returns A lowercase, namespace-free id.
 */
export function bareId (name) {
  return String(name ?? '').trim().toLowerCase().replace(/^[^:]+:/, '')
}

/**
 * Whether two identifiers refer to the same content.
 * @param a - First identifier.
 * @param b - Second identifier.
 * @returns True when their unqualified ids match.
 */
export function sameItem (a, b) {
  const left = bareId(a)
  return left.length > 0 && left === bareId(b)
}

/**
 * Normalise a user-supplied Minecraft identifier.
 *
 * Modded installations name things `modid:path`, vanilla things `path`. The
 * agent should accept `Diamond_Pickaxe`, `minecraft:diamond_pickaxe`, and
 * `create:cogwheel` alike.
 * @param name - The raw identifier.
 * @returns A lowercase `namespace:path` identifier when a namespace is present.
 */
export function normalizeId (name) {
  const raw = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  if (raw.length === 0) return ''
  return raw.includes(':') ? raw : raw
}

/**
 * Build a fresh AbortController-linked sleep that also resolves on abort.
 * @param ms - Duration.
 * @param signal - Optional abort signal.
 * @returns A promise resolved after the delay or when aborted.
 */
export function delay (ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done () {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
