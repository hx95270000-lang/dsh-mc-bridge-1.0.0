/**
 * Long-running background tasks.
 *
 * Mining a stack of ore or walking a thousand blocks takes minutes, which is far
 * longer than one tool call should block. `TaskRunner` starts one task at a
 * time, keeps its progress queryable, and lets the model cancel it. The agent
 * can therefore keep talking to players while a task runs.
 */

import { delay, pos } from './text.js'

/** Radius used when hunting for a resource. */
const SEARCH_RADIUS = 48
/** How many times a task re-scans the area before declaring a resource absent. */
const MAX_RESCANS = 40

export class TaskRunner {
  /**
   * @param session - The owning session.
   */
  constructor (session) {
    this.session = session
    /** @type {object|null} Active task record. */
    this.current = null
    /** @type {number} Monotonic task id. */
    this.counter = 0
  }

  /** Whether a task is running. */
  get busy () {
    return this.current !== null && this.current.status === 'running'
  }

  /**
   * Start a task unless another one is already running.
   * @param kind - Task kind.
   * @param params - Task parameters.
   * @returns The task record.
   */
  start (kind, params) {
    if (this.busy) {
      throw new Error(
        `task "${this.current.kind}" is still running (${this.current.progress}). ` +
        'Wait for it with mc_task action=status, or cancel it with mc_task action=cancel.'
      )
    }
    const controller = new AbortController()
    const task = {
      id: ++this.counter,
      kind,
      params,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      progress: 'starting',
      result: null,
      error: null,
      cancel: () => controller.abort(),
      signal: controller.signal,
      events: []
    }
    this.current = task
    this.session.activeTask = task
    this.session.activeTaskLabel = kind
    const runner = TASKS[kind]
    if (!runner) {
      const error = new Error(`unknown task kind "${kind}". Available: ${Object.keys(TASKS).join(', ')}`)
      task.status = 'failed'
      task.error = error.message
      task.finishedAt = Date.now()
      this.session.activeTask = null
      throw error
    }
    task.promise = (async () => {
      try {
        task.result = await runner(this.session, params, task)
        task.status = task.signal.aborted ? 'cancelled' : 'done'
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error)
        task.status = task.signal.aborted ? 'cancelled' : 'failed'
      } finally {
        task.finishedAt = Date.now()
        task.progress = task.status
        this.session.activeTask = null
        this.session.activeTaskLabel = null
        this.session.emitEvent(
          task.status === 'done' ? 'action' : task.status === 'cancelled' ? 'system' : 'error',
          `task ${kind} ${task.status}${task.error ? `: ${task.error}` : ''} (${task.progress})`
        )
      }
      return task.result
    })()
    // A background task must never surface as an unhandled rejection.
    task.promise.catch(() => {})
    this.session.emitEvent('action', `task ${kind} started: ${describe(params)}`)
    return task
  }

  /**
   * Wait for the active task to settle.
   * @param timeoutMs - Maximum wait; 0 waits indefinitely.
   * @returns The settled task record or null.
   */
  async wait (timeoutMs = 0) {
    const task = this.current
    if (!task) return null
    if (timeoutMs <= 0) {
      await task.promise
      return task
    }
    await Promise.race([task.promise, delay(timeoutMs)])
    return task
  }

  /**
   * Cancel the active task.
   * @returns Whether something was cancelled.
   */
  cancel () {
    if (!this.current) return false
    this.current.cancel()
    return true
  }

  /**
   * Stop the active task and wait for it to actually settle.
   *
   * A cancelled task can take a while to unwind, because it may be in the middle
   * of a walk or a dig. Starting a new one the moment `cancel()` returns would
   * fail with "still running", so callers wait here first.
   * @param timeoutMs - How long to wait for the task to finish.
   * @returns The settled task, or null when nothing was running.
   */
  async replace (timeoutMs = 20000) {
    const task = this.current
    if (!task) return null
    if (task.status === 'running') {
      task.cancel()
      await this.wait(timeoutMs)
    }
    return task
  }

  /**
   * A serialisable status view.
   * @returns Task status, or null when idle.
   */
  status () {
    const task = this.current
    if (!task) return null
    return {
      id: task.id,
      kind: task.kind,
      params: task.params,
      status: task.status,
      progress: task.progress,
      elapsedMs: (task.finishedAt ?? Date.now()) - task.startedAt,
      error: task.error,
      events: task.events.slice(-20),
      result: task.status === 'running' ? undefined : task.result
    }
  }
}

