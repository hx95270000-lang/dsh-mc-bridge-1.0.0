/**
 * Transport for the Forge control bridge.
 *
 * The companion mod runs inside a real Forge client and serves newline-delimited
 * JSON over localhost. Because that client has every mod loaded, blocks and items
 * are addressed by their true registry names — which is the whole reason this
 * transport exists next to the protocol client.
 *
 * Requests carry a `gen` (generation) number so a reply can never be mistaken for
 * the answer to a different request, and the socket reconnects on demand rather
 * than failing permanently.
 */

import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Default port the mod listens on. */
const DEFAULT_PORT = 25577
/** How long a single request may take before the caller gives up. */
const DEFAULT_TIMEOUT_MS = 15000

export class BridgeError extends Error {
  /**
   * @param message - Human-readable description.
   * @param code - Machine-readable code from the bridge.
   * @param detail - Extra fields from the reply.
   */
  constructor (message, code, detail) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

export class BridgeClient {
  /**
   * @param options - Connection options.
   */
  constructor (options = {}) {
    /** @type {string} */
    this.host = options.host ?? '127.0.0.1'
    /** @type {number} */
    this.port = Number(options.port ?? DEFAULT_PORT)
    /** @type {net.Socket|null} */
    this.socket = null
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** @type {number} Monotonic request generation. */
    this.generation = 0
    /** @type {Array<{ text: string, at: number }>} Unsolicited log lines from the bridge. */
    this.notices = []
    /** @type {Array<(notice: object) => void>} */
    this.noticeWatchers = new Set()
    /** @type {boolean} */
    this.connecting = false
  }

  /** Whether a socket is currently open. */
  get connected () {
    return this.socket !== null && !this.socket.destroyed && this.socket.readyState === 'open'
  }

