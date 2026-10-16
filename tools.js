/**
 * The model-facing tool surface.
 *
 * Every tool funnels through one shared {@link AgentContext}, which holds the
 * single live bot session. Registration is centralised here so `index.js` only
 * has to wire lifecycle concerns.
 *
 * `mc_join` selects the backend: `protocol` for vanilla servers, `forge` for the
 * bridge that runs inside a real Forge client.
 */

import { ModRegistry, scanModsDirectory } from './mods.js'
import { MinecraftAgentSession } from './client.js'
import { BridgeSession } from './bridge-session.js'
import { BridgeClient } from './bridge-client.js'
import { TaskRunner, TASK_KINDS } from './tasks.js'
import { EventLog } from './log.js'
import { blueprintFromFile, blueprintFromList, blueprintFromShape, parseCoords } from './blueprint.js'
import { buildBlueprint } from './build.js'
import { clamp } from './text.js'

/** Section order placing the Minecraft section near the end of the prompt. */
const SECTION_ORDER = 900

/**
 * Whether the in-client Forge bridge answers on its configured port.
 *
 * Used to choose a backend when the caller named neither one nor an address:
 * the only game reachable without an address is the client on this machine, so
 * a live bridge is the intended target. A dead bridge is not an error here — the
 * caller falls back to the protocol path and gets told what to start.
 * @param agent - The agent context holding the resolved configuration.
 * @returns Whether the bridge answered a ping.
 */
async function bridgeIsUp (agent) {
  const probe = new BridgeClient({
    host: agent.config.bridgeHost ?? '127.0.0.1',
    port: Number(agent.config.bridgePort ?? 25577)
  })
  try {
    await probe.ping()
    return true
  } catch {
    return false
  } finally {
    probe.close()
  }
}

/**
 * Shared state for every Minecraft tool.
 */
export class AgentContext {
  /**
   * @param config - Resolved plugin configuration.
   */
  constructor (config = {}) {
    /** @type {object} */
    this.config = config
    /** @type {EventLog} */
    this.log = new EventLog(config.maxLogLines ?? 400)
    /** @type {MinecraftAgentSession|null} */
    this.session = null
    /** @type {TaskRunner|null} */
    this.tasks = null
    /** @type {ModRegistry} */
    this.mods = new ModRegistry()
    /** @type {Set<Function>} */
    this.toolDisposers = new Set()
    /** @type {Set<Function>} */
    this.watchers = new Set()
    // Bridge location for `mc_join backend=forge`; resolved here so the session
    // factory does not have to know how configuration is shaped.
    this.config = {
      ...config,
      bridgeHost: config.bridgeHost ?? '127.0.0.1',
      bridgePort: Number(config.bridgePort ?? 25577)
    }
  }

  /**
   * Create the session on first use, or switch backend when asked.
   *
   * `protocol` drives a headless protocol client, which sees only vanilla
   * registries. `forge` attaches to the in-client control bridge, where modded
   * blocks and items keep their true registry names; switching discards any
   * previous session so the two can never be mixed.
   * @param backend - `protocol`, `forge`, or omitted to keep the current session.
   * @returns The live session.
   */
  ensureSession (backend) {
    const wanted = backend === 'forge' ? 'forge' : backend === 'protocol' ? 'protocol' : null
    const current = this.session?.backend ?? null
    const isForge = current === 'bridge'
    // Only an explicit, different backend replaces a live session; calling with
    // no argument must never tear down what mc_join established.
    if (this.session && wanted !== null && ((wanted === 'forge') !== isForge)) {
      const previous = this.session
      this.session = null
      this.tasks = null
      void previous.disconnect('switching backend')
    }
    if (!this.session) {
      const createForge = wanted === 'forge'
      if (createForge) {
        this.session = new BridgeSession({
          log: this.log,
          maxLogLines: this.config.maxLogLines ?? 400,
          username: this.config.defaultUsername ?? 'DSH_Agent',
          host: this.config.bridgeHost ?? '127.0.0.1',
          port: Number(this.config.bridgePort ?? 25577)
        })
      } else {
        this.session = new MinecraftAgentSession({
          log: this.log,
          maxLogLines: this.config.maxLogLines ?? 400,
          username: this.config.defaultUsername ?? 'DSH_Agent',
          version: this.config.defaultVersion ?? '1.20.1',
          auth: this.config.defaultAuth ?? 'offline'
        })
      }
      this.tasks = new TaskRunner(this.session)
    }
    return this.session
  }

  /**
   * Resolve a block name, consulting a loaded modded mapping after the registry.
   * @param name - Block identifier.
   * @returns `{ id, name, source }` or undefined.
   */
  resolveBlock (name) {
    if (!this.session) return undefined
    let vanilla
    try {
      vanilla = this.session.findBlockType(name)
    } catch {
      return undefined
    }
    if (vanilla) return { id: vanilla.id, name: vanilla.name, source: 'registry' }
    const mapped = this.mods.idOf(name)
    if (mapped !== undefined) {
      const known = this.session.bot?.registry?.blocks?.[mapped]
      return { id: mapped, name: known?.name ?? String(name), source: 'mapping' }
    }
    return undefined
  }

  /**
   * Subscribe to notable bot events.
   * @param listener - Receives log entries.
   * @returns A disposer.
   */
  watch (listener) {
    this.watchers.add(listener)
    if (this.session) {
      const dispose = this.session.watch(listener)
      return () => {
        this.watchers.delete(listener)
        dispose()
      }
    }
    return () => this.watchers.delete(listener)
  }