/**
 * Render task parameters compactly for logs.
 * @param params - Task parameters.
 * @returns A short description.
 */
function describe (params) {
  if (!params) return ''
  const parts = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || key === 'signal') continue
    parts.push(`${key}=${Array.isArray(value) ? value.join('+') : value}`)
  }
  return parts.join(' ')
}

/**
 * Record progress on the task and in the shared log.
 * @param task - Task record.
 * @param text - Progress text.
 */
function progress (task, text) {
  task.progress = text
  task.events.push({ at: Date.now(), text })
  if (task.events.length > 60) task.events.splice(0, task.events.length - 60)
}

/**
 * Pick up whatever dropped near the bot after a dig.
 * @param session - Live session.
 * @param before - Inventory counts captured before digging.
 * @param options - `timeoutMs`.
 * @returns The number of items gained.
 */
async function pickup (session, before, options = {}) {
  // Both backends implement `collectDrops`: the protocol client steers itself to
  // each item entity, while the bridge walks the real client onto them. Nothing
  // here may assume a Mineflayer bot exists.
  try {
    await session.collectDrops({
      radius: 8,
      timeoutMs: Number(options.timeoutMs ?? 4000),
      signal: options.signal
    })
  } catch {
    /* picking up is best effort; the inventory delta below is the answer */
  }
  let gained = 0
  const after = await inventoryCounts(session)
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0)
    if (delta > 0) gained += delta
  }
  return gained
}

/**
 * Snapshot inventory counts through the session, whatever the backend.
 *
 * The protocol session answers synchronously and the bridge answers over the
 * socket, so this is always awaited and both shapes normalise to a map.
 * @param session - Live session.
 * @returns A map of item name to count.
 */
async function inventoryCounts (session) {
  const summary = await session.inventorySummary()
  const counts = new Map()
  for (const item of summary?.items ?? []) {
    if (!item?.name) continue
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }
  return counts
}

/**
 * The bot's current position, from whichever backend tracks it.
 * @param session - Live session.
 * @returns `{ x, y, z }`, or null when the position is unknown.
 */
function currentPosition (session) {
  const origin = session.origin
  if (origin) return { x: origin.x, y: origin.y, z: origin.z }
  const position = session.bot?.entity?.position
  return position ? { x: position.x, y: position.y, z: position.z } : null
}

/**
 * Find blocks by numeric registry id.
 *
 * Used for content that has no name in the vanilla registry but does have a
 * state id, which is how modded blocks and mapped modded content appear.
 * @param session - Live session.
 * @param ids - Numeric block type ids.
 * @param radius - Search radius.
 * @param count - Maximum matches.
 * @returns Matches shaped like `findBlocks` output.
 */
function findByIds (session, ids, radius, count) {
  const bot = session.bot
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count, point: bot.entity.position })
  const matches = []
  for (const point of found) {
    const block = bot.blockAt(point)
    if (!block || block.name === 'air') continue
    matches.push({ name: block.name, x: block.position.x, y: block.position.y, z: block.position.z })
  }
  return matches
}

/**
 * Harvest one resource until the requested amount is in the inventory.
 * @param session - Live session.
 * @param params - `block`, `count`, `radius`, `maxDigs`, `resolve` (name resolver).
 * @param task - Task record.
 * @returns A harvest report.
 */
