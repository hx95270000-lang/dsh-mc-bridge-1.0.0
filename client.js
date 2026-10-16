/**
 * The Minecraft client: one headless bot session driven through Mineflayer.
 *
 * This module owns the connection lifecycle, the world/inventory snapshot the
 * model reads, and every primitive action (walk, dig, place, chat). Higher
 * layers - tasks and blueprints - compose these primitives.
 *
 * Design notes:
 * - Mineflayer is CommonJS, so it is loaded through `createRequire`.
 * - A single pinned `mineflayer-pathfinder` copy is shared by direct movement
 *   and block collection, which avoids the instance-identity traps that appear
 *   when nested copies of the pathfinder coexist.
 * - Every awaited operation is bounded, because a bot standing in unloaded
 *   terrain can otherwise wait forever.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { EventLog } from './log.js'
import { clamp, delay, plainText, pos, withTimeout } from './text.js'

const require = createRequire(import.meta.url)

/** Default bound for a single awaited movement or interaction. */
const DEFAULT_TIMEOUT_MS = 30000
/** Ceiling for a single movement attempt before a task retries or gives up. */
const GOTO_TIMEOUT_MS = 60000
/** Radius used when scanning for nearby blocks. */
const SCAN_RADIUS = 24

/**
 * Import a package that may only be reachable through a nested dependency.
 *
 * pnpm keeps transitive dependencies out of the top level, so a package that is
 * genuinely installed (for example under `mineflayer/node_modules`) still fails
 * a bare specifier. Each fallback is tried in order and the first success wins.
 * @param specifier - Bare module specifier.
 * @param bases - Extra `createRequire` bases to search, relative to this file.
 * @returns The module namespace.
 */
async function loadDependency (specifier, bases = []) {
  const attempts = []
  attempts.push(() => import(specifier))
  for (const base of bases) {
    attempts.push(async () => {
      const resolver = createRequire(new URL(base, import.meta.url))
      return import(pathToFileURL(resolver.resolve(specifier)).href)
    })
  }
  let lastError
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`cannot load "${specifier}": ${lastError?.message ?? 'unknown error'}`)
}

/** Cached Mineflayer module namespace. */
let mineflayerModule
/** Cached pathfinder module namespace. */
let pathfinderModule
/** Cached `vec3` constructors. */
let vec3Module

/**
 * Load and cache Mineflayer.
 * @returns The Mineflayer module namespace.
 */
async function mineflayer () {
  mineflayerModule ??= await loadDependency('mineflayer')
  return mineflayerModule
}

/**
 * Load and cache `mineflayer-pathfinder` from whichever copy is installed.
 * @returns The pathfinder module namespace.
 */
async function pathfinder () {
  pathfinderModule ??= await loadDependency('mineflayer-pathfinder', [
    './node_modules/mineflayer-collectblock/',
    './node_modules/mineflayer/'
  ])
  return pathfinderModule
}

/**
 * Load and cache `vec3`.
 * @returns The `vec3` module namespace exposing `Vec3`.
 */
async function vector () {
  vec3Module ??= await loadDependency('vec3', [
    './node_modules/mineflayer/',
    './node_modules/mineflayer-pathfinder/'
  ])
  return vec3Module
}

/** Cached `prismarine-chat` factory. */
let chatFactoryModule

/**
 * Load and cache the `prismarine-chat` factory and bind it to a registry.
 *
 * Called lazily so connecting never depends on chat decoding being available.
 * @param registry - A Mineflayer registry, used to pick the chat format.
 * @returns A component constructor, or null when unavailable.
 */
async function chatMessageFactory (registry) {
  try {
    chatFactoryModule ??= await loadDependency('prismarine-chat', ['./node_modules/mineflayer/'])
  } catch {
    return null
  }
  const factory = chatFactoryModule.default ?? chatFactoryModule
  return typeof factory === 'function' ? factory(registry) : null
}

/** Entity kinds that are worth surfacing to the model. */
const INTERESTING_ENTITY = new Set(['player', 'mob', 'hostile', 'animal', 'object', 'vehicle'])

