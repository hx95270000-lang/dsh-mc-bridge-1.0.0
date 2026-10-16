/**
 * A session backed by a real Forge client.
 *
 * `MinecraftAgentSession` speaks the Minecraft protocol directly, which cannot
 * carry modded content: 1.20.1 never sends a block or item registry, so a
 * protocol client can only see numeric ids for anything a mod adds. This session
 * instead talks to the in-client control bridge, where every block and item is
 * addressed by its true registry name.
 *
 * It deliberately mirrors the surface the `mc_*` tools and the task/blueprint
 * layers already use, so switching backend does not change any of them.
 */

import { BridgeClient, BridgeError } from './bridge-client.js'
import { EventLog } from './log.js'
import { delay, plainText, pos, sameItem } from './text.js'

/**
 * A position value shaped like the one Mineflayer hands out.
 *
 * Tools and blueprints read `.x/.y/.z`, compare with `Math.floor`, and call
 * `floored()`/`offset()`, so the bridge session returns this instead of leaking
 * its own JSON shape.
 */
export class Vec3Like {
  /**
   * @param x - X coordinate.
   * @param y - Y coordinate.
   * @param z - Z coordinate.
   */
  constructor (x = 0, y = 0, z = 0) {
    this.x = Number(x) || 0
    this.y = Number(y) || 0
    this.z = Number(z) || 0
  }

  /** Integer copy of this position. */
  floored () {
    return new Vec3Like(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))
  }

  /**
   * A position offset by the given deltas.
   * @param dx - X delta.
   * @param dy - Y delta.
   * @param dz - Z delta.
   * @returns The offset position.
   */
  offset (dx, dy, dz) {
    return new Vec3Like(this.x + dx, this.y + dy, this.z + dz)
  }

  /**
   * Straight-line distance to another position.
   * @param other - The other position.
   * @returns The distance in blocks.
   */
  distanceTo (other) {
    if (!other) return Number.POSITIVE_INFINITY
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }

  /** Human-readable form. */
  toString () {
    return `${Math.floor(this.x)},${Math.floor(this.y)},${Math.floor(this.z)}`
  }
}

/** Item ids that are edible, used by `eat()` when the agent does not name food. */
const FOOD_HINT = /(bread|apple|carrot|potato|beef|porkchop|chicken|mutton|fish|cod|salmon|stew|soup|cookie|cake|melon|berry|banana|cheese|rice|noodle)/i

export class BridgeSession {
  /**
   * @param options - Session options.
   */
  constructor (options = {}) {
    /** @type {BridgeClient} */
    this.bridge = options.bridge ?? new BridgeClient({ host: options.host, port: options.port })
    /** @type {EventLog} */
    this.log = options.log ?? new EventLog(options.maxLogLines ?? 400)
    /** @type {'bridge'} */
    this.backend = 'bridge'
    /** @type {string} */
    this.username = options.username ?? 'the client'
    /** @type {string} */
    this.host = options.host ?? '127.0.0.1'
    /** @type {number|string} */
    this.port = options.port ?? 25577
    /** @type {'idle'|'connecting'|'online'|'ended'|'error'} */
    this.status = 'idle'
    /** @type {string|null} */
    this.reason = null
    /** @type {number|null} */
    this.connectedAt = null
    /** @type {Vec3Like|null} */
    this.origin = null
    /** @type {object|null} */
    this.lastObservation = null
    /** @type {number} Highest chat sequence already recorded. */
    this.chatCursor = 0
    /** @type {Set<Function>} */
    this.watchers = new Set()
    /** @type {NodeJS.Timeout|null} */
    this.chatTimer = null
    /** @type {Record<string, unknown>|null} */
    this.forgeReport = null
    /** @type {any} */
    this.bot = null
    /** @type {Map<string, { name: string, at: number, message: string, replied: boolean }>} */
    this.mentions = new Map()
    /** @type {Array<{ text: string, at: number }>} */
    this.sent = []
  }

  /**
   * Register a listener for notable events.
   * @param listener - Receives log entries.
   * @returns A disposer.
   */
  watch (listener) {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }

  /**
   * Record an event in the log and notify watchers.
   * @param kind - Event category.
   * @param text - Description.
   * @param from - Optional player name.
   */
  emitEvent (kind, text, from) {
    const entry = this.log.push(kind, text, from)
    for (const watcher of this.watchers) {
      try {
        watcher(entry)
      } catch {
        /* a failing observer must not break the session */
      }
    }
  }