async function taskCollect (session, params, task) {
  const blockName = String(params.block ?? params.name ?? '').trim()
  if (blockName.length === 0) throw new Error('collect needs a `block` name')
  const wanted = Math.max(1, Math.round(Number(params.count ?? 1)))
  const radius = Math.min(Math.max(8, Number(params.radius ?? SEARCH_RADIUS)), 96)
  const maxDigs = Math.max(wanted, Math.round(Number(params.maxDigs ?? wanted * 4 + 16)))
  const resolved = typeof params.resolve === 'function'
    ? params.resolve(blockName)
    : (() => {
        const type = session.findBlockType(blockName)
        return type ? { id: type.id, name: type.name, source: 'registry' } : undefined
      })()
  if (!resolved) {
    throw new Error(`"${blockName}" is not a known block for version ${session.version}. ` +
      'The vanilla registry has no such block; if it is modded, teach the agent the id with ' +
      'mc_control action=load_registry and retry. ' +
      'Use mc_inventory or mc_observe to see what the server actually reports.')
  }
  const countName = resolved.source === 'registry' ? blockName : blockName
  const startCount = await session.countItem(countName)
  if (resolved.source === 'registry' && startCount >= wanted) {
    return { block: blockName, target: wanted, collected: 0, have: startCount, note: 'already satisfied' }
  }
  let digs = 0
  let scans = 0
  const currentCount = async () => (resolved.source === 'registry' ? await session.countItem(countName) : digs)
  while (await currentCount() < wanted && digs < maxDigs && scans < MAX_RESCANS) {
    if (task.signal.aborted) break
    scans++
    // `findBlocks` is synchronous on the protocol backend and a socket
    // round-trip on the bridge, so it is always awaited and both result shapes
    // normalise to a list of matches.
    let matches
    if (resolved.source === 'registry') {
      const found = await session.findBlocks({ name: blockName, radius, count: 64 })
      matches = Array.isArray(found) ? found : found.matches
    } else {
      matches = findByIds(session, [resolved.id], radius, 64)
    }
    if (matches.length === 0) {
      if (params.wander !== false && scans < MAX_RESCANS) {
        progress(task, `no ${blockName} within ${radius} blocks; wandering (scan ${scans})`)
        await wander(session, task)
        continue
      }
      break
    }
    for (const match of matches) {
      if (await currentCount() >= wanted || digs >= maxDigs || task.signal.aborted) break
      const before = await inventoryCounts(session)
      try {
        await session.goto(match, { range: 3, timeoutMs: 20000, signal: task.signal })
        const dug = await session.digAt(match, { timeoutMs: 20000 })
        if (!dug.dug) {
          progress(task, `could not break ${dug.reason ?? blockName}`)
          continue
        }
        digs++
        await pickup(session, before, { signal: task.signal })
        progress(task, `${blockName} ${await currentCount()}/${wanted} (dug ${digs})`)
      } catch (error) {
        progress(task, `skip ${pos(match)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const have = await currentCount()
  return {
    block: blockName,
    target: wanted,
    have,
    collected: Math.max(0, have - startCount),
    dugBlocks: digs,
    scans,
    satisfied: have >= wanted,
    note: have >= wanted
      ? undefined
      : `stopped early: ${have}/${wanted}. The block may be outside loaded chunks, protected by the server, ` +
        'mapped by state id rather than by item (so the count tracks blocks dug), or require a tool the bot lacks.'
  }
}

/**
 * Walk a short distance in a semi-random direction to reveal new chunks.
 * @param session - Live session.
 * @param task - Task record.
 */
async function wander (session, task) {
  const from = currentPosition(session)
  if (!from) return
  const angle = Math.random() * Math.PI * 2
  const distance = 24 + Math.random() * 24
  const target = {
    x: Math.floor(from.x + Math.cos(angle) * distance),
    y: Math.floor(from.y),
    z: Math.floor(from.z + Math.sin(angle) * distance)
  }
  try {
    await session.goto(target, { range: 4, timeoutMs: 25000, signal: task.signal })
  } catch {
    /* wandering is opportunistic */
  }
}

/**
 * Break every matching block in reach without caring about the drops.
 * @param session - Live session.
 * @param params - `block`, `count`, `radius`.
 * @param task - Task record.
 * @returns A mining report.
 */
async function taskMine (session, params, task) {
  const blockName = String(params.block ?? params.name ?? '').trim()
  const wanted = Math.max(1, Math.round(Number(params.count ?? 1)))
  const radius = Math.min(Math.max(8, Number(params.radius ?? SEARCH_RADIUS)), 96)
  if (blockName.length === 0) throw new Error('mine needs a `block` name')
  const type = session.findBlockType(blockName)
  if (!type) throw new Error(`"${blockName}" is not a known block for version ${session.version}`)
  const found = await session.findBlocks({ name: blockName, radius, count: Math.min(512, wanted * 4) })
  const matches = (Array.isArray(found) ? found : found.matches).slice(0, wanted)
  if (matches.length === 0) {
    const from = currentPosition(session)
    return {
      block: blockName,
      mined: 0,
      note: `no ${blockName} within ${radius} blocks of ${from ? pos(from) : 'the player'}`
    }
  }
  const result = await session.digMany(matches, {
    maxBlocks: wanted,
    signal: task.signal,
    onProgress: (dug, failed) => progress(task, `${blockName} ${dug}/${wanted} dug, ${failed} failed`)
  })
  return {
    block: blockName,
    mined: result.count,
    failed: result.failed.slice(0, 10),
    failedCount: result.failed.length
  }
}

/**
 * Continuously follow a player.
 * @param session - Live session.
 * @param params - `player`, `distance`, `durationMs`.
 * @param task - Task record.
 * @returns A follow report.
 */
async function taskFollow (session, params, task) {
  const name = String(params.player ?? '').trim()
  if (name.length === 0) throw new Error('follow needs a `player` name')
  const distance = Math.max(1, Number(params.distance ?? 3))
  const durationMs = Math.max(1000, Number(params.durationMs ?? 120000))
  const deadline = Date.now() + durationMs
  let ticks = 0
  while (Date.now() < deadline && !task.signal.aborted) {
    // The bridge answers with a position instead of exposing entities, so the
    // lookup goes through the session rather than through a Mineflayer bot.
    const target = await session.findPlayerPosition(name)
    if (!target) {
      progress(task, `${name} is not visible; waiting`)
      await delay(1000, task.signal)
      continue
    }
    ticks++
    try {
      await session.goto(target, { range: distance, timeoutMs: 8000, signal: task.signal })
      progress(task, `following ${name} at ${pos(target)} (tick ${ticks})`)
    } catch {
      /* retry on the next tick */
    }
    await delay(300, task.signal)
  }
  return { player: name, ticks, stopped: task.signal.aborted ? 'cancelled' : 'duration elapsed' }
}

/**
 * Walk to a fixed destination as a background task.
 * @param session - Live session.
 * @param params - `x`, `y`, `z`, `range`.
 * @param task - Task record.
 * @returns A movement report.
 */
async function taskGoto (session, params, task) {
  const target = { x: Number(params.x), y: Number(params.y), z: Number(params.z) }
  if (![target.x, target.y, target.z].every(Number.isFinite)) {
    throw new Error('goto needs numeric x, y, and z')
  }
  progress(task, `walking to ${pos(target)}`)
  const result = await session.goto(target, {
    range: Number(params.range ?? 1),
    timeoutMs: Number(params.timeoutMs ?? 120000),
    signal: task.signal
  })
  return { ...result, reached: result.reached }
}

/**
 * Put a named item into a nearby container.
 * @param session - Live session.
 * @param params - `item`, `count`.
 * @param task - Task record.
 * @returns A deposit report.
 */
async function taskDeposit (session, params, task) {
  if (!session.bot?.registry) {
    throw new Error(
      'putting items into containers is only implemented for the protocol backend so far: ' +
      'the bridge interacts with single blocks and does not open container screens yet'
    )
  }
  const itemName = String(params.item ?? '').trim()
  const count = Math.max(1, Math.round(Number(params.count ?? 0)) || Number.MAX_SAFE_INTEGER)
  const bot = session.bot
  const chestIds = ['chest', 'trapped_chest', 'barrel']
    .map(name => session.findBlockType(name)?.id)
    .filter(id => id !== undefined)
  if (chestIds.length === 0) throw new Error('this version has no chest registry entry')
  const nearby = bot.findBlocks({ matching: chestIds, maxDistance: 32, count: 8 })
  if (nearby.length === 0) return { deposited: 0, note: 'no chest, trapped chest, or barrel within 32 blocks' }
  const chestBlock = bot.blockAt(nearby[0])
  progress(task, `using ${chestBlock.name} at ${pos(chestBlock.position)}`)
  await session.goto(chestBlock.position, { range: 3, timeoutMs: 20000, signal: task.signal })
  const container = await bot.openContainer(chestBlock)
  try {
    const items = container.containerItems()
    const existing = itemName.length === 0 ? null : session.findInventoryItem(itemName)
    if (itemName.length > 0 && !existing) {
      return { deposited: 0, note: `no "${itemName}" in the inventory`, container: chestBlock.name }
    }
    let moved = 0
    if (existing) {
      await container.deposit(existing.type, null, Math.min(count, existing.count))
      moved = Math.min(count, existing.count)
    } else {
      for (const item of bot.inventory.items()) {
        if (!item) continue
        await container.deposit(item.type, null, item.count)
        moved += item.count
      }
    }
    return {
      deposited: moved,
      container: chestBlock.name,
      at: pos(chestBlock.position),
      containerItemCount: items.length
    }
  } finally {
    try {
      container.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Craft an item from the inventory using a nearby crafting table when needed.
 * @param session - Live session.
 * @param params - `item`, `count`.
 * @param task - Task record.
 * @returns A crafting report.
 */
async function taskCraft (session, params, task) {
  if (!session.bot?.registry) {
    throw new Error(
      'crafting is only implemented for the protocol backend so far: the bridge does not open the crafting GUI yet'
    )
  }
  const itemName = String(params.item ?? '').trim()
  if (itemName.length === 0) throw new Error('craft needs an `item` name')
  const count = Math.max(1, Math.round(Number(params.count ?? 1)))
  const bot = session.bot
  const item = bot.registry.itemsByName[itemName] ??
    bot.registry.itemsByName[itemName.replace(/^minecraft:/, '')]
  if (!item) throw new Error(`"${itemName}" is not a known item for version ${session.version}`)
  let recipes = bot.recipesFor(item.id, null, count, null)
  if (recipes.length === 0) {
    const tableId = session.findBlockType('crafting_table')?.id
    const tables = tableId === undefined ? [] : bot.findBlocks({ matching: [tableId], maxDistance: 32, count: 1 })
    if (tables.length > 0) {
      const tableBlock = bot.blockAt(tables[0])
      await session.goto(tableBlock.position, { range: 3, timeoutMs: 20000, signal: task.signal })
      recipes = bot.recipesFor(item.id, null, count, tableBlock)
      if (recipes.length === 0) {
        return { crafted: 0, note: `no recipe makes ${itemName}${count > 1 ? ` x${count}` : ''} from the current inventory` }
      }
      progress(task, `crafting at ${pos(tableBlock.position)}`)
      await bot.craft(recipes[0], count, tableBlock)
      return { crafted: count, item: item.name, station: tableBlock.name }
    }
    return { crafted: 0, note: `no recipe makes ${itemName} from the current inventory, and no crafting table is within 32 blocks` }
  }
  progress(task, 'crafting in the inventory grid')
  await bot.craft(recipes[0], count, null)
  return { crafted: count, item: item.name, station: 'inventory' }
}

/** Registry of runnable task kinds. */
const TASKS = {
  collect: taskCollect,
  mine: taskMine,
  follow: taskFollow,
  goto: taskGoto,
  deposit: taskDeposit,
  craft: taskCraft
}

/** Names of the supported task kinds, for tool descriptions. */
export const TASK_KINDS = Object.keys(TASKS)
