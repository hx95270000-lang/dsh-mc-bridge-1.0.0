/**
 * DSH bundle entry: the Minecraft agent plugin.
 *
 * Registers the `mc_*` tool family, an ordered prompt section describing the
 * capability, and a lifecycle hook that releases the bot and every tool
 * registration when the plugin is unloaded or reloaded.
 *
 * The shared {@link AgentContext} is stashed on `globalThis` under a symbol so a
 * hot reload reuses the live bot session instead of spawning a second one.
 *
 * Two backends are available at connect time: a protocol client for vanilla
 * servers, and the in-client control bridge for a single-player world or a
 * Forge server, where modded registries only exist inside a real client.
 */

import { AgentContext, registerTools } from './lib/tools.js'

/** Symbol key for the process-wide agent context. */
const AGENT_KEY = Symbol.for('dsh.mc-agent.context')

/** Stable Loader identity. */
export const name = 'mc-agent'

/** Services this plugin needs before it can register anything. */
export const inject = ['tools']

/**
 * Declarative configuration schema.
 *
 * The Loader validates a row through the Standard Schema interface
 * (`Config['~standard'].validate`), so this is written directly instead of
 * pulling in a schema library. Defaults are applied here, and every field is
 * coerced, which keeps a hand-written `cordis.patch.yml` forgiving.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mc-agent',
    /**
     * Validate and normalise a raw row configuration.
     * @param value - Raw configuration, however malformed.
     * @returns `{ value }` with resolved defaults, or `{ issues }`.
     */
    validate (value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'mc-agent config must be an object', path: [] }] }
      }
      const issues = []
      const string = (key, fallback) => {
        const candidate = raw[key]
        if (candidate === undefined || candidate === null) return fallback
        if (typeof candidate !== 'string') {
          issues.push({ message: `${key} must be a string`, path: [key] })
          return fallback
        }
        return candidate
      }
      const auth = string('defaultAuth', 'offline')
      if (auth !== 'offline' && auth !== 'microsoft') {
        issues.push({ message: "defaultAuth must be 'offline' or 'microsoft'", path: ['defaultAuth'] })
      }
      let maxLogLines = 400
      if (raw.maxLogLines !== undefined && raw.maxLogLines !== null) {
        const numeric = Number(raw.maxLogLines)
        if (!Number.isFinite(numeric) || numeric < 20) {
          issues.push({ message: 'maxLogLines must be a number of at least 20', path: ['maxLogLines'] })
        } else {
          maxLogLines = Math.round(numeric)
        }
      }
      let bridgePort = 25577
      if (raw.bridgePort !== undefined && raw.bridgePort !== null) {
        const numeric = Number(raw.bridgePort)
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
          issues.push({ message: 'bridgePort must be a TCP port between 1 and 65535', path: ['bridgePort'] })
        } else {
          bridgePort = numeric
        }
      }
      if (issues.length > 0) return { issues }
      return {
        value: {
          defaultUsername: string('defaultUsername', 'DSH_Agent'),
          defaultVersion: string('defaultVersion', '1.20.1'),
          defaultAuth: auth === 'microsoft' ? 'microsoft' : 'offline',
          maxLogLines,
          autoConnect: string('autoConnect', ''),
          // Where the in-client Forge bridge listens; see mc_join backend=forge.
          bridgeHost: string('bridgeHost', '127.0.0.1'),
          bridgePort
        }
      }
    }
  }
}

/**
 * Activate the plugin.
 * @param ctx - Cordis plugin context.
 * @param config - Resolved row configuration.
 */
export function apply (ctx, config = {}) {
  const existing = globalThis[AGENT_KEY]
  const agent = existing instanceof AgentContext ? existing : new AgentContext(config)
  // A hot reload re-enters apply with a fresh row config; reuse the live
  // context so an in-flight bot session survives the reload.
  agent.config = resolveConfig(config)
  globalThis[AGENT_KEY] = agent
  registerTools(ctx, agent)

  // Release the bot and every tool registration when this plugin unloads.
  ctx.effect(() => () => {
    if (globalThis[AGENT_KEY] === agent) delete globalThis[AGENT_KEY]
    void agent.close()
  })

  if (agent.config.autoConnect.length > 0) {
    const target = agent.config.autoConnect
    const inlinePort = /:(\d{2,5})$/.exec(target)
    const session = agent.ensureSession()
    session.address = inlinePort ? target.slice(0, -inlinePort[0].length) : target
    session.port = inlinePort ? Number(inlinePort[1]) : 25565
    session.connect()
      .then(() => agent.log.push('system', `auto-connect to ${target} succeeded`))
      .catch(error => agent.log.push('error', `auto-connect to ${target} failed: ${error instanceof Error ? error.message : error}`))
  }

  agent.log.push('system', `Minecraft agent ready (default ${agent.config.defaultVersion}, ` +
    `auth ${agent.config.defaultAuth}, user ${agent.config.defaultUsername})`)
}

/**
 * Validate a raw row configuration through the exported schema.
 *
 * The Loader validates before activation, but `apply` resolves its own values as
 * well so defaults hold no matter how the plugin was mounted.
 * @param config - Raw row configuration.
 * @returns A complete configuration.
 */
function resolveConfig (config) {
  let result
  try {
    result = Config['~standard'].validate(config ?? {})
  } catch {
    result = { issues: [{ message: 'invalid config' }] }
  }
  if (result.issues) {
    const detail = result.issues.map(issue => `${issue.path?.join('.') ?? ''} ${issue.message}`.trim()).join('; ')
    throw new Error(`mc-agent configuration is invalid: ${detail}`)
  }
  return result.value
}