  /**
   * Release the session and every registration made through this context.
   * @returns A promise resolved once the bot is disconnected.
   */
  async close () {
    if (this.session) {
      try {
        await this.session.disconnect('dsh plugin unloaded')
      } catch {
        /* shutdown must not throw */
      }
    }
    for (const dispose of this.toolDisposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    this.toolDisposers.clear()
    this.watchers.clear()
    this.session = null
    this.tasks = null
  }

  /**
   * Register a tool definition through the registry.
   *
   * The definition is normalised to explicit JSON Schema first. Some registry
   * builds accept an author-facing property map and compile it themselves, but
   * that compilation is not guaranteed to run — an uncompiled map reaches the
   * model API as a parameter schema whose root `type` is `null`, and the whole
   * request is then rejected with
   * `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
   * Emitting the compiled form removes that dependency entirely.
   * @param registry - The `tools` service.
   * @param definition - Tool definition, with parameters as a property map.
   */
  register (registry, definition) {
    const dispose = registry.register({
      ...definition,
      parameters: toObjectSchema(definition.parameters),
      output: {
        ...definition.output,
        schema: toObjectSchema(definition.output?.schema)
      }
    })
    this.toolDisposers.add(dispose)
  }
}

/**
 * Convert an author-facing property map into an explicit JSON Schema object.
 *
 * A per-property `required: true` is hoisted into the object-level `required`
 * array, which is the only form the registry and the model API accept. A schema
 * that is already object-rooted is passed through unchanged.
 * @param spec - Property map, or an already-compiled schema.
 * @returns A JSON Schema node whose root type is `object`.
 */
function toObjectSchema (spec) {
  if (spec === undefined || spec === null) return { type: 'object', properties: {} }
  if (typeof spec !== 'object' || Array.isArray(spec)) return { type: 'object', properties: {} }
  // Already compiled: it declares an object root and an explicit property map.
  if (spec.type === 'object' && spec.properties && typeof spec.properties === 'object') {
    return spec
  }
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined || value === null || typeof value !== 'object') {
      // A bare-scalar or otherwise unusable entry becomes an untyped property
      // rather than a `null` node, which would invalidate the whole schema.
      properties[key] = { description: String(value ?? '') }
      continue
    }
    const { required: isRequired, ...rest } = value
    if (isRequired === true) required.push(key)
    properties[key] = rest
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
  }
}

/**
 * Build the text block the model sees for a tool result.
 * @param text - Result text.
 * @returns A one-element content array.
 */
const textResult = text => [{ type: 'text', text: String(text) }]

/**
 * Render a JSON value compactly for a tool result.
 * @param value - Any JSON value.
 * @returns Pretty-printed JSON.
 */
const json = value => JSON.stringify(value, null, 2)

/**
 * Wrap a tool body so failures come back as readable errors.
 * @param body - The implementation.
 * @returns A tool `execute` function.
 */
function run (body) {
  return async (args, exec) => body(args ?? {}, exec)
}

/**
 * Register every Minecraft tool and the prompt section.
 * @param ctx - Cordis plugin context.
 * @param agent - Shared agent context.
 */