  /**
   * Locate the bridge by reading the status file the mod writes on startup.
   *
   * @param gameDir - The client's game directory.
   * @returns The discovered port, or null when the file is absent.
   */
  static async discoverPort (gameDir) {
    try {
      const raw = await readFile(join(gameDir, 'dsh-bridge', 'status.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed.port === 'number' && parsed.port > 0) return parsed.port
      return null
    } catch {
      return null
    }
  }

  /**
   * Open the socket, reusing an existing connection when possible.
   * @param timeoutMs - Connection timeout.
   * @returns This client.
   */
  async connect (timeoutMs = 5000) {
    if (this.connected) return this
    if (this.connecting) {
      while (this.connecting) await new Promise(resolve => setTimeout(resolve, 25))
      if (this.connected) return this
    }
    this.connecting = true
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: this.host, port: this.port })
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new BridgeError(
            `the Forge bridge at ${this.host}:${this.port} did not accept a connection. ` +
            'Start the headless client with the bridge mod installed, or check dsh-bridge/status.json in the game directory.',
            'connect-timeout'
          ))
        }, timeoutMs)

        socket.once('connect', () => {
          clearTimeout(timer)
          socket.setNoDelay(true)
          this.socket = socket
          this.#attach(socket)
          resolve()
        })
        socket.once('error', error => {
          clearTimeout(timer)
          reject(new BridgeError(
            `cannot reach the Forge bridge at ${this.host}:${this.port}: ${error.message}`,
            'connect-failed'
          ))
        })
      })
      return this
    } finally {
      this.connecting = false
    }
  }

  /**
   * Wire up socket event handling.
   * @param socket - The connected socket.
   */
  #attach (socket) {
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      let newline
      while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
        const line = this.buffer.subarray(0, newline).toString('utf8').trim()
        this.buffer = this.buffer.subarray(newline + 1)
        if (line.length > 0) this.#handleLine(line)
      }
    })
    socket.on('error', error => this.#failAll(`bridge socket error: ${error.message}`))
    socket.on('close', () => {
      this.socket = null
      this.#failAll('the bridge connection closed')
    })
  }

  /**
   * Route one reply line to its waiting caller.
   * @param line - One JSON line.
   */
  #handleLine (line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const gen = message.gen
    if (gen === undefined || !this.pending.has(gen)) {
      // Not a reply to anything we sent: keep it as a notice for diagnostics.
      this.notices.push({ text: line, at: Date.now() })
      if (this.notices.length > 200) this.notices.splice(0, this.notices.length - 200)
      for (const watcher of this.noticeWatchers) {
        try {
          watcher(message)
        } catch {
          /* a failing observer must not break the client */
        }
      }
      return
    }
    const entry = this.pending.get(gen)
    this.pending.delete(gen)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  /**
   * Reject every in-flight request, used when the socket goes away.
   * @param reason - Why the requests failed.
   */
  #failAll (reason) {
    for (const [gen, entry] of this.pending) {
      this.pending.delete(gen)
      clearTimeout(entry.timer)
      entry.reject(new BridgeError(reason, 'disconnected'))
    }
  }

  /**
   * Send one request and await its reply.
   * @param request - Request fields; `op` is required.
   * @param timeoutMs - Per-request timeout.
   * @returns The reply payload, with `ok` stripped.
   */
  async request (request, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.connect()
    const gen = ++this.generation
    const payload = `${JSON.stringify({ ...request, gen })}\n`

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(gen)
        reject(new BridgeError(
          `the bridge did not answer "${request.op}" within ${timeoutMs} ms; ` +
          'the client may be paused, loading, or blocked on its tick thread',
          'timeout'
        ))
      }, timeoutMs)
      this.pending.set(gen, { resolve, reject, timer })
      try {
        this.socket.write(payload)
      } catch (error) {
        this.pending.delete(gen)
        clearTimeout(timer)
        reject(new BridgeError(`failed to send "${request.op}": ${error.message}`, 'write-failed'))
      }
    }).then(reply => {
      if (reply.ok === false) {
        throw new BridgeError(reply.message ?? `bridge rejected ${request.op}`, reply.error ?? 'rejected', reply)
      }
      const { ok, gen: _ignored, ...rest } = reply
      return rest
    })
  }

  /**
   * Register a listener for unsolicited bridge messages.
   * @param watcher - Called with each non-reply message.
   * @returns A disposer.
   */
  onNotice (watcher) {
    this.noticeWatchers.add(watcher)
    return () => this.noticeWatchers.delete(watcher)
  }

  /** Close the socket and release the port. */
  close () {
    this.#failAll('the bridge client was closed')
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* already gone */
      }
      this.socket = null
    }
  }

  // ------------------------------------------------------------- operations

  /** Round-trip health check, including the mod's own queue depth. */
  ping () {
    return this.request({ op: 'ping' }, 5000)
  }

  /**
   * World snapshot from the real client, with true registry names.
   * @param options - `radius`, `vertical`, `blockLimit`.
   */
  observe (options = {}) {
    return this.request({
      op: 'observe',
      radius: options.radius ?? 12,
      vertical: options.vertical ?? 6,
      blockLimit: options.blockLimit ?? 60
    }, 30000)
  }

  /**
   * Exact, registry-accurate block search over the client's loaded chunks.
   * @param options - `block` or `blocks`, `radius`, `count`.
   * @returns `{ matches: [...], scanned }`.
   */
  findBlock (options) {
    return this.request({
      op: 'find_block',
      block: options.block,
      blocks: options.blocks,
      radius: options.radius ?? 32,
      vertical: options.vertical ?? 16,
      count: options.count ?? 16
    }, 60000)
  }

  /**
   * Read the block at one position, by true registry name.
   * @param x - X coordinate.
   * @param y - Y coordinate.
   * @param z - Z coordinate.
   * @returns `{ block, air, replaceable, solid, hardness }`.
   */
  blockAt (x, y, z) {
    return this.request({ op: 'block_at', x, y, z }, 15000)
  }

  /** Entities within a radius. */
  nearby (options = {}) {
    return this.request({ op: 'nearby', radius: options.radius ?? 32, kind: options.kind })
  }

  /** Chat lines newer than a cursor. */
  chatLog (since) {
    return this.request({ op: 'chat_log', since: since ?? 0 }, 10000)
  }

  /** Client-side diagnostics. */
  stats () {
    return this.request({ op: 'stats' }, 10000)
  }

  /** Inventory contents and totals. */
  inventory () {
    return this.request({ op: 'inventory' }, 10000)
  }

  /** Send a chat line or run a command (leading slash). */
  chat (message) {
    return this.request({ op: 'chat', message }, 10000)
  }

  /** Point the camera at a position. */
  look (x, y, z) {
    return this.request({ op: 'look', x, y, z }, 10000)
  }

  /** Select a hotbar slot 0..8. */
  selectSlot (slot) {
    return this.request({ op: 'select_slot', slot }, 10000)
  }

  /**
   * Put an item into the player's hand, wherever it sits in the inventory.
   *
   * The client moves the stack into the hotbar itself when needed, the same way
   * a player would before placing a block.
   * @param item - Item id, with or without a namespace.
   */
  selectItem (item) {
    return this.request({ op: 'select_item', item }, 15000)
  }

  /** Begin walking toward a position; returns as soon as the walk starts. */
  goto (x, y, z, options = {}) {
    return this.request({
      op: 'goto',
      x,
      y,
      z,
      range: options.range ?? 1.5,
      maxTicks: options.maxTicks ?? 400
    }, 10000)
  }

  /** Progress of the current walk. */
  walkStatus () {
    return this.request({ op: 'walk_status' }, 10000)
  }

  /** Stop walking. */
  stopWalk () {
    return this.request({ op: 'stop_walk' }, 10000)
  }

  /** Start breaking one block. */
  dig (x, y, z) {
    return this.request({ op: 'dig', x, y, z }, 15000)
  }

  /** Place the held block at a position. */
  place (x, y, z) {
    return this.request({ op: 'place', x, y, z }, 15000)
  }

  /** Drop items by id. */
  drop (item, count) {
    return this.request({ op: 'drop', item, count }, 10000)
  }

  /** Attack or interact with an entity. */
  use (id) {
    return this.request({ op: 'use', id }, 10000)
  }

  /** What GUI, if any, is open. */
  screen () {
    return this.request({ op: 'screen' }, 10000)
  }

  /**
   * Click a widget on the open screen.
   * @param options - `text` to match the label or translation key, or `index`.
   */
  screenClick (options = {}) {
    return this.request({ op: 'screen_click', text: options.text, index: options.index }, 10000)
  }

  /**
   * Load a singleplayer world by folder name, the way the world list does.
   *
   * The mod answers before the level is built, so this returns quickly even
   * though the world itself takes as long as the modpack needs.
   * @param world - Save folder name.
   */
  openWorld (world) {
    return this.request({ op: 'open_world', world }, 60000)
  }
}
