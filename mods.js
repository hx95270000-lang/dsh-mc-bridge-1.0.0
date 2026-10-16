/**
 * Modded content awareness.
 *
 * Minecraft 1.20.1 predates the synchronised registry: the server sends no
 * block or item registry to the client, because a real Forge client already
 * loaded the same mods from disk. A protocol client therefore sees modded
 * content as raw numeric state ids.
 *
 * This module closes that gap where it can be closed:
 * - a mapping file lets a user teach the agent the ids a server uses, so
 *   modded blocks become addressable by name;
 * - installed mod jars are scanned for their mod ids, which gives an accurate
 *   "what is this server running" report and a starting point for mapping.
 *
 * Everything degrades gracefully: with no mapping, vanilla content still works
 * completely and modded content is reported by id rather than misnamed.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * Read the little-endian unsigned integers out of a buffer.
 * @param buffer - Source buffer.
 * @param offset - Byte offset.
 * @param size - 2 or 4 bytes.
 * @returns The value.
 */
function readUInt (buffer, offset, size) {
  return size === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset)
}

/**
 * Extract one entry from a ZIP archive held in memory.
 *
 * Implemented directly rather than through a dependency: only
 * `META-INF/mods.toml` and `META-INF/MANIFEST.MF` are ever read.
 * @param buffer - The whole archive.
 * @param wanted - Entry names to look for.
 * @returns A map of found entry name to UTF-8 text.
 */
function readZipEntries (buffer, wanted) {
  const results = new Map()
  // Locate the end-of-central-directory record.
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return results
  const entryCount = readUInt(buffer, eocd + 10, 2)
  let cursor = readUInt(buffer, eocd + 16, 4)
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break
    const method = readUInt(buffer, cursor + 10, 2)
    const compressedSize = readUInt(buffer, cursor + 20, 4)
    const nameLength = readUInt(buffer, cursor + 28, 2)
    const extraLength = readUInt(buffer, cursor + 30, 2)
    const commentLength = readUInt(buffer, cursor + 32, 2)
    const localOffset = readUInt(buffer, cursor + 42, 4)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (!wanted.includes(name)) continue
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue
    const localNameLength = readUInt(buffer, localOffset + 26, 2)
    const localExtraLength = readUInt(buffer, localOffset + 28, 2)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    try {
      results.set(name, method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8'))
    } catch {
      /* a corrupt or unsupported entry is simply skipped */
    }
  }
  return results
}

/**
 * Pull `modId` values out of a `mods.toml`.
 *
 * The file is TOML, but the only field that matters is a single-quoted or
 * double-quoted `modId`, so a narrow scan is used instead of a TOML parser.
 * @param toml - File contents.
 * @returns Mod ids in declaration order.
 */
function parseModIds (toml) {
  const ids = []
  const pattern = /^\s*modId\s*=\s*["']([^"']+)["']/gm
  let match
  while ((match = pattern.exec(toml)) !== null) ids.push(match[1])
  return ids
}

/**
 * Scan a directory of Forge mods for the mod ids they declare.
 * @param modsDir - Directory holding `.jar` files.
 * @returns Mod ids and per-file detail.
 */