export function registerTools (ctx, agent) {
  const tools = ctx.tools

  // ---------------------------------------------------------------- mc_join
  agent.register(tools, {
    name: 'mc_join',
    description:
      'Establish the Minecraft session and keep it alive for later tool calls. ' +
      'backend=protocol dials "host" or "host:port" with a headless protocol client: chat, movement, mining, building and ' +
      'all vanilla content work, but 1.20.1 never sends a block/item registry, so modded content is only visible as numeric ids. ' +
      'backend=forge instead attaches to the in-client control bridge running inside a real Forge client, where every modded ' +
      'block and item is addressed by its true registry name; that client must already be running with the bridge mod installed. ' +
      'With neither `backend` nor `address` given, the bridge is tried first because it is the only game reachable without an address.',
    parameters: {
      address: {
        type: 'string',
        description: 'Server host, optionally with a port such as "play.example.com:25565". Required for backend=protocol.'
      },
      port: { type: 'number', description: 'Server port (protocol backend), or bridge port (forge backend).' },
      username: { type: 'string', description: 'In-game name for the bot.' },
      version: { type: 'string', description: 'Minecraft version string. Defaults to 1.20.1.' },
      auth: {
        type: 'string',
        enum: ['offline', 'microsoft'],
        description: 'Login mode. `offline` for cracked/LAN servers (default), `microsoft` for online-mode servers, which opens a device-code sign-in.'
      },
      timeoutMs: { type: 'number', description: 'How long to wait for spawn. Defaults to 45000.' },
      backend: {
        type: 'string',
        enum: ['protocol', 'forge'],
        description:
          'How to reach the server. `protocol` (default) connects a headless protocol client: vanilla content only, ' +
          'because 1.20.1 never sends a block/item registry. `forge` attaches to the in-client control bridge inside a real ' +
          'Forge client, where every modded block and item keeps its true registry name. With `forge`, the client must already ' +
          'be running with the bridge mod installed.'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean'},
          username: { type: 'string' },
          address: { type: 'string' },
          version: { type: 'string' },
          spawn: { type: 'string' },
          forge: { type: 'string' }
        }
      },
      render: (_args, value) => textResult([
        `connected: ${value.connected}`,
        `bot: ${value.username ?? 'unknown'} at ${value.address ?? 'unknown'} (${value.version ?? '?'})`,
        value.spawn ? `spawn: ${value.spawn}` : null,
        value.forge ?? null
      ].filter(Boolean).join('\n'))
    },
    execute: run(async (args, exec) => {
      const address = String(args.address ?? '').trim()
      let backend = args.backend === 'forge' || args.backend === 'protocol' ? args.backend : null
      if (!backend) {
        // No backend and no address to dial: the only game reachable that way is
        // the client on this machine, so try its bridge. Asking the bridge first
        // means a working setup needs no arguments at all, while an unreachable
        // bridge still falls back to a protocol dial when an address was given.
        backend = address.length === 0 && await bridgeIsUp(agent) ? 'forge' : 'protocol'
      }
      const session = agent.ensureSession(backend)

      if (backend === 'forge') {
        // The bridge lives inside an already-running client, so there is no
        // address to dial: the client is the connection.
        const port = args.port ?? agent.config.bridgePort ?? 25577
        session.bridge.port = Number(port)
        if (args.username) session.username = String(args.username)
        const result = await session.connect(exec?.signal)
        // A client that is still on Forge's start-up warning screen has no world
        // yet; report that honestly instead of failing the attach, and let the
        // caller clear the screen with mc_control action=screen_click.
        let observation = null
        try {
          observation = await session.refresh({ radius: 8, vertical: 4, blockLimit: 20 })
        } catch (error) {
          if (error?.code !== 'not-in-world') throw error
        }
        if (!observation) {
          const screen = await session.screen().catch(() => null)
          return {
            connected: true,
            address: result.address,
            version: result.version,
            spawn: 'the client is attached but not in a world yet',
            forge: `screen open: ${screen?.open ? `${screen.type} "${screen.title}"` : 'none'}. ` +
              'Use mc_control action=screen to look at it, screen_click to press a button, and open_world to load a save.'
          }
        }
        const current = session.observe({ logLines: 10 })
        return {
          connected: true,
          username: current.username,
          address: result.address,
          version: result.version,
          spawn: `inside the Forge client at ${current.position.exact} in ${current.dimension}, health ${current.health}`,
          forge: result.forge?.note ?? null
        }
      }

      if (address.length === 0) {
        throw new Error(
          '`address` is required when backend is `protocol`. For the Forge client on this machine, ' +
          'start it with the bridge mod installed and call mc_join with backend="forge" (or with no arguments at all).'
        )
      }
      const inlinePort = /:(\d{2,5})$/.exec(address)
      session.address = inlinePort ? address.slice(0, -inlinePort[0].length) : address
      session.port = Number(args.port ?? (inlinePort ? Number(inlinePort[1]) : 25565))
      if (args.username) session.username = String(args.username)
      if (args.version) session.version = String(args.version)
      if (args.auth) session.auth = args.auth === 'microsoft' ? 'microsoft' : 'offline'
      const result = await session.connect(exec?.signal)
      const observation = session.observe({ radius: 8, blockLimit: 20, logLines: 10 })
      return {
        connected: true,
        username: result.username,
        address: `${result.address}:${result.port}`,
        version: result.version,
        spawn: `at ${observation.position.exact} in ${observation.dimension}, game mode ${observation.gameMode}, health ${observation.health}`,
        forge: result.forge?.note ?? null
      }
    })
  })

  // --------------------------------------------------------------- mc_state
  agent.register(tools, {
    name: 'mc_state',
    description:
      'Report the Minecraft session without changing it: connection status, position, health, game mode, ' +
      'inventory totals, the running task, and recent events. Use it to decide whether a bot is needed.',
    parameters: {
      logLines: { type: 'number', description: 'How many recent events to include. Defaults to 25.' },
      inventory: { type: 'boolean', description: 'Include the full item list. Defaults to true.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string'},
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      if (!agent.session) {
        return { status: 'idle', detail: 'No Minecraft session has been created yet. Use mc_join to connect to a server.' }
      }
      const session = agent.session
      const lines = [session.statusLine()]
      if (session.online) {
        const view = session.observe({ radius: 4, blockLimit: 12, logLines: Number(args.logLines ?? 25) })
        lines.push(`dimension: ${view.dimension}, game mode: ${view.gameMode}`)
        lines.push(`health: ${view.health}/20, food: ${view.food}/20, xp level: ${view.experienceLevel}`)
        lines.push(`held: ${view.heldItem ? `${view.heldItem.name} x${view.heldItem.count}` : 'nothing'}`)
        if (args.inventory !== false) {
          const items = view.inventory.items.slice(0, 60)
          lines.push(`inventory (${view.inventory.usedSlots}/${view.inventory.totalSlots} slots): ` +
            (items.length === 0 ? 'empty' : items.map(item => `${item.name} x${item.count}`).join(', ')))
        }
        lines.push(`players nearby: ${view.players.slice(0, 10).map(player => `${player.name}${player.distance === null ? '' : ` (${player.distance}m)`}`).join(', ') || 'none'}`)
      }
      const task = agent.tasks?.status()
      if (task) {
        lines.push(`task: ${task.kind} [${task.status}] ${task.progress} (${Math.round(task.elapsedMs / 1000)}s)`)
        if (task.error) lines.push(`task error: ${task.error}`)
      }
      const recent = session.log.tail(Number(args.logLines ?? 25))
      if (recent.length > 0) {
        lines.push('recent events:')
        for (const entry of recent) lines.push(`  [${entry.kind}] ${clamp(entry.text, 300)}`)
      }
      const pendingMentions = [...session.mentions.values()].filter(entry => !entry.replied)
      if (pendingMentions.length > 0) {
        lines.push(`unanswered messages: ${pendingMentions.map(entry => entry.name).join(', ')}`)
      }
      return { status: session.status, detail: lines.join('\n') }
    })
  })

  // ------------------------------------------------------------- mc_observe
  agent.register(tools, {
    name: 'mc_observe',
    description:
      'Read the world around the bot: exact position, block census, nearby players and entities, dropped items, ' +
      'and recent chat. This is the primary way to see what is going on before acting.',
    parameters: {
      radius: { type: 'number', description: 'Scan radius in blocks. Defaults to 16, maximum 32.' },
      blockLimit: { type: 'number', description: 'How many distinct block types to report. Defaults to 60.' },
      logLines: { type: 'number', description: 'How many recent chat/system events to include. Defaults to 30.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          detail: { type: 'string'},
          players: { type: 'array', items: { type: 'string' } },
          blocks: { type: 'array', items: { type: 'string' } }
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      const radius = Math.min(Math.max(2, Number(args.radius ?? 16)), 32)
      const blockLimit = Math.min(Math.max(1, Number(args.blockLimit ?? 60)), 200)
      // The bridge reports the snapshot it last fetched, so a fresh scan has to
      // be asked for explicitly; ignoring this would answer a radius-24 request
      // with whatever a previous radius-8 call happened to see.
      if (typeof session.refresh === 'function') {
        try {
          await session.refresh({ radius, vertical: Math.max(4, Math.round(radius / 2)), blockLimit })
        } catch (error) {
          // Reading the screen or a start-up state with no world is not fatal:
          // the cached snapshot below still reports what is known.
          if (error?.code !== 'not-in-world') throw error
        }
      }
      const view = session.observe({
        radius,
        blockLimit,
        logLines: Math.min(Math.max(0, Number(args.logLines ?? 30)), 200)
      })
      const lines = [
        `${view.username} at ${view.position.exact} in ${view.dimension}, game mode ${view.gameMode}`,
        `health ${view.health}/20, food ${view.food}/20, held ${view.heldItem ? `${view.heldItem.name} x${view.heldItem.count}` : 'nothing'}`,
        '',
        `players (${view.players.length}):`,
        ...view.players.slice(0, 15).map(player =>
          `  ${player.name} ${player.distance === null ? '(position unknown)' : `${player.distance} blocks away at ${player.position}`}`),
        '',
        `entities within ${radius} (${view.entities.length}):`,
        ...view.entities.slice(0, 20).map(entity => `  ${entity.kind} ${entity.name} at ${entity.position} (${entity.distance}m)`),
        '',
        `dropped items (${view.droppedItems.length}):`,
        ...view.droppedItems.slice(0, 12).map(item => `  ${item.item} at ${item.position} (${item.distance}m)`),
        '',
        `inventory: ${view.inventory.items.length === 0 ? 'empty' : view.inventory.items.map(item => `${item.name} x${item.count}`).join(', ')}`,
        '',
        `block census within ${radius} (top ${view.nearbyBlocks.length}):`,
        ...view.nearbyBlocks.map(entry => `  ${entry.name} x${entry.count}`),
        '',
        'recent events:',
        ...view.recentEvents.map(entry => `  [${entry.kind}] ${clamp(entry.text, 300)}`)
      ]
      return {
        detail: lines.join('\n'),
        players: view.players.map(player => player.name),
        blocks: view.nearbyBlocks.map(entry => entry.name)
      }
    })
  })

  // ---------------------------------------------------------------- mc_chat
  agent.register(tools, {
    name: 'mc_chat',
    description:
      'Talk in game. Sends a public chat message, a private message (`whisper`), or a server command (`command`), ' +
      'and can read back what the server answered. Use it to converse with players while tasks run in the background.',
    parameters: {
      message: { type: 'string', description: 'Text to send, or the command body when `kind` is `command`.' },
      kind: { type: 'string', enum: ['chat', 'whisper', 'command'], description: 'Message type. Defaults to `chat`.' },
      target: { type: 'string', description: 'Player name; required when `kind` is `whisper`.' },
      waitMs: { type: 'number', description: 'Milliseconds to wait for the server response before reporting. Defaults to 1200.' },
      acknowledge: {
        type: 'array',
        items: { type: 'string' },
        description: 'Player names whose outstanding messages this reply answers, so they stop being reported as unanswered.'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'string'},
          response: { type: 'array', items: { type: 'string' } }
        }
      },
      render: (_args, value) => textResult([
        `sent: ${value.sent}`,
        value.response.length > 0 ? `server response:\n${value.response.map(line => `  ${line}`).join('\n')}` : 'no response observed'
      ].join('\n'))
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      const kind = args.kind ?? 'chat'
      const message = String(args.message ?? '').trim()
      if (message.length === 0) throw new Error('`message` is required')
      let wire
      if (kind === 'command') {
        wire = message.startsWith('/') ? message : `/${message}`
      } else if (kind === 'whisper') {
        const target = String(args.target ?? '').trim()
        if (target.length === 0) throw new Error('`target` is required when kind is whisper')
        wire = `/msg ${target} ${message}`
      } else {
        wire = message
      }
      const cursor = session.log.cursor
      session.say(wire)
      if (args.acknowledge) session.acknowledge(args.acknowledge)
      const waitMs = Math.min(Math.max(0, Number(args.waitMs ?? 1200)), 15000)
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
      const response = session.log.since(cursor)
        .filter(entry => entry.kind === 'chat' || entry.kind === 'system')
        .map(entry => clamp(entry.from ? `<${entry.from}> ${entry.text}` : entry.text, 300))
      return { sent: wire, response }
    })
  })

  // ---------------------------------------------------------------- mc_goto
  agent.register(tools, {
    name: 'mc_goto',
    description:
      'Walk the bot to a position, or to a player. Long walks run as a background task that can be watched ' +
      'with mc_task and cancelled with mc_control.',
    parameters: {
      x: { type: 'number', description: 'Target X coordinate.' },
      y: { type: 'number', description: 'Target Y coordinate.' },
      z: { type: 'number', description: 'Target Z coordinate.' },
      player: { type: 'string', description: 'Walk to this player instead of coordinates.' },
      range: { type: 'number', description: 'How close to get. Defaults to 1 for coordinates, 3 for players.' },
      background: { type: 'boolean', description: 'Return immediately and keep walking. Defaults to false.' },
      timeoutMs: { type: 'number', description: 'Maximum walking time. Defaults to 120000.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reached: { type: 'boolean'},
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      session.requireOnline()
      if (args.player) {
        const name = String(args.player)
        // Player entities exist only on the protocol client's local world model;
        // the bridge asks the real client instead.
        const target = await session.findPlayerPosition(name)
        if (!target) throw new Error(`player "${name}" is not visible to the bot`)
        if (args.background) {
          await agent.tasks.replace()
          const task = agent.tasks.start('follow', {
            player: name,
            distance: Number(args.range ?? 3),
            durationMs: Number(args.timeoutMs ?? 120000)
          })
          return { reached: true, detail: `started following ${name} as task #${task.id}` }
        }
        const result = await session.goto(target, {
          range: Number(args.range ?? 3),
          timeoutMs: Number(args.timeoutMs ?? 120000)
        })
        return {
          reached: result.reached,
          detail: result.reached
            ? `reached ${name} in ${Math.round(result.ms / 1000)}s, now at ${result.to}`
            : `could not reach ${name} within ${Math.round(result.ms / 1000)}s; still at ${result.from}`
        }
      }
      if (args.x === undefined || args.y === undefined || args.z === undefined) {
        throw new Error('provide either `player`, or all of `x`, `y`, and `z`')
      }
      const target = { x: Number(args.x), y: Number(args.y), z: Number(args.z) }
      if (args.background) {
        await agent.tasks.replace()
        const task = agent.tasks.start('goto', {
          ...target,
          range: Number(args.range ?? 1),
          timeoutMs: Number(args.timeoutMs ?? 120000)
        })
        return { reached: true, detail: `started walking to ${target.x},${target.y},${target.z} as task #${task.id}; check mc_task action=status` }
      }
      const result = await session.goto(target, {
        range: Number(args.range ?? 1),
        timeoutMs: Number(args.timeoutMs ?? 120000)
      })
      // Reporting the current position must not assume a Mineflayer bot: the
      // bridge keeps the position on the session instead.
      const here = session.origin
        ? `${Math.floor(session.origin.x)},${Math.floor(session.origin.y)},${Math.floor(session.origin.z)}`
        : (session.bot?.entity?.position?.floored?.()?.toString() ?? 'an unknown position')
      return {
        reached: result.reached,
        detail: result.reached
          ? `reached ${result.to} in ${Math.round(result.ms / 1000)}s`
          : `did not reach ${result.to} within ${Math.round(result.ms / 1000)}s; the bot is at ${here}`
      }
    })
  })

  // ------------------------------------------------------------- mc_collect
  agent.register(tools, {
    name: 'mc_collect',
    description:
      'Gather resources: find the nearest matching blocks, walk to them, mine them, and pick up the drops. ' +
      'Runs in the background by default so the bot can keep chatting. ' +
      'Block names are vanilla identifiers such as `oak_log`, `iron_ore`, `sand`, or `minecraft:stone`. ' +
      'Modded blocks work only when the server exposes them under a vanilla id or a registry mapping is loaded.',
    parameters: {
      block: { type: 'string', required: true, description: 'Block identifier to harvest.' },
      count: { type: 'number', description: 'How many to gather. Defaults to 1.' },
      radius: { type: 'number', description: 'Search radius in blocks. Defaults to 48.' },
      wander: { type: 'boolean', description: 'Walk around looking for more when none are in range. Defaults to true.' },
      background: { type: 'boolean', description: 'Return immediately and gather asynchronously. Defaults to true.' },
      timeoutMs: { type: 'number', description: 'Maximum time to spend when `background` is false. Defaults to 180000.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          started: { type: 'boolean'},
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      session.requireOnline()
      const params = {
        block: String(args.block),
        count: Math.max(1, Math.round(Number(args.count ?? 1))),
        radius: Number(args.radius ?? 48),
        wander: args.wander !== false,
        resolve: name => agent.resolveBlock(name)
      }
      if (args.background === false) {
        // A previous long job is stopped rather than refusing the request: an
        // agent that asks for something new means it, and a task that was left
        // gathering would otherwise block every later call.
        await agent.tasks.replace()
        const task = agent.tasks.start('collect', params)
        await agent.tasks.wait(Number(args.timeoutMs ?? 180000))
        const status = agent.tasks.status()
        if (status?.status === 'running') {
          return {
            started: true,
            detail: `collection is still running after ${Math.round(Number(args.timeoutMs ?? 180000) / 1000)}s; ` +
              `progress: ${status.progress}. It continues in the background; check mc_task action=status.`
          }
        }
        return { started: true, detail: `collection finished: ${json(status?.result ?? { status: status?.status, error: status?.error })}` }
      }
      await agent.tasks.replace()
      const task = agent.tasks.start('collect', params)
      return {
        started: true,
        detail: `started task #${task.id}: collect ${params.count} x ${params.block} within ${params.radius} blocks.\n` +
          'Check mc_task action=status for progress, or keep chatting in the meantime.'
      }
    })
  })

  // ----------------------------------------------------------- mc_inventory
  agent.register(tools, {
    name: 'mc_inventory',
    description:
      'Inspect and manage carried items: list everything, check one item, drop items, or eat food.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'count', 'drop', 'eat'],
        required: true,
        description: 'Operation to perform.'
      },
      item: { type: 'string', description: 'Item identifier for `count` and `drop`.' },
      count: { type: 'number', description: 'How many to drop. Defaults to everything.' },
      filter: { type: 'string', description: 'Case-insensitive substring filter for `list`.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      session.requireOnline()
      const action = args.action ?? 'list'
      if (action === 'count') {
        const name = String(args.item ?? '').trim()
        if (name.length === 0) throw new Error('`item` is required for count')
        const item = await session.findInventoryItem(name)
        const count = item ? await session.countItem(name) : 0
        return {
          detail: item
            ? `${count} x ${item.name} in the inventory`
            : `no item matching "${name}" in the inventory. ` +
              'If the item is modded, the vanilla registry cannot name it; check mc_inventory action=list.'
        }
      }
      if (action === 'drop') {
        const name = String(args.item ?? '').trim()
        if (name.length === 0) throw new Error('`item` is required for drop')
        const result = await session.dropItem(name, args.count)
        return { detail: `dropped ${result.dropped} x ${result.name}` }
      }
      if (action === 'eat') {
        const result = await session.eat()
        const food = session.bot?.food ?? session.lastObservation?.food ?? 'unknown'
        return { detail: `ate ${result.ate}; food is now ${food}/20` }
      }
      // `inventorySummary` is synchronous on the protocol backend and async on
      // the bridge, so it is always awaited.
      const summary = await session.inventorySummary()
      const filter = String(args.filter ?? '').toLowerCase()
      const items = filter.length === 0
        ? summary.items
        : summary.items.filter(item => item.name.toLowerCase().includes(filter))
      const lines = [
        `${summary.usedSlots}/${summary.totalSlots} slots used (${summary.freeSlots} free)`,
        items.length === 0
          ? (filter.length === 0 ? 'the inventory is empty' : `nothing matches "${filter}"`)
          : items.map(item => `  ${item.name} x${item.count}`).join('\n'),
        '',
        'Vanilla names appear directly. A modded item that the protocol cannot name shows a numeric or generic name here; ' +
        'load a registry mapping with mc_control action=load_registry to name modded blocks.'
      ]
      return { detail: lines.join('\n') }
    })
  })

  // --------------------------------------------------------------- mc_build
  agent.register(tools, {
    name: 'mc_build',
    description:
      'Place blocks to build something, from an inline list, a shape generator, or a WorldEdit .schem / MCEdit .schematic file. ' +
      'Materials are checked before placing, then blocks are placed bottom-up and nearest-first. ' +
      'Shapes: wall, floor, box, hollow_box, tower, pyramid.',
    parameters: {
      source: {
        type: 'string',
        enum: ['list', 'shape', 'schematic'],
        required: true,
        description: 'Where the plan comes from.'
      },
      shape: { type: 'string', description: 'Generator name when `source` is `shape`.' },
      options: {
        type: 'object',
        additionalProperties: true,
        description: 'Generator parameters, for example {"width":7,"height":3,"block":"oak_planks"}.'
      },
      blocks: {
        type: 'array',
        description: 'Inline plan when `source` is `list`. Positions are relative to `origin`.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' },
            block: { type: 'string' }
          }
        }
      },
      path: { type: 'string', description: 'Schematic file path when `source` is `schematic`.' },
      origin: {
        type: 'string',
        description: 'World position for the plan\'s (0,0,0), as "x,y,z". Defaults to the block the bot is standing on.'
      },
      maxBlocks: { type: 'number', description: 'Place at most this many blocks this call. Defaults to 200.' },
      replace: { type: 'boolean', description: 'Break existing blocks at planned positions. Defaults to false.' },
      dryRun: { type: 'boolean', description: 'Only report the plan and material check, placing nothing.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          detail: { type: 'string'},
          placed: { type: 'number' }
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      session.requireOnline()
      const source = args.source ?? 'list'
      let blueprint
      if (source === 'shape') {
        blueprint = blueprintFromShape(args.shape, args.options ?? {})
      } else if (source === 'schematic') {
        const path = String(args.path ?? '').trim()
        if (path.length === 0) throw new Error('`path` is required when source is schematic')
        // The protocol client has a registry for legacy id mapping; the Forge
        // bridge does not need one because schematics there carry real names.
        blueprint = await blueprintFromFile(path, { registry: session.bot?.registry })
      } else {
        blueprint = blueprintFromList(args.blocks ?? [])
      }
      const origin = args.origin
        ? parseCoords(args.origin, 'origin')
        : (() => {
            // Both backends track the current position on the session, so the
            // plan anchors to wherever the client actually is.
            const position = session.origin ?? { x: 0, y: 0, z: 0 }
            return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
          })()
      if (args.dryRun) {
        const { checkMaterials } = await import('./build.js')
        const materials = await checkMaterials(session, blueprint)
        return {
          placed: 0,
          detail: [
            `plan: ${blueprint.name} (${blueprint.blocks.length} blocks, size ${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z}, source ${blueprint.source})`,
            `origin: ${origin.x},${origin.y},${origin.z}`,
            `materials: ${materials.needs} kinds, ${materials.complete ? 'all present' : 'SHORT'}`,
            ...materials.short.map(entry => `  missing ${entry.name}: need ${entry.need}, have ${entry.have}`),
            'dry run: nothing was placed'
          ].join('\n')
        }
      }
      const result = await buildBlueprint(session, blueprint, {
        origin,
        maxBlocks: Number(args.maxBlocks ?? 200),
        replace: args.replace === true,
        skipMissing: true
      })
      const lines = [
        `plan: ${blueprint.name} (${blueprint.blocks.length} planned, size ${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z})`,
        `origin: ${result.origin}`,
        `placed: ${result.placed}`,
        // A build that had nothing to do must say so, or it looks like a
        // silent failure to the model.
        result.note ?? null,
        result.remaining ? `remaining: ${result.remaining} (call mc_build again with the same origin to continue)` : null,
        result.materials.short.length > 0
          ? `materials short:\n${result.materials.short.map(entry => `  ${entry.name}: need ${entry.need}, have ${entry.have}`).join('\n')}`
          : 'materials: all present',
        result.failed.length > 0
          ? `failures (${result.failed.length}):\n${result.failed.slice(0, 12).map(entry => `  ${entry.name} at ${entry.x},${entry.y},${entry.z}: ${entry.reason}`).join('\n')}`
          : null
      ].filter(Boolean)
      return { placed: result.placed, detail: lines.join('\n') }
    })
  })

  // ---------------------------------------------------------------- mc_task
  agent.register(tools, {
    name: 'mc_task',
    description:
      `Manage the background task: status, wait, or cancel. Task kinds: ${TASK_KINDS.join(', ')}. ` +
      'A task keeps running while the bot chats, so long jobs do not block conversation.',
    parameters: {
      action: { type: 'string', enum: ['status', 'wait', 'cancel'], required: true, description: 'Task operation.' },
      timeoutMs: { type: 'number', description: 'For `wait`, the maximum time to block. Defaults to 60000.' },
      kind: { type: 'string', description: 'For `status` with no action running, start a new task of this kind.' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Parameters for a newly started task, for example {"block":"oak_log","count":32}.'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string'},
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const session = agent.ensureSession()
      const action = args.action ?? 'status'
      if (action === 'cancel') {
        const cancelled = agent.tasks.cancel()
        return { status: cancelled ? 'cancelled' : 'idle', detail: cancelled ? 'cancellation requested for the running task' : 'no task was running' }
      }
      if (action === 'wait') {
        const task = agent.tasks.current
        if (!task) return { status: 'idle', detail: 'no task is running' }
        await agent.tasks.wait(Number(args.timeoutMs ?? 60000))
        const status = agent.tasks.status()
        return {
          status: status?.status ?? 'idle',
          detail: `task ${status?.kind} is ${status?.status}: ${status?.progress}` +
            (status?.result ? `\nresult: ${json(status.result)}` : '')
        }
      }
      if (args.kind) {
        await agent.tasks.replace()
        const task = agent.tasks.start(String(args.kind), args.params ?? {})
        return { status: 'running', detail: `started task #${task.id} (${task.kind}): ${task.progress}` }
      }
      const status = agent.tasks.status()
      if (!status) {
        return {
          status: 'idle',
          detail: `no task is running. Available kinds: ${TASK_KINDS.join(', ')}.\n` +
            'Start one with mc_collect, mc_goto, or mc_task action=status kind=<kind> params={...}.'
        }
      }
      return {
        status: status.status,
        detail: [
          `task #${status.id} (${status.kind}) is ${status.status} after ${Math.round(status.elapsedMs / 1000)}s`,
          `progress: ${status.progress}`,
          status.error ? `error: ${status.error}` : null,
          status.events.length > 0 ? `recent steps:\n${status.events.slice(-10).map(entry => `  ${entry.text}`).join('\n')}` : null,
          status.result ? `result: ${json(status.result)}` : null
        ].filter(Boolean).join('\n')
      }
    })
  })

  // ------------------------------------------------------------- mc_control
  agent.register(tools, {
    name: 'mc_control',
    description:
      'Session plumbing: disconnect, load a modded block registry mapping, scan a Forge mods folder, ' +
      'read the Forge compatibility report, or work the client GUI (`screen`, `screen_click`, `open_world`) ' +
      'through the in-client bridge.',
    parameters: {
      action: {
        type: 'string',
        enum: ['disconnect', 'load_registry', 'scan_mods', 'forge_report', 'screen', 'screen_click', 'open_world'],
        required: true,
        description: 'Operation to perform.'
      },
      path: { type: 'string', description: 'File path for `load_registry`, or directory for `scan_mods`.' },
      text: {
        type: 'string',
        description: 'For `screen_click`: text to match against a button label or its translation key, such as "continue".'
      },
      index: { type: 'number', description: 'For `screen_click`: 0-based widget index instead of `text`.' },
      world: {
        type: 'string',
        description: 'For `open_world`: the singleplayer save folder name, such as "创造1".'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          detail: { type: 'string'}
        }
      },
      render: (_args, value) => textResult(value.detail)
    },
    execute: run(async args => {
      const action = args.action
      if (action === 'disconnect') {
        if (!agent.session) return { detail: 'no session to disconnect' }
        const result = await agent.session.disconnect('dsh agent requested')
        return { detail: result.disconnected ? `disconnected ${result.username} from ${result.address}` : 'no active session' }
      }
      // The three GUI actions only exist on the bridge backend, because a
      // protocol bot never sees the client's own screens.
      if (action === 'screen' || action === 'screen_click' || action === 'open_world') {
        const session = agent.ensureSession()
        if (typeof session.screen !== 'function') {
          throw new Error('the GUI actions need the Forge client bridge: call mc_join with backend="forge" first')
        }
        if (action === 'screen') {
          const screen = await session.screen()
          if (!screen.open) return { detail: 'no screen is open in the client' }
          const widgets = (screen.widgets ?? [])
            .map(widget => `  [${widget.index}] ${widget.label || '(unlabelled)'}` +
              `${widget.key ? ` (${widget.key})` : ''}${widget.clickable ? '' : ' - not a button'}`)
            .join('\n')
          return {
            detail: [
              `screen: ${screen.type} titled "${screen.title}"${screen.isContainer ? ' (a container GUI)' : ''}`,
              widgets.length > 0 ? `widgets:\n${widgets}` : 'the screen offers no widgets',
              'Click one with mc_control action=screen_click (text or index).'
            ].join('\n')
          }
        }
        if (action === 'screen_click') {
          const widgets = list => (list ?? [])
            .map(widget => `  ${widget.label || '(unlabelled)'}${widget.key ? ` [${widget.key}]` : ''}`)
            .join('\n')
          try {
            const reply = await session.clickScreen({
              text: String(args.text ?? '').trim() || undefined,
              index: args.index === undefined ? undefined : Number(args.index)
            })
            return {
              detail: [
                `clicked "${reply.clicked}" on ${reply.screen}`,
                reply.screenAfter ? `screen now: ${reply.screenAfter}` : null,
                (reply.widgets ?? []).length > 0 ? `widgets offered:\n${widgets(reply.widgets)}` : null
              ].filter(Boolean).join('\n')
            }
          } catch (error) {
            // "no-match" is a normal answer, not a failure: the bridge returns
            // the screen's whole widget list so the caller can pick one.
            if (error?.code !== 'no-match') throw error
            const offered = widgets(error.detail?.widgets)
            return {
              detail: [
                `no widget matched on ${error.detail?.screen ?? 'the open screen'}`,
                offered.length > 0 ? `widgets offered:\n${offered}` : 'the screen offers no widgets'
              ].join('\n')
            }
          }
        }
        const world = String(args.world ?? '').trim()
        if (world.length === 0) throw new Error('`world` is required for open_world')
        const reply = await session.openWorld(world)
        return {
          detail: `asked the client to open the world "${reply.world}"; loading is asynchronous, so poll mc_observe until a position appears`
        }
      }
      if (action === 'load_registry') {
        const path = String(args.path ?? '').trim()
        if (path.length === 0) throw new Error('`path` is required for load_registry')
        const loaded = await agent.mods.loadFile(path)
        agent.log.push('system', `loaded modded registry mapping from ${path} (${loaded.blocks} blocks)`)
        return {
          detail: [
            `loaded mapping from ${loaded.source}`,
            `blocks mapped: ${loaded.blocks}`,
            loaded.minStateId === null ? null : `first modded state id: ${loaded.minStateId}`,
            `mods discovered: ${loaded.mods}`,
            'Modded blocks are now addressable by name in mc_collect, mc_build, and mc_inventory.'
          ].filter(Boolean).join('\n')
        }
      }
      if (action === 'scan_mods') {
        const path = String(args.path ?? '').trim()
        if (path.length === 0) throw new Error('`path` is required for scan_mods')
        const scan = await scanModsDirectory(path)
        if (!scan.found) return { detail: `could not read the directory ${path}` }
        return {
          detail: [
            `scanned ${scan.dir}`,
            `${scan.files.length} jars, ${scan.mods.length} distinct mod ids`,
            scan.mods.slice(0, 120).join(', ') || 'no mod ids were declared',
            '',
            'Mod ids prove which mods the server runs, but Minecraft 1.20.1 never sends block ids to clients, ' +
            'so names still need a mapping file built from this mod list. That mapping is what mc_control action=load_registry expects.'
          ].join('\n')
        }
      }
      const report = agent.session?.forgeReport
      if (!report) {
        return { detail: 'no Forge report yet: connect with mc_join first, or run mc_control action=scan_mods path=<mods folder>.' }
      }
      if (report.transport === 'in-client Forge bridge') {
        return {
          detail: [
            `client: ${agent.session.address} through the in-client bridge (mod ${report.mod})`,
            `note: ${report.note}`,
            '',
            `registry mapping: ${json(agent.mods.report())}`,
            'This backend needs no mapping file: the client resolves every modded block and item itself.'
          ].join('\n')
        }
      }
      return {
        detail: [
          `server: ${report.address} (protocol version ${report.version})`,
          `forge plugin channels: ${report.detected ? report.channels.join(', ') || 'present' : 'none observed'}`,
          `negotiation: ${report.negotiation}`,
          `note: ${report.note}`,
          '',
          `registry mapping: ${json(agent.mods.report())}`
        ].join('\n')
      }
    })
  })

  // ---------------------------------------------------------- prompt section
  // `systemPrompt` is an optional service: Cordis throws on direct property
  // access for anything not declared in `inject`, so it must be read through
  // `ctx.get` with an explicit undefined check.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    systemPrompt.section({
      name: 'minecraft-agent',
      order: SECTION_ORDER,
      text: () => {
        const session = agent.session
        const lines = [
          '# Minecraft agent',
          '',
          'This session can drive one Minecraft bot through the `mc_*` tools.',
          '`mc_join backend=forge` attaches to the control bridge inside a real Forge client on this machine,',
          'where every block and item keeps its true registry name, modded content included. Giving an',
          '`address` instead dials a server over the vanilla protocol, which cannot name modded content.',
          'With neither given the bridge is tried first. If the client sits on a start-up warning screen,',
          '`mc_control action=screen` lists its buttons; `screen_click` presses one and `open_world` loads a save.',
          'Flow: `mc_join` to connect, `mc_observe` to look around, `mc_chat` to talk,',
          '`mc_collect` to gather, `mc_build` to place blocks, `mc_task` to watch long jobs,',
          '`mc_control` for session plumbing and the client GUI.',
          '',
          'Long jobs run in the background, so answer players while they run instead of blocking on them.',
          'Never claim a build, harvest, or message succeeded without a tool result that says so.'
        ]
        if (session) {
          lines.push('', `Current bot status: ${session.statusLine()}`)
          const pending = [...session.mentions.values()].filter(entry => !entry.replied)
          if (pending.length > 0) {
            lines.push(`Unanswered in-game messages from: ${pending.map(entry => entry.name).join(', ')}`)
          }
        }
        return lines.join('\n')
      }
    })
  }
}
