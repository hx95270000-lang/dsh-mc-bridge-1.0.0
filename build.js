/**
 * Blueprint placement.
 *
 * Turns a blueprint into real blocks in the world. Placement is deliberately
 * conservative: the plan is checked for materials before any block is touched,
 * blocks are placed bottom-up and nearest-first to limit walking, and every
 * individual failure is reported instead of aborting the whole build.
 */

import { bareId, delay, pos } from './text.js'

/** Reach at which a block can be placed without moving. */
const PLACE_REACH = 4

/**
 * Whether a block name means "empty space".
 *
 * The two backends disagree on spelling: a protocol client says `air`, the
 * Forge bridge says `minecraft:air`. Comparing the unqualified id keeps both
 * from treating an empty position as occupied.
 * @param name - Block name, or null for an unloaded position.
 * @returns True when the position can be built into.
 */
function isAir (name) {
  if (name === null || name === undefined) return true
  const bare = bareId(name)
  return bare === 'air' || bare === 'cave_air' || bare === 'void_air'
}

/**
 * Count the materials a blueprint needs, keyed by namespace-stripped name.
 * @param blueprint - The build plan.
 * @returns A map of block name to required count.
 */
export function requiredMaterials (blueprint) {
  const needs = new Map()
  for (const block of blueprint.blocks) {
    const key = String(block.block).replace(/^minecraft:/, '')
    needs.set(key, (needs.get(key) ?? 0) + 1)
  }
  return needs
}

/**
 * Compare the plan against the bot's inventory.
 *
 * Asynchronous because the Forge bridge answers inventory questions over its
 * socket rather than from a local cache.
 * @param session - Live session.
 * @param blueprint - The build plan.
 * @returns Which materials are present, short, or missing entirely.
 */
export async function checkMaterials (session, blueprint) {
  const needs = requiredMaterials(blueprint)
  const available = []
  const short = []
  for (const [name, count] of needs) {
    const have = await session.countItem(name)
    if (have === 0) short.push({ name, need: count, have: 0 })
    else if (have < count) short.push({ name, need: count, have })
    else available.push({ name, need: count, have })
  }
  return { needs: needs.size, available, short, complete: short.length === 0 }
}

/**
 * Place a blueprint into the world, offset from an origin position.
 * @param session - Live session.
 * @param blueprint - The build plan.
 * @param options - `origin`, `maxBlocks`, `replace`, `skipMissing`, `signal`, `onProgress`.
 * @returns A build report.
 */
export async function buildBlueprint (session, blueprint, options = {}) {
  session.requireOnline()
  const origin = options.origin ?? { x: 0, y: 0, z: 0 }
  const signal = options.signal
  const replace = options.replace === true
  const skipMissing = options.skipMissing === true
  const planned = []

  for (const block of blueprint.blocks) {
    if (signal?.aborted) break
    const target = {
      x: Math.round(origin.x + block.x),
      y: Math.round(origin.y + block.y),
      z: Math.round(origin.z + block.z)
    }
    // Asked through the session so both backends answer: the protocol client
    // from its own chunk cache, the Forge bridge from the real client.
    const existing = await session.blockNameAt(target.x, target.y, target.z)
    if (!isAir(existing) && !replace) continue
    planned.push({ ...block, target })
  }

  if (planned.length === 0) {
    return {
      placed: 0,
      skipped: blueprint.blocks.length,
      failed: [],
      origin: pos(origin),
      note: 'every planned position already held a block; pass replace=true to overwrite',
      materials: { needs: 0, available: [], short: [], complete: true }
    }
  }

  // Bottom-up, then outward from the origin: fewer long walks and a stable
  // surface for the next layer.
  planned.sort((a, b) => (a.target.y - b.target.y) ||
    (Math.abs(a.x) + Math.abs(a.z)) - (Math.abs(b.x) + Math.abs(b.z)))

  const limit = Math.max(1, Math.min(Number(options.maxBlocks ?? planned.length), planned.length))
  const attempts = planned.slice(0, limit)
  // Materials are checked against what this call will actually attempt: a plan
  // bigger than maxBlocks must not be refused over blocks it will not place.
  const materials = await checkMaterials(session, { ...blueprint, blocks: attempts })
  const placed = []
  const failed = []
  const consumed = new Map()
  let index = 0

  for (const entry of attempts) {
    if (signal?.aborted) break
    index++
    const destination = { x: entry.target.x, y: entry.target.y, z: entry.target.z }
    const existingName = await session.blockNameAt(destination.x, destination.y, destination.z)
    const occupied = !isAir(existingName)
    if (occupied && !replace) {
      placed.push({ name: existingName, at: pos(destination), note: 'already present' })
      continue
    }
    if (occupied && replace) {
      try {
        await session.digAt(entry.target, { timeoutMs: 15000 })
      } catch {
        /* the overwrite may fail; the placement attempt below reports it */
      }
    }

    const item = await session.findInventoryItem(entry.block)
    if (!item) {
      const reason = `no "${entry.block}" in the inventory`
      failed.push({ ...entry.target, name: entry.block, reason })
      if (!skipMissing) {
        // Keep going: other materials may still be placeable, and the report
        // lists every miss so the model can gather exactly what is missing.
        continue
      }
      continue
    }

    try {
      const here = session.origin ?? { x: destination.x, y: destination.y, z: destination.z }
      const distance = Math.hypot(here.x - destination.x, here.y - destination.y, here.z - destination.z)
      if (distance > PLACE_REACH) {
        await session.goto({ x: destination.x, y: destination.y, z: destination.z }, {
          range: PLACE_REACH - 1,
          timeoutMs: 20000,
          signal
        })
      }
      const result = await session.placeAt({ ...entry.target, timeoutMs: 8000 }, entry.block)
      if (result.placed) {
        placed.push({ name: result.name, at: result.at, planned: entry.block })
        consumed.set(entry.block, (consumed.get(entry.block) ?? 0) + 1)
      } else {
        failed.push({ ...entry.target, name: entry.block, reason: result.reason })
      }
    } catch (error) {
      failed.push({ ...entry.target, name: entry.block, reason: error instanceof Error ? error.message : String(error) })
    }

    if (typeof options.onProgress === 'function' && index % 5 === 0) {
      options.onProgress({ done: placed.length, failed: failed.length, total: limit })
    }
    if (options.pauseMs !== 0) await delay(Number(options.pauseMs ?? 60), signal)
  }

  const remaining = Math.max(0, planned.length - limit)
  const originText = pos(origin)
  const skippedCount = blueprint.blocks.length - planned.length
  return {
    placed: placed.length,
    failed,
    remaining,
    skipped: skippedCount,
    size: blueprint.size,
    origin: originText,
    materials,
    sample: placed.slice(0, 12),
    note: remaining > 0
      ? `stopped after ${limit} of ${planned.length} blocks; call mc_build again with the same origin to continue`
      : undefined
  }
}