export async function scanModsDirectory (modsDir) {
  let entries
  try {
    entries = await readdir(modsDir, { withFileTypes: true })
  } catch {
    return { dir: modsDir, found: false, mods: [], files: [] }
  }
  const mods = new Set()
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
    const path = join(modsDir, entry.name)
    try {
      const info = await stat(path)
      const buffer = await readFile(path)
      const texts = readZipEntries(buffer, ['META-INF/mods.toml', 'META-INF/MANIFEST.MF'])
      const toml = texts.get('META-INF/mods.toml') ?? ''
      const ids = parseModIds(toml)
      const manifest = texts.get('META-INF/MANIFEST.MF') ?? ''
      const manifestId = /Implementation-Title:\s*(.+)/i.exec(manifest)?.[1]?.trim()
      const declared = ids.length > 0 ? ids : (manifestId ? [manifestId] : [])
      for (const id of declared) mods.add(id)
      files.push({
        file: entry.name,
        bytes: info.size,
        mods: declared,
        hasModsToml: toml.length > 0
      })
    } catch (error) {
      files.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { dir: modsDir, found: true, mods: [...mods].sort(), files }
}

/**
 * Mapping between modded numeric ids and block/item names.
 *
 * The accepted file shapes, all merged, are:
 * - `{ "blocks": { "1234": "create:cogwheel" } }`
 * - `{ "blocksByName": { "create:cogwheel": 1234 } }`
 * - `{ "minStateId": 1000 }` to declare where modded ids begin
 */
export class ModRegistry {
  /**
   * @param options - Session context.
   */
  constructor (options = {}) {
    /** @type {Map<number, string>} state id to block name. */
    this.byId = new Map()
    /** @type {Map<string, number>} block name to state id. */
    this.byName = new Map()
    /** @type {string|null} Where the mapping came from. */
    this.source = null
    /** @type {number|null} Declared first modded state id. */
    this.minStateId = null
    /** @type {Set<number>} State ids the world reported that nothing could name. */
    this.unknownIds = new Set()
    /** @type {object|null} Last mod-jar scan. */
    this.scan = null
  }

  /**
   * Load a mapping file, replacing any previous mapping.
   * @param path - JSON file path.
   * @returns What was loaded.
   */
  async loadFile (path) {
    const text = await readFile(path, 'utf8')
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error(`registry mapping at ${path} is not valid JSON: ${error instanceof Error ? error.message : error}`)
    }
    this.byId.clear()
    this.byName.clear()
    const blocks = data.blocks ?? {}
    for (const [id, name] of Object.entries(blocks)) {
      const numeric = Number(id)
      if (!Number.isFinite(numeric)) continue
      const value = String(name)
      this.byId.set(numeric, value)
      this.byName.set(value, numeric)
      this.byName.set(value.replace(/^[^:]+:/, ''), numeric)
    }
    for (const [name, id] of Object.entries(data.blocksByName ?? {})) {
      const numeric = Number(id)
      if (!Number.isFinite(numeric)) continue
      this.byId.set(numeric, name)
      this.byName.set(name, numeric)
      this.byName.set(name.replace(/^[^:]+:/, ''), numeric)
    }
    if (data.minStateId !== undefined) this.minStateId = Number(data.minStateId)
    if (typeof data.modsDir === 'string') this.scan = await scanModsDirectory(data.modsDir)
    this.source = path
    return {
      source: path,
      blocks: this.byId.size,
      minStateId: this.minStateId,
      mods: this.scan?.mods?.length ?? 0
    }
  }

  /**
   * Look up a modded block name.
   * @param name - Block identifier with or without a namespace.
   * @returns The state id, or undefined.
   */
  idOf (name) {
    const raw = String(name ?? '').trim().toLowerCase()
    if (raw.length === 0) return undefined
    return this.byName.get(raw) ?? this.byName.get(raw.replace(/^[^:]+:/, ''))
  }

  /**
   * Resolve a modded state id to a name.
   * @param id - Numeric state id.
   * @returns The mapped name, or undefined.
   */
  nameOf (id) {
    return this.byId.get(Number(id))
  }

  /**
   * Note a state id that no registry could name.
   * @param id - Numeric state id.
   */
  noteUnknown (id) {
    if (this.unknownIds.size < 512) this.unknownIds.add(Number(id))
  }

  /**
   * A report describing the mapping state.
   * @returns A JSON-friendly summary.
   */
  report () {
    return {
      mapped: this.byId.size,
      source: this.source,
      minStateId: this.minStateId,
      unknownStateIdsSeen: [...this.unknownIds].slice(0, 40),
      unknownCount: this.unknownIds.size,
      modsDirectory: this.scan
        ? { dir: this.scan.dir, found: this.scan.found, modCount: this.scan.mods.length, mods: this.scan.mods.slice(0, 80) }
        : null,
      guidance: this.byId.size === 0
        ? 'Modded blocks are visible only as state ids. To address them by name, write a JSON mapping ' +
          '({"blocks":{"<stateId>":"modid:block_name"}}) and load it with mc_control action=load_registry.'
        : null
    }
  }
}