export class MinecraftAgentSession {
  /**
   * @param options - Session configuration.
   */
  constructor (options = {}) {
    /** @type {string} Address the session should connect to. */
    this.address = String(options.address ?? '').trim()
    /** @type {number} TCP port. */
    this.port = Number(options.port ?? 25565)
    /** @type {string} In-game name. */
    this.username = String(options.username ?? 'DSH_Agent')
    /** @type {string} Version string handed to Mineflayer. */
    this.version = String(options.version ?? '1.20.1')
    /** @type {string} `offline` or `microsoft`. */
    this.auth = options.auth === 'microsoft' ? 'microsoft' : 'offline'
    /** @type {boolean} Attempt the Forge negotiation layer on connect. */
    this.forge = options.forge !== false
    /** @type {string} Shared secret for offline/online-mode bridging servers. */
    this.accessToken = options.accessToken
    /** @type {EventLog} */
    this.log = options.log ?? new EventLog(options.maxLogLines ?? 400)
    /** @type {string|null} Free-form reconnect command for the model to suggest. */
    this.suggestion = null
    /** @type {object|null} */
    this.bot = null
    /** @type {'idle'|'connecting'|'online'|'ended'|'error'} */
    this.status = 'idle'
    /** @type {string|null} Why the session ended, when it did. */
    this.reason = null
    /** @type {number|null} */
    this.connectedAt = null
    /** @type {Promise<void>|null} In-flight connect promise. */
    this.connectPromise = null
    /** @type {Promise<unknown>|null} Currently running long task. */
    this.activeTask = null
    /** @type {string|null} Label of the running task. */
    this.activeTaskLabel = null
    /** @type {Record<string, unknown>|null} Last Forge negotiation report. */
    this.forgeReport = null
    /** @type {Map<string, { name: string, at: number, message: string, replied: boolean }>} */
    this.mentions = new Map()
    /** @type {Array<{ text: string, at: number }>} Outbound chat history. */
    this.sent = []
    /** @type {Set<Function>} Listeners for notable events. */
    this.watchers = new Set()
    /** @type {new (x: number, y: number, z: number) => any|null} Cached Vec3 constructor. */
    this.Vec3 = null
    /** @type {Function|null} Cached chat component constructor bound to the registry. */
    this.ChatMessage = null
    /** @type {{ text: string, at: number }|null} Last recorded chat line, for dedupe. */
    this.lastChat = null
  }