  /** Whether the session is usable. */
  get online () {
    return this.status === 'online'
  }

  /**
   * Require a live bridge, or explain what to start and how.
   * @returns This session.
   */
  requireOnline () {
    if (this.status !== 'online') {
      throw new Error(
        `the Forge client bridge is not connected (status: ${this.status}${this.reason ? `, reason: ${this.reason}` : ''}). ` +
        'Start the headless client with the bridge mod installed, then call mc_join with backend=forge.'
      )
    }
    return this
  }

  /**
   * Attach to the bridge and verify the client is in a world.
   * @param signal - Optional cancellation signal.
   * @returns A summary of the connection.
   */
  async connect (signal) {
    this.status = 'connecting'
    this.reason = null
    try {
      const pong = await this.bridge.ping()
      // A client that has just started may still be sitting on Forge's mod
      // warning screen, where no world exists yet. Attaching is still useful
      // there: the agent can click the screen through and open a world itself.
      let observation = null
      try {
        observation = await this.bridge.observe({ radius: 1, vertical: 1, blockLimit: 1 })
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'not-in-world') throw error
      }
      this.status = 'online'
      this.connectedAt = Date.now()
      if (observation) {
        this.username = observation.username ?? observation.usernameHint ?? this.username
        this.origin = new Vec3Like(
          observation.position?.x ?? 0,
          observation.position?.y ?? 0,
          observation.position?.z ?? 0
        )
        this.lastObservation = observation
      }
      this.forgeReport = {
        transport: 'in-client Forge bridge',
        mod: pong.mod,
        note: 'Running inside the real Forge client, so every block and item is addressed by its true registry name, including content added by any installed mod.'
      }
      this.emitEvent('system', observation
        ? `attached to the Forge client bridge at ${this.bridge.host}:${this.bridge.port} ` +
          `(mod ${pong.mod}); observed world ${observation.dimension} at ${observation.position?.exactX},${observation.position?.exactY},${observation.position?.exactZ}`
        : `attached to the Forge client bridge at ${this.bridge.host}:${this.bridge.port} ` +
          `(mod ${pong.mod}); the client is not in a world yet`)
      this.#startChatPolling()
      return {
        ok: true,
        backend: 'forge',
        address: `${this.bridge.host}:${this.bridge.port}`,
        version: '1.20.1-forge-client',
        forge: this.forgeReport,
        inWorld: observation !== null
      }
    } catch (error) {
      this.status = 'error'
      this.reason = error instanceof Error ? error.message : String(error)
      this.emitEvent('error', `bridge attach failed: ${this.reason}`)
      throw error
    }
  }

  /**
   * What GUI the client currently shows.
   *
   * Works before a world is entered, which is where it is most useful: a client
   * stopped on Forge's mod warning screen waits for a click before it will load
   * anything.
   * @returns `{ open, title, type, isContainer }`.
   */
  async screen () {
    return await this.bridge.screen()
  }

  /**
   * Click a widget on whatever screen is open.
   * @param options - `text` matched against the label and translation key, or `index`.
   * @returns The click result, including the widgets the screen offered.
   */
  async clickScreen (options = {}) {
    return await this.bridge.screenClick({ text: options.text, index: options.index })
  }

  /**
   * Load a singleplayer world by folder name, exactly as the world list does.
   * @param world - Save folder name.
   * @returns The bridge's acknowledgement; entering the world is asynchronous.
   */
  async openWorld (world) {
    return await this.bridge.openWorld(String(world ?? '').trim())
  }

  /**
   * Poll the client's captured chat into this session's log.
   *
   * The bridge records chat passively, so polling with a cursor means no line is
   * lost while the agent is busy on a long task.
   */
  #startChatPolling () {
    const poll = async () => {
      if (this.status !== 'online') return
      try {
        const reply = await this.bridge.chatLog(this.chatCursor)
        for (const line of reply.lines ?? []) {
          if (typeof line.seq === 'number' && line.seq > this.chatCursor) this.chatCursor = line.seq
          const text = plainText(line.text)
          if (text.length === 0) continue
          this.emitEvent('chat', text)
          this.#trackMention(text)
        }
      } catch {
        /* a transient poll failure is not worth surfacing */
      }
    }
    this.chatTimer = setInterval(poll, 1000)
    if (typeof this.chatTimer.unref === 'function') this.chatTimer.unref()
  }

  /**
   * Note direct address of the bot in a chat line.
   * @param text - The chat text.
   */
  #trackMention (text) {
    const lower = text.toLowerCase()
    const names = [this.username, 'dshbot', 'bot'].filter(Boolean)
    if (!names.some(name => lower.includes(String(name).toLowerCase()))) return
    const from = text.match(/^<?([A-Za-z0-9_]{3,16})>?[\s:]/)?.[1] ?? 'unknown'
    this.mentions.set(from, { name: from, at: Date.now(), message: text, replied: false })
  }

  /**
   * Mark outstanding messages as handled.
   * @param names - Player names to clear; omit to clear all.
   */
  acknowledge (names) {
    if (!names || names.length === 0) {
      for (const entry of this.mentions.values()) entry.replied = true
      return
    }
    for (const name of names) {
      const entry = this.mentions.get(String(name))
      if (entry) entry.replied = true
      else this.mentions.set(String(name), { name: String(name), at: Date.now(), message: '', replied: true })
    }
  }

  /**
   * Send a chat line or a command.
   * @param text - Message or command.
   * @returns What was sent.
   */
  say (text) {
    this.requireOnline()
    const message = String(text ?? '').trim()
    if (message.length === 0) throw new Error('the message is empty')
    if (message.length > 256) throw new Error('Minecraft chat messages are limited to 256 characters')
    // Fire and forget: the tool layer reports the outcome, and awaiting here
    // would block the caller on a round trip for no extra information.
    this.bridge.chat(message).catch(error => {
      this.emitEvent('error', `failed to send "${message}": ${error instanceof Error ? error.message : error}`)
    })
    this.sent.push({ text: message, at: Date.now() })
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200)
    this.emitEvent('action', `bot said: ${message}`)
    return message
  }

  /**
   * Read the world snapshot, mapped to the shape the tools expect.
   * @param options - `radius`, `blockLimit`, `logLines`.
   * @returns A JSON-serialisable observation.
   */
  observe (options = {}) {
    const cached = this.lastObservation
    if (cached) {
      return {
        online: this.status === 'online',
        server: `${this.bridge.host}:${this.bridge.port} (in-client bridge)`,
        username: this.username,
        version: '1.20.1-forge-client',
        position: {
          x: cached.position?.x ?? 0,
          y: cached.position?.y ?? 0,
          z: cached.position?.z ?? 0,
          exact: `${cached.position?.x ?? 0},${cached.position?.y ?? 0},${cached.position?.z ?? 0}`
        },
        dimension: cached.dimension,
        gameMode: cached.gameMode,
        health: cached.health,
        food: cached.food,
        experienceLevel: cached.xpLevel,
        timeOfDay: cached.timeOfDay,
        isRaining: cached.raining,
        heldItem: cached.heldItem
          ? { name: cached.heldItem.item, count: cached.heldItem.count }
          : null,
        // The bridge reports these in its own shape; they are mapped to the one
        // the protocol session produces so the tools never branch on backend.
        players: (cached.players ?? []).map(entry => ({
          name: entry.name,
          distance: typeof entry.distance === 'number' ? entry.distance : null,
          position: typeof entry.position?.x === 'number'
            ? `${Math.floor(entry.position.x)},${Math.floor(entry.position.y)},${Math.floor(entry.position.z)}`
            : null
        })),
        entities: (cached.entities ?? []).map(entry => ({
          kind: entry.kind ?? 'entity',
          name: entry.username ?? entry.item ?? entry.name ?? 'unknown',
          distance: entry.distance ?? null,
          position: typeof entry.position?.x === 'number'
            ? `${Math.floor(entry.position.x)},${Math.floor(entry.position.y)},${Math.floor(entry.position.z)}`
            : null
        })),
        droppedItems: (cached.entities ?? [])
          .filter(entry => entry.kind === 'item')
          .map(entry => ({
            item: entry.item ?? 'item',
            count: entry.count ?? 1,
            distance: entry.distance ?? null,
            position: typeof entry.position?.x === 'number'
              ? `${Math.floor(entry.position.x)},${Math.floor(entry.position.y)},${Math.floor(entry.position.z)}`
              : null
          })),
        inventory: this.#inventoryFrom(cached.inventory),
        nearbyBlocks: (cached.blocks ?? []).map(block => ({ name: block.block, count: block.count })),
        recentEvents: this.log.tail(Number(options.logLines ?? 30))
      }
    }
    return {
      online: this.status === 'online',
      server: `${this.bridge.host}:${this.bridge.port} (in-client bridge)`,
      username: this.username,
      version: '1.20.1-forge-client',
      position: { x: 0, y: 0, z: 0, exact: '0,0,0' },
      dimension: 'unknown',
      gameMode: 'unknown',
      health: null,
      food: null,
      experienceLevel: null,
      timeOfDay: null,
      isRaining: null,
      heldItem: null,
      players: [],
      entities: [],
      droppedItems: [],
      inventory: { items: [], usedSlots: 0, totalSlots: 36, freeSlots: 36 },
      nearbyBlocks: [],
      recentEvents: this.log.tail(Number(options.logLines ?? 30))
    }
  }

  /**
   * Refresh `lastObservation` from the bridge. Called before reporting so the
   * snapshot is current rather than whatever was last seen.
   * @param options - `radius`, `vertical`, `blockLimit`.
   * @returns The raw bridge observation.
   */
  async refresh (options = {}) {
    this.requireOnline()
    const observation = await this.bridge.observe({
      radius: options.radius ?? 12,
      vertical: options.vertical ?? 6,
      blockLimit: options.blockLimit ?? 60
    })
    this.lastObservation = observation
    this.origin = new Vec3Like(observation.position?.x, observation.position?.y, observation.position?.z)
    return observation
  }

  /**
   * Map the bridge inventory shape onto the one the tools read.
   * @param inventory - Bridge inventory object.
   * @returns An inventory summary.
   */
  #inventoryFrom (inventory) {
    const totals = inventory?.totals ?? []
    return {
      items: totals.map(entry => ({ name: entry.item, count: entry.count })),
      usedSlots: inventory?.usedSlots ?? 0,
      totalSlots: inventory?.totalSlots ?? 36,
      freeSlots: Math.max(0, (inventory?.totalSlots ?? 36) - (inventory?.usedSlots ?? 0))
    }
  }

  /** Local inventory summary, refreshed from the bridge. */
  async inventorySummary () {
    const reply = await this.bridge.inventory()
    return this.#inventoryFrom(reply.inventory)
  }

  /**
   * Find blocks by registry name over the client's loaded chunks.
   * @param options - `name`, `names`, `radius`, `count`.
   * @returns `{ names, matches }` or `{ unknown, matches: [] }`.
   */
  async findBlocks (options = {}) {
    this.requireOnline()
    const names = options.names ?? (options.name ? [options.name] : [])
    if (names.length === 0) throw new Error('findBlocks requires `name` or `names`')
    const reply = await this.bridge.findBlock({
      blocks: names,
      radius: options.radius ?? 48,
      count: options.count ?? 32,
      vertical: options.vertical ?? 24
    })
    return {
      names,
      matches: (reply.matches ?? []).map(match => ({
        name: match.block,
        x: match.x,
        y: match.y,
        z: match.z
      }))
    }
  }

  /**
   * Resolve a block name against the client's registry.
   *
   * The bridge searches by name directly, so this only reports whether the name
   * looks usable; an unknown name simply finds nothing, which is itself accurate
   * because the client holds every mod's registry.
   * @param name - Block identifier.
   * @returns A minimal descriptor, or undefined for an empty name.
   */
  findBlockType (name) {
    const raw = String(name ?? '').trim().toLowerCase()
    if (raw.length === 0) return undefined
    // Namespaced names are authoritative; unqualified names are assumed vanilla.
    return { id: raw.includes(':') ? -1 : 0, name: raw, bridged: true }
  }

  /**
   * The registry name of the block at a position, or null when unloaded.
   *
   * Used by the build planner to skip positions that are already occupied; the
   * real client answers this exactly.
   * @param x - X coordinate.
   * @param y - Y coordinate.
   * @param z - Z coordinate.
   * @returns The block id, or null when the chunk is not loaded.
   */
  async blockNameAt (x, y, z) {
    try {
      const reply = await this.bridge.blockAt(Math.floor(x), Math.floor(y), Math.floor(z))
      return reply.block ?? null
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'not-loaded') return null
      throw error
    }
  }

  /** Count how many of an item the client is carrying. */
  async countItem (name) {
    const summary = await this.inventorySummary()
    return summary.items
      .filter(item => sameItem(item.name, name))
      .reduce((total, item) => total + item.count, 0)
  }

  /** Find an inventory item by name. */
  async findInventoryItem (name) {
    const reply = await this.bridge.inventory()
    const slots = reply.inventory?.slots ?? []
    if (!name) return slots[0] ?? null
    return slots.find(slot => sameItem(slot.item, name)) ?? null
  }

  /**
   * Locate a player by name in the client's world.
   * @param name - Player name.
   * @returns `{ x, y, z }`, or null when the player is not visible.
   */
  async findPlayerPosition (name) {
    this.requireOnline()
    const wanted = String(name ?? '').toLowerCase()
    if (wanted.length === 0) return null
    const reply = await this.bridge.nearby({ radius: 128, kind: 'player' })
    const match = (reply.entities ?? []).find(entity =>
      String(entity.username ?? entity.name ?? '').toLowerCase() === wanted)
    return match?.position ?? null
  }

  /**
   * Walk to a position by driving the client's own movement for a bounded time.
   * @param target - `{ x, y, z }`.
   * @param options - `range`, `timeoutMs`.
   * @returns A movement summary.
   */
  async goto (target, options = {}) {
    this.requireOnline()
    const range = Number(options.range ?? 1.5)
    const timeoutMs = Number(options.timeoutMs ?? 30000)
    const started = Date.now()
    const from = this.origin ? pos(this.origin) : 'unknown'
    await this.bridge.goto(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), {
      range,
      maxTicks: Math.max(20, Math.round(timeoutMs / 50))
    })

    // The bridge advances the walk on client ticks; poll until it settles.
    let status = null
    while (Date.now() - started < timeoutMs) {
      const reply = await this.bridge.walkStatus()
      status = reply.walk
      if (!status || status.done || reply.walking === false) break
      await delay(200)
    }
    const observation = await this.refresh({ radius: 1, vertical: 1, blockLimit: 1 })
    const now = new Vec3Like(observation.position?.x, observation.position?.y, observation.position?.z)
    const remaining = Math.hypot(now.x - target.x, now.y - target.y, now.z - target.z)
    return {
      reached: remaining <= range + 1,
      from,
      to: pos(target),
      ms: Date.now() - started,
      detail: status?.outcome
    }
  }

  /**
   * Break one block, letting the client complete the break.
   * @param point - `{ x, y, z }`.
   * @param options - `timeoutMs`.
   * @returns What was dug.
   */
  async digAt (point, options = {}) {
    this.requireOnline()
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    const reply = await this.bridge.dig(x, y, z)
    if (reply.broken) return { dug: true, name: reply.block, at: `${x},${y},${z}` }

    // Not broken in one tick: the client keeps going while we poll.
    const deadline = Date.now() + Number(options.timeoutMs ?? 15000)
    while (Date.now() < deadline) {
      await delay(120)
      const check = await this.bridge.dig(x, y, z).catch(error => {
        if (error instanceof BridgeError && error.code === 'nothing-there') return { broken: true }
        throw error
      })
      if (check.broken) return { dug: true, name: reply.block, at: `${x},${y},${z}` }
    }
    return { dug: false, reason: `${reply.block} at ${x},${y},${z} did not break within the time budget` }
  }

  /**
   * Break several blocks in order, reporting progress as each one finishes.
   * @param points - Positions to break.
   * @param options - `maxBlocks`, `timeoutMs`, `signal`, `onProgress`.
   * @returns `{ dug, failed, count }`.
   */
  async digMany (points, options = {}) {
    this.requireOnline()
    const limit = Math.max(1, Math.min(Number(options.maxBlocks ?? points.length), points.length))
    const dug = []
    const failed = []
    for (const point of points.slice(0, limit)) {
      if (options.signal?.aborted) break
      try {
        const result = await this.digAt(point, { timeoutMs: Number(options.timeoutMs ?? 15000) })
        if (result.dug) dug.push(result)
        else failed.push({ ...point, reason: result.reason })
      } catch (error) {
        failed.push({ ...point, reason: error instanceof Error ? error.message : String(error) })
      }
      if (typeof options.onProgress === 'function') options.onProgress(dug.length, failed.length)
    }
    return { dug, failed, count: dug.length }
  }

  /**
   * Place a block at a position.
   * @param point - `{ x, y, z }`.
   * @param itemName - Optional item to select first.
   * @returns The placement outcome.
   */
  async placeAt (point, itemName) {
    this.requireOnline()
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    if (itemName) {
      const slot = await this.#selectForItem(itemName)
      if (slot === null) return { placed: false, reason: `no "${itemName}" in the inventory to place` }
    }
    const reply = await this.bridge.place(x, y, z)
    return { placed: reply.placed === true, name: reply.block ?? itemName, at: `${x},${y},${z}` }
  }

  /**
   * Select a hotbar slot holding an item.
   * @param itemName - Item id to look for.
   * @returns The hotbar slot index, or null when absent.
   */
  async #selectForItem (itemName) {
    // The client moves the stack into the hotbar itself when it lives in the
    // main inventory, which is where collected blocks end up. A hotbar-only
    // search would report "cannot place" for anything the bot just gathered.
    try {
      const reply = await this.bridge.selectItem(String(itemName))
      return reply.slot ?? null
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'no-item') return null
      // An older bridge build has no `select_item` op: fall back to a hotbar scan.
      if (!(error instanceof BridgeError) || error.code !== 'unknown-op') throw error
    }
    const fallback = await this.bridge.inventory()
    const wanted = String(itemName).toLowerCase()
    const slot = (fallback.inventory?.slots ?? [])
      .filter(entry => entry.hotbar && entry.item.toLowerCase() === wanted)
      .sort((a, b) => b.count - a.count)[0]
    if (!slot) return null
    await this.bridge.selectSlot(slot.slot)
    return slot.slot
  }

  /**
   * Pick up dropped items by walking onto them.
   * @param options - `radius`.
   * @returns The number of item entities targeted.
   */
  async collectDrops (options = {}) {
    this.requireOnline()
    const reply = await this.bridge.nearby({ radius: options.radius ?? 8, kind: 'item' })
    let collected = 0
    for (const entity of (reply.entities ?? []).slice(0, 8)) {
      const position = entity.position
      if (!position) continue
      try {
        await this.goto(position, { range: 1, timeoutMs: 6000 })
        collected++
      } catch {
        /* keep trying the rest */
      }
    }
    return collected
  }

  /**
   * Drop items by id.
   * @param name - Item identifier.
   * @param count - How many to drop.
   * @returns What was dropped.
   */
  async dropItem (name, count) {
    this.requireOnline()
    const wanted = Math.max(1, Math.round(Number(count ?? 1)) || 1)
    const reply = await this.bridge.drop(String(name), wanted)
    if (reply.dropped === 0) throw new Error(`no "${name}" in the client's inventory`)
    return { dropped: reply.dropped, name: String(name) }
  }

  /**
   * Eat the best available food.
   *
   * Eating needs a held, edible item and a right-click held for the vanilla eat
   * duration; the bridge exposes raw interaction, so this selects the food and
   * reports honestly when the client cannot complete it.
   * @returns A description of what was eaten.
   */
  async eat () {
    this.requireOnline()
    const reply = await this.bridge.inventory()
    const food = (reply.inventory?.slots ?? [])
      .filter(entry => FOOD_HINT.test(entry.item))
      .sort((a, b) => b.count - a.count)[0]
    if (!food) throw new Error('the client has no food in its inventory')
    if (food.hotbar) await this.bridge.selectSlot(food.slot)
    else throw new Error(`${food.item} is not on the hotbar; move it there before eating`)
    throw new Error(
      `eating ${food.item} is not implemented in the bridge yet: it needs a sustained right-click. ` +
      'Ask for it explicitly if you need it.'
    )
  }

  /** Disconnect by closing the bridge socket; the game keeps running. */
  async disconnect (reason = 'dsh agent detaching') {
    if (this.chatTimer) {
      clearInterval(this.chatTimer)
      this.chatTimer = null
    }
    this.bridge.close()
    this.status = 'idle'
    this.connectedAt = null
    this.emitEvent('system', `detached from the Forge client bridge (${reason})`)
    return { disconnected: true, username: this.username, address: `${this.bridge.host}:${this.bridge.port}` }
  }

  /** A compact status line for tool output. */
  statusLine () {
    if (this.status === 'online' && this.lastObservation) {
      const position = this.lastObservation.position
      return `bridge online at ${this.bridge.host}:${this.bridge.port} inside the Forge client; ` +
        `${this.lastObservation.dimension} at ${position?.exactX},${position?.exactY},${position?.exactZ}, ` +
        `health ${this.lastObservation.health}`
    }
    return `bridge session ${this.status}${this.reason ? `: ${this.reason}` : ''}`
  }
}