  /**
   * Register a listener called on every notable event.
   * @param listener - Receives `{ kind, text, from }`.
   * @returns A disposer removing the listener.
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
        /* a failing observer must not break the bot */
      }
    }
  }

  /** Whether the bot is spawned into a world and ready for actions. */
  get online () {
    return this.status === 'online' && this.bot?.entity !== undefined && this.bot?.entity !== null
  }

  /**
   * Require an online bot or explain precisely why the action cannot run.
   * @returns The live Mineflayer bot.
   */
  requireOnline () {
    if (!this.bot || this.status === 'ended' || this.status === 'error') {
      throw new Error(
        `not connected to a Minecraft server (status: ${this.status}${this.reason ? `, reason: ${this.reason}` : ''}). ` +
        'Call mc_join first.'
      )
    }
    if (!this.online) {
      throw new Error(`the bot is connected but has no spawned entity yet (status: ${this.status}). Wait a moment and retry mc_observe.`)
    }
    return this.bot
  }

  /**
   * Connect to the server and resolve once the bot has spawned.
   * @param signal - Optional cancellation signal.
   * @returns A summary of the connection outcome.
   */
  async connect (signal) {
    if (this.online) {
      throw new Error(`already connected to ${this.address}:${this.port} as ${this.bot.username}. Call mc_leave first to reconnect elsewhere.`)
    }
    if (this.connectPromise) return this.connectPromise
    if (this.bot) await this.disconnect('reconnecting')
    if (!this.address) throw new Error('a server address is required')

    this.status = 'connecting'
    this.reason = null
    this.connectPromise = this.#spawn(signal)
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  /**
   * Create the Mineflayer bot and wait for spawn, kick, or error.
   * @param signal - Optional cancellation signal.
   * @returns A summary of the connection outcome.
   */
  async #spawn (signal) {
    const createBot = (await mineflayer()).createBot
    this.Vec3 = (await vector()).Vec3
    const auth = this.auth === 'microsoft' ? 'microsoft' : 'offline'
    const bot = createBot({
      host: this.address,
      port: this.port,
      username: this.username,
      auth,
      version: this.version,
      ...(auth === 'offline' && this.accessToken ? { accessToken: this.accessToken } : {}),
      hideErrors: true,
      checkTimeoutInterval: 60000,
      viewDistance: 'normal',
      brand: 'dsh-agent'
    })
    this.bot = bot
    this.#attachListeners(bot)

    const settled = new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup()
        resolve({ ok: true })
      }
      const onKick = reason => {
        cleanup()
        reject(new Error(`kicked by the server: ${plainText(reason) || 'no reason given'}`))
      }
      const onEnd = reason => {
        cleanup()
        reject(new Error(`connection ended before spawn: ${reason || 'unknown reason'}`))
      }
      const onError = error => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      function cleanup () {
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('kicked', onKick)
        bot.removeListener('end', onEnd)
        bot.removeListener('error', onError)
      }
      bot.once('spawn', onSpawn)
      bot.once('kicked', onKick)
      bot.once('end', onEnd)
      bot.once('error', onError)
      if (signal) {
        signal.addEventListener('abort', () => {
          cleanup()
          reject(new Error('connection cancelled'))
        }, { once: true })
      }
    })

    try {
      await withTimeout(settled, 45000, 'connecting', () => {
        try {
          bot.end('connect timeout')
        } catch {
          /* the socket may already be gone */
        }
      })
    } catch (error) {
      this.status = 'error'
      this.reason = error instanceof Error ? error.message : String(error)
      this.emitEvent('error', `connect failed: ${this.reason}`)
      try {
        bot.end('connect failure')
      } catch {
        /* ignore */
      }
      if (this.bot === bot) this.bot = null
      throw error
    }

    this.status = 'online'
    this.connectedAt = Date.now()
    // Chat decoding needs the registry, which only exists once Mineflayer built
    // the client; a failure here must not break an otherwise healthy session.
    this.ChatMessage = await chatMessageFactory(bot.registry).catch(() => null)
    if (this.forge) await this.#negotiateForge()
    this.emitEvent('system', `connected to ${this.address}:${this.port} as ${bot.username} (${this.version}, auth: ${auth})`)
    return {
      ok: true,
      username: bot.username,
      address: this.address,
      port: this.port,
      version: this.version,
      forge: this.forgeReport
    }
  }

  /**
   * Attach all long-lived Mineflayer event listeners.
   * @param bot - The live bot.
   */
  #attachListeners (bot) {
    bot.on('spawn', () => {
      this.status = 'online'
      this.emitEvent('system', 'spawned into the world')
    })
    bot.on('respawn', () => this.emitEvent('system', 'respawned after death'))
    bot.on('death', () => {
      const at = pos(bot.entity?.position)
      this.emitEvent('death', `bot died at ${at}`)
    })
    bot.on('kicked', reason => {
      this.status = 'ended'
      this.reason = plainText(reason) || 'kicked'
      this.emitEvent('error', `kicked: ${this.reason}`)
    })
    bot.on('end', reason => {
      if (this.status !== 'ended') {
        this.status = 'ended'
        this.reason = reason || 'connection closed'
        this.emitEvent('warn', `disconnected: ${this.reason}`)
      }
    })
    bot.on('error', error => {
      this.emitEvent('error', `client error: ${error?.message ?? error}`)
    })
    bot.on('message', (message, position) => {
      const text = plainText(message)
      if (text.length === 0) return
      this.#rememberChat(text, position === 'game_info' ? 'game_info' : 'chat')
    })
    this.#watchRawChat(bot)
    bot.on('playerJoined', player => this.emitEvent('player', `${player.username} joined the game`, player.username))
    bot.on('playerLeft', player => this.emitEvent('player', `${player.username} left the game`, player.username))
    bot.on('whisper', (username, message) => {
      const text = plainText(message)
      this.emitEvent('chat', `${username} whispers: ${text}`, username)
      this.mentions.set(username, { name: username, at: Date.now(), message: text, replied: false })
    })
    bot.on('health', () => {
      const health = bot.health
      if (typeof health === 'number' && health <= 6) {
        this.emitEvent('warn', `low health: ${health.toFixed(1)}/20`)
      }
    })
    bot.on('forcedMove', () => this.emitEvent('system', 'server moved the bot'))
    bot.on('game', () => this.emitEvent('system', 'game mode changed'))
  }

  /**
   * Read chat straight off the wire.
   *
   * Mineflayer's own chat decoding targets the `formattedMessage`/`positionId`
   * packet shape, while 1.20.1 sends `system_chat` with `content`/`isActionBar`
   * and `player_chat` with `plainMessage`/`networkName`. Without this pass,
   * ordinary server chat would reach the bot silently as nothing at all, which
   * would break in-game conversation.
   *
   * The same text is never logged twice: whatever this pass records, the
   * high-level `message` handler re-records identically and the dedupe in
   * {@link #rememberChat} drops it.
   * @param bot - The live bot.
   */
  #watchRawChat (bot) {
    const client = bot._client
    if (!client) return
    client.on('system_chat', packet => {
      const content = packet?.content ?? packet?.formattedMessage
      if (content === undefined) return
      this.#rememberChat(this.#decodeChat(content), packet?.isActionBar === true ? 'game_info' : 'chat')
    })
    client.on('player_chat', packet => {
      const sender = this.#decodeSenderName(packet)
      const body = this.#decodeChat(
        packet?.unsignedChatContent ?? packet?.formattedMessage ?? packet?.plainMessage
      )
      if (body.length === 0) return
      this.#rememberChat(sender ? `<${sender}> ${body}` : body, 'chat', sender)
    })
  }

  /**
   * Render one chat component to plain text, tolerating shapes this build of
   * Mineflayer or prismarine-chat cannot parse.
   * @param value - JSON string, component, or plain string.
   * @returns Plain text.
   */
  #decodeChat (value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return plainText(value)
    const text = String(value)
    if (text.length === 0) return ''
    if (!text.startsWith('{') && !text.startsWith('[')) return plainText(text)
    const ChatMessage = this.ChatMessage
    if (ChatMessage) {
      try {
        return plainText(new ChatMessage(JSON.parse(text)))
      } catch {
        /* fall through to the raw text */
      }
    }
    // Fall back to the raw JSON text rather than dropping the message.
    return plainText(text)
  }

  /**
   * Best-effort sender for a `player_chat` packet.
   * @param packet - The decoded packet.
   * @returns A display name, or undefined.
   */
  #decodeSenderName (packet) {
    const raw = packet?.networkName ?? packet?.senderName
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'object') return plainText(raw) || undefined
    const text = String(raw)
    if (!text.startsWith('{') && !text.startsWith('[')) return plainText(text) || undefined
    const ChatMessage = this.ChatMessage
    if (ChatMessage) {
      try {
        return plainText(new ChatMessage(JSON.parse(text))) || undefined
      } catch {
        /* fall through to the raw text */
      }
    }
    return text || undefined
  }

  /**
   * Record one inbound chat line, skipping an immediate duplicate.
   * @param text - Plain text.
   * @param position - `chat` or `game_info`.
   * @param from - Optional sender name.
   */
  #rememberChat (text, position, from) {
    const clean = plainText(text)
    if (clean.length === 0) return
    if (this.lastChat && this.lastChat.text === clean && Date.now() - this.lastChat.at < 1000) return
    this.lastChat = { text: clean, at: Date.now() }
    this.emitEvent(position === 'game_info' ? 'system' : 'chat', clean, from)
    this.#trackMention(clean)
  }

  /**
   * Note direct address of the bot by name in a chat line.
   * @param text - The chat text.
   */
  #trackMention (text) {
    const bot = this.bot
    if (!bot) return
    const name = bot.username
    const index = text.toLowerCase().indexOf(name.toLowerCase())
    if (index < 0) return
    const speaker = [...Object.values(bot.players ?? {})]
      .map(player => player.username)
      .find(candidate => candidate !== name && text.startsWith(candidate))
    const from = speaker ?? 'unknown'
    this.mentions.set(from, { name: from, at: Date.now(), message: text, replied: false })
    this.emitEvent('chat', `${from} mentions the bot: ${text}`, from)
  }

  /**
   * Run the Forge negotiation probe.
   *
   * A vanilla protocol client cannot complete Forge's modern (`fml:handshake`)
   * negotiation. This records what the server advertised so the model can tell
   * the user exactly which capability is missing, instead of failing obscurely.
   */
  async #negotiateForge () {
    const bot = this.bot
    if (!bot) return
    const channels = new Set()
    try {
      // Channels registered by the server arrive through the `REGISTER`
      // plugin message; Mineflayer surfaces them as client state when present.
      const registered = bot._client?.customChannelNames ?? bot.registry?.customChannels
      if (Array.isArray(registered)) for (const name of registered) channels.add(String(name))
    } catch {
      /* channel introspection is best effort */
    }
    const forgeChannels = [...channels].filter(name => name.startsWith('fml:') || name.includes('forge'))
    const report = {
      address: this.address,
      version: this.version,
      detected: forgeChannels.length > 0,
      channels: forgeChannels,
      negotiation: forgeChannels.length > 0 ? 'unsupported-by-protocol-client' : 'not-detected',
      note: forgeChannels.length > 0
        ? 'The server speaks Forge channels. Vanilla-protocol chat, movement, and all vanilla-registry content work; Forge registry negotiation is not implemented, so modded block/item names unavailable to the vanilla registry are reported by numeric id.'
        : 'No Forge plugin channels were observed; treating the server as vanilla-compatible.'
    }
    this.forgeReport = report
    if (report.detected) {
      this.emitEvent('warn', `Forge server detected (channels: ${forgeChannels.join(', ') || 'unknown'}). ${report.note}`)
    }
  }

  /**
   * Send a chat message, or run a command when the text starts with `/`.
   * @param text - Message or command.
   * @returns What was sent.
   */
  say (text) {
    const bot = this.requireOnline()
    const message = String(text ?? '').trim()
    if (message.length === 0) throw new Error('the message is empty')
    if (message.length > 256) throw new Error('Minecraft chat messages are limited to 256 characters')
    if (message.startsWith('/')) bot.chat(message)
    else bot.chat(message)
    this.sent.push({ text: message, at: Date.now() })
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200)
    this.emitEvent('action', `bot said: ${message}`)
    return message
  }

  /**
   * Mark every outstanding mention by a player as handled.
   * @param names - Player names to clear; omit to clear all.
   */
  acknowledge (names) {
    if (!names || names.length === 0) {
      for (const entry of this.mentions.values()) entry.replied = true
      return
    }
    for (const name of names) {
      const key = String(name)
      const entry = this.mentions.get(key)
      if (entry) entry.replied = true
      else this.mentions.set(key, { name: key, at: Date.now(), message: '', replied: true })
    }
  }

  /**
   * Walk to a position and resolve when close enough.
   * @param target - `{ x, y, z }` destination.
   * @param options - `range` (default 1) and `timeoutMs`.
   * @returns A movement summary.
   */
  async goto (target, options = {}) {
    const bot = this.requireOnline()
    const { GoalNear } = await pathfinder()
    const range = Number(options.range ?? 1)
    const timeoutMs = Number(options.timeoutMs ?? GOTO_TIMEOUT_MS)
    const started = Date.now()
    const from = pos(bot.entity.position)
    const goal = new GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range)
    bot.pathfinder.setGoal(goal, true)
    const reached = await this.#waitFor(
      () => goal.isEnd(bot.entity.position.floored()),
      timeoutMs,
      options.signal,
      () => {
        try {
          bot.pathfinder.setGoal(null)
        } catch {
          /* pathfinder may already be idle */
        }
      }
    )
    return {
      reached,
      from,
      to: pos(target),
      ms: Date.now() - started
    }
  }

  /**
   * Wait for a predicate, polling quickly, and stop the bot's pathfinding on timeout.
   * @param predicate - Returns true when the condition is satisfied.
   * @param timeoutMs - Maximum wait.
   * @param signal - Optional cancellation signal.
   * @param onAbort - Cleanup invoked when the wait fails.
   * @returns True when the predicate became true.
   */
  async #waitFor (predicate, timeoutMs, signal, onAbort) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        onAbort?.()
        throw new Error('operation cancelled')
      }
      let ok = false
      try {
        ok = predicate()
      } catch {
        ok = false
      }
      if (ok) return true
      await delay(50, signal)
    }
    onAbort?.()
    return false
  }

  /**
   * Resolve a block name to the registry entry for the connected version.
   * @param name - Block identifier, with or without a namespace.
   * @returns The registry entry or undefined.
   */
  findBlockType (name) {
    const bot = this.requireOnline()
    const raw = String(name ?? '').trim().toLowerCase()
    if (raw.length === 0) return undefined
    const candidates = raw.includes(':') ? [raw, raw.split(':')[1]] : [raw, `minecraft:${raw}`]
    for (const candidate of candidates) {
      const direct = bot.registry.blocksByName[candidate]
      if (direct) return direct
    }
    const squashed = raw.replace(/[\s_-]/g, '')
    for (const [key, value] of Object.entries(bot.registry.blocksByName)) {
      if (key.replace(/[\s_-]/g, '') === squashed) return value
    }
    return undefined
  }

  /**
   * Locate a player by name in the local world model.
   * @param name - Player name.
   * @returns `{ x, y, z }`, or null when the player is not visible.
   */
  async findPlayerPosition (name) {
    const bot = this.requireOnline()
    const entity = bot.players?.[String(name)]?.entity
    return entity ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null
  }

  /**
   * The name of the block at a position, or null when the chunk is unloaded.
   *
   * A protocol client only knows the chunks the server has sent it, so an
   * unloaded position honestly reports null rather than inventing a block.
   * @param x - X coordinate.
   * @param y - Y coordinate.
   * @param z - Z coordinate.
   * @returns The block name, or null.
   */
  async blockNameAt (x, y, z) {
    const bot = this.requireOnline()
    const block = bot.blockAt(new this.Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!block) return null
    return block.name
  }

  /**
   * Scan loaded chunks for blocks, nearest first.
   * @param options - `name`, `names`, `radius`, `count`, `positions`.
   * @returns Matching block positions with their names.
   */
  findBlocks (options = {}) {
    const bot = this.requireOnline()
    const radius = Math.min(Number(options.radius ?? SCAN_RADIUS), 64)
    const limit = Math.min(Number(options.count ?? 16), 256)
    let ids
    const wantedNames = []
    if (Array.isArray(options.positions) && options.positions.length > 0) {
      const Vec3 = this.Vec3
      const results = []
      for (const item of options.positions) {
        const block = bot.blockAt(new Vec3(Math.floor(item.x), Math.floor(item.y), Math.floor(item.z)))
        if (block && block.name !== 'air') results.push({ name: block.name, x: block.position.x, y: block.position.y, z: block.position.z })
      }
      return results
    }
    if (options.name) {
      const type = this.findBlockType(options.name)
      if (!type) return { unknown: String(options.name), matches: [] }
      ids = [type.id]
      wantedNames.push(type.name)
    } else if (Array.isArray(options.names) && options.names.length > 0) {
      ids = []
      for (const name of options.names) {
        const type = this.findBlockType(name)
        if (type) {
          ids.push(type.id)
          wantedNames.push(type.name)
        }
      }
      if (ids.length === 0) return { unknown: options.names.join(', '), matches: [] }
    } else {
      throw new Error('findBlocks requires `name`, `names`, or `positions`')
    }
    const found = bot.findBlocks({
      matching: ids,
      maxDistance: radius,
      count: limit,
      point: bot.entity.position
    })
    const matches = []
    for (const point of found) {
      const block = bot.blockAt(point)
      if (!block || block.name === 'air') continue
      matches.push({ name: block.name, x: block.position.x, y: block.position.y, z: block.position.z })
    }
    return { names: wantedNames, matches }
  }

  /**
   * Equip the most effective tool available for a block.
   *
   * Every inventory item type is timed against the target block through the
   * registry's `digTime`, and the fastest wins. Bare hands are the fallback.
   * @param block - Target block.
   * @returns The equipped item name, or null when bare hands are best.
   */
  async equipFor (block) {
    const bot = this.requireOnline()
    if (!block || typeof block.digTime !== 'function') return null
    const seen = new Set()
    let candidate = null
    let candidateMs = Infinity
    for (const item of bot.inventory.items()) {
      if (!item || seen.has(item.type)) continue
      seen.add(item.type)
      let ms
      try {
        ms = block.digTime(item.type, false, true, false, false)
      } catch {
        continue
      }
      // Creative-like instant breaks report 0; treat them as perfect.
      if (typeof ms === 'number' && ms >= 0 && ms < candidateMs) {
        candidateMs = ms
        candidate = item
      }
    }
    let bareMs = Infinity
    try {
      bareMs = block.digTime(null, false, true, false, false)
    } catch {
      /* an untimed block just keeps bare hands */
    }
    const current = bot.heldItem
    if (candidate === null || candidateMs >= bareMs) {
      if (current) await bot.unequip('hand')
      return null
    }
    if (current?.type !== candidate.type) await bot.equip(candidate, 'hand')
    return candidate.name
  }

  /**
   * Dig a single block at a position.
   * @param point - `{ x, y, z }`.
   * @param options - `timeoutMs`.
   * @returns What was dug.
   */
  async digAt (point, options = {}) {
    const bot = this.requireOnline()
    const Vec3 = this.Vec3
    const target = point.position ?? point
    const block = bot.blockAt(new Vec3(
      Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)
    ))
    if (!block || block.name === 'air') return { dug: false, reason: 'no block at that position' }
    if (block.name === 'bedrock' || block.name === 'barrier') return { dug: false, reason: `${block.name} cannot be broken` }
    if (block.hardness === undefined || block.hardness < 0) {
      return { dug: false, reason: `${block.name} is unbreakable` }
    }
    const tool = await this.equipFor(block)
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await withTimeout(bot.dig(block, 'ignore'), timeoutMs, `digging ${block.name}`, () => {
      try {
        bot.stopDigging()
      } catch {
        /* nothing to stop */
      }
    })
    return { dug: true, name: block.name, at: pos(block.position), tool }
  }

  /**
   * Break a whole set of positions, nearest first, tolerating individual failures.
   * @param points - Candidate positions.
   * @param options - `timeoutMs`, `maxBlocks`, `onProgress`.
   * @returns A per-target outcome summary.
   */
  async digMany (points, options = {}) {
    const bot = this.requireOnline()
    const Vec3 = this.Vec3
    const maxBlocks = Math.max(1, Number(options.maxBlocks ?? points.length))
    if (options.signal?.aborted) throw new Error('operation cancelled')
    const queue = points
      .map(point => ({ ...point }))
      .sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z)) -
        bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z)))
      .slice(0, maxBlocks)
    const dug = []
    const failed = []
    for (const point of queue) {
      if (options.signal?.aborted) break
      try {
        await this.goto({ x: point.x, y: point.y, z: point.z }, {
          range: 3,
          timeoutMs: Math.min(GOTO_TIMEOUT_MS, Number(options.gotoTimeoutMs ?? 15000)),
          signal: options.signal
        })
        const result = await this.digAt(point, { timeoutMs: options.timeoutMs })
        if (result.dug) dug.push(result)
        else failed.push({ ...point, reason: result.reason })
      } catch (error) {
        failed.push({ ...point, reason: error instanceof Error ? error.message : String(error) })
      }
      if (typeof options.onProgress === 'function') options.onProgress(dug.length, failed.length)
      await this.collectDrops({ radius: 6, timeoutMs: 4000 })
    }
    return { dug, failed, count: dug.length }
  }

  /**
   * Pick up nearby dropped items.
   * @param options - `radius`, `timeoutMs`.
   * @returns The number of items collected.
   */
  async collectDrops (options = {}) {
    const bot = this.requireOnline()
    const radius = Number(options.radius ?? 6)
    const deadline = Date.now() + Number(options.timeoutMs ?? 5000)
    let collected = 0
    while (Date.now() < deadline) {
      const drops = Object.values(bot.entities).filter(entity =>
        entity?.name === 'item' && entity.position &&
        entity.position.distanceTo(bot.entity.position) <= radius)
      if (drops.length === 0) break
      const drop = drops.sort((a, b) =>
        a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      try {
        await this.goto(drop.position, { range: 1, timeoutMs: 4000 })
        await delay(200)
      } catch {
        break
      }
      const remaining = Object.values(bot.entities).filter(entity =>
        entity?.name === 'item' && entity.position &&
        entity.position.distanceTo(bot.entity.position) <= 2)
      if (remaining.length === 0) collected++
    }
    return collected
  }

  /**
   * Place one block from the inventory against a neighbouring face.
   * @param point - Destination `{ x, y, z }`.
   * @param itemName - Optional item to place; otherwise any placeable item.
   * @returns The placement outcome.
   */
  async placeAt (point, itemName) {
    const bot = this.requireOnline()
    const Vec3 = this.Vec3
    const destination = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
    const existing = bot.blockAt(destination)
    if (existing && existing.name !== 'air' && existing.name !== 'water' && existing.name !== 'lava') {
      return { placed: false, reason: `${existing.name} already occupies ${pos(destination)}` }
    }
    const item = this.findInventoryItem(itemName, { placeableOnly: true })
    if (!item) {
      const hint = itemName ? `no placeable "${itemName}" in the inventory` : 'no placeable block in the inventory'
      return { placed: false, reason: hint }
    }
    const faces = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
    for (const face of faces) {
      const reference = destination.plus(new Vec3(face[0], face[1], face[2]))
      const support = bot.blockAt(reference)
      if (!support || support.name === 'air' || support.boundingBox === 'empty') continue
      try {
        if (bot.heldItem?.type !== item.type) await bot.equip(item, 'hand')
        await withTimeout(
          bot.placeBlock(support, new Vec3(-face[0], -face[1], -face[2])),
          Number(point.timeoutMs ?? 8000),
          `placing ${item.name}`
        )
        const after = bot.blockAt(destination)
        if (after && after.name !== 'air') {
          return { placed: true, name: after.name, at: pos(destination) }
        }
      } catch {
        /* try the next supporting face */
      }
    }
    return { placed: false, reason: `no reachable surface to place ${item.name} at ${pos(destination)}` }
  }

  /**
   * Find an inventory item by name.
   * @param name - Item identifier, or undefined for any item.
   * @param options - `placeableOnly`.
   * @returns The Mineflayer item or null.
   */
  findInventoryItem (name, options = {}) {
    const bot = this.requireOnline()
    const items = bot.inventory.items()
    let candidates = items
    if (options.placeableOnly) {
      candidates = items.filter(item => {
        const type = bot.registry.blocksByName[item.name]
        return type !== undefined && bot.registry.blocks[type.id]?.boundingBox !== 'empty'
      })
    }
    if (name === undefined || name === null || String(name).trim() === '') {
      return candidates[0] ?? null
    }
    const raw = String(name).trim().toLowerCase()
    const matches = candidate => {
      if (candidate.name === raw) return true
      if (raw.includes(':') && candidate.name === raw.split(':')[1]) return true
      return candidate.displayName?.toLowerCase() === raw || candidate.name.replace(/[\s_-]/g, '') === raw.replace(/[\s_-]/g, '')
    }
    return candidates.find(matches) ?? null
  }

  /**
   * Count how many of an item the bot carries.
   * @param name - Item identifier.
   * @returns The total count.
   */
  countItem (name) {
    const item = this.findInventoryItem(name)
    if (!item) return 0
    const bot = this.requireOnline()
    return bot.inventory.items()
      .filter(candidate => candidate.name === item.name)
      .reduce((total, candidate) => total + candidate.count, 0)
  }

  /**
   * Build the world snapshot the model reads.
   * @param options - `radius`, `blockLimit`.
   * @returns A JSON-serialisable observation.
   */
  observe (options = {}) {
    const bot = this.requireOnline()
    const radius = Number(options.radius ?? 16)
    const blockLimit = Number(options.blockLimit ?? 80)
    const position = bot.entity.position
    const counts = new Map()
    const origin = position.floored()
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -6; dy <= 4; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = bot.blockAt(origin.offset(dx, dy, dz))
          if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue
          counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
        }
      }
    }
    const blocks = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, blockLimit)
      .map(([name, count]) => ({ name, count }))
    const players = Object.values(bot.players ?? {})
      .filter(player => player?.username)
      .map(player => ({
        name: player.username,
        distance: player.entity
          ? Number(player.entity.position.distanceTo(position).toFixed(1))
          : null,
        position: player.entity ? pos(player.entity.position) : null
      }))
      .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
    const entities = Object.values(bot.entities ?? {})
      .filter(entity => entity && entity !== bot.entity && INTERESTING_ENTITY.has(entity.kind) &&
        entity.position && entity.position.distanceTo(position) <= radius)
      .map(entity => ({
        kind: entity.kind,
        name: entity.name ?? entity.username ?? 'unknown',
        distance: Number(entity.position.distanceTo(position).toFixed(1)),
        position: pos(entity.position)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 40)
    const drops = Object.values(bot.entities ?? {})
      .filter(entity => entity?.name === 'item' && entity.position &&
        entity.position.distanceTo(position) <= radius * 2)
      .map(entity => ({
        item: entity.displayName ?? entity.metadata?.find?.(entry => Array.isArray(entry))?.[1]?.itemId ?? 'item',
        distance: Number(entity.position.distanceTo(position).toFixed(1)),
        position: pos(entity.position)
      }))
      .slice(0, 20)
    const held = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null
    return {
      online: this.online,
      server: `${this.address}:${this.port}`,
      username: bot.username,
      version: this.version,
      position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z), exact: pos(position) },
      dimension: bot.game?.dimension ?? 'unknown',
      gameMode: bot.game?.gameMode ?? 'unknown',
      health: bot.health ?? null,
      food: bot.food ?? null,
      experienceLevel: bot.experience?.level ?? null,
      timeOfDay: bot.time?.timeOfDay ?? null,
      isRaining: bot.isRaining ?? null,
      heldItem: held,
      players,
      entities,
      droppedItems: drops,
      inventory: this.inventorySummary(),
      nearbyBlocks: blocks,
      recentEvents: this.log.tail(Number(options.logLines ?? 30))
    }
  }

  /**
   * Summarise the inventory as name/count pairs plus free slots.
   * @returns An inventory summary.
   */
  inventorySummary () {
    const bot = this.requireOnline()
    const totals = new Map()
    for (const item of bot.inventory.items()) {
      if (!item) continue
      totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
    }
    const items = [...totals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    const used = bot.inventory.items().reduce((sum, item) => sum + (item ? 1 : 0), 0)
    return {
      items,
      usedSlots: used,
      totalSlots: bot.inventory.slots.length - 5,
      freeSlots: Math.max(0, bot.inventory.slots.length - 5 - used),
      emptyCount: bot.inventory.emptySlotCount?.() ?? null
    }
  }

  /**
   * Drop items from the inventory.
   * @param name - Item identifier.
   * @param count - How many to drop.
   * @returns What was dropped.
   */
  async dropItem (name, count) {
    const bot = this.requireOnline()
    const item = this.findInventoryItem(name)
    if (!item) throw new Error(`no "${name}" in the inventory`)
    const total = this.countItem(name)
    const wanted = Math.min(Number(count ?? total) || total, total)
    await bot.toss(item.type, null, wanted)
    return { dropped: wanted, name: item.name }
  }

  /**
   * Consume food until no longer hungry.
   * @returns A description of what was eaten.
   */
  async eat () {
    const bot = this.requireOnline()
    const food = bot.inventory.items().find(item => bot.registry.foodsByName[item.name])
    if (!food) throw new Error('no food in the inventory')
    await withTimeout(bot.consume(), 15000, 'eating')
    return { ate: food.name }
  }

  /**
   * Disconnect from the server and release the bot.
   * @param reason - Reason passed to the server.
   * @returns A summary of the disconnection.
   */
  async disconnect (reason = 'dsh agent leaving') {
    const bot = this.bot
    if (!bot) {
      this.status = 'idle'
      return { disconnected: false, reason: 'no active session' }
    }
    const username = bot.username
    const address = `${this.address}:${this.port}`
    try {
      bot.pathfinder?.setGoal?.(null)
    } catch {
      /* pathfinder may not be loaded */
    }
    await new Promise(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      bot.once('end', done)
      try {
        bot.quit(reason)
      } catch {
        try {
          bot.end(reason)
        } catch {
          /* the socket is already gone */
        }
      }
      setTimeout(done, 3000)
    })
    if (this.bot === bot) this.bot = null
    this.status = 'idle'
    this.connectedAt = null
    this.activeTask = null
    this.activeTaskLabel = null
    this.emitEvent('system', `disconnected from ${address}`)
    return { disconnected: true, username, address }
  }

  /**
   * A compact status line for tool output.
   * @returns Status text.
   */
  statusLine () {
    if (this.online) {
      const bot = this.bot
      const seconds = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0
      return `${bot.username} online at ${this.address}:${this.port} (${this.version}), ${seconds}s, at ${pos(bot.entity.position)}`
    }
    return `session ${this.status}${this.reason ? `: ${clamp(this.reason, 200)}` : ''}`
  }
}
