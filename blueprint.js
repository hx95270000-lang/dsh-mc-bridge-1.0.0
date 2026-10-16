/**
 * Blueprint parsing and generation.
 *
 * A blueprint is a version-independent list of (position, block name) pairs.
 * Three sources produce one:
 * - an inline JSON list the model writes directly,
 * - a shape generator (`wall`, `floor`, `box`, `tower`, ...),
 * - a WorldEdit `.schem` or legacy MCEdit `.schematic` file.
 *
 * Placement itself lives in `build.js`; this module only turns intent into
 * geometry, so every shape can be unit-tested without a server.
 */

import { readFile } from 'node:fs/promises'
import { parseCoords } from './text.js'

/**
 * A single placement instruction.
 * @typedef {{ x: number, y: number, z: number, block: string }} BlueprintBlock
 */

/**
 * A complete build plan.
 * @typedef {{
 *   name: string,
 *   size: { x: number, y: number, z: number },
 *   blocks: BlueprintBlock[],
 *   source: string,
 *   palette?: Record<string, number>
 * }} Blueprint
 */

export { parseCoords }

/**
 * Normalise an inline blueprint list.
 * @param blocks - Rows of `{ x, y, z, block }`.
 * @param name - Blueprint name.
 * @returns A blueprint.
 */
export function blueprintFromList (blocks, name = 'inline') {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('a blueprint needs at least one block')
  }
  const parsed = blocks.map((entry, index) => {
    const block = String(entry.block ?? entry.name ?? entry.type ?? '').trim()
    if (block.length === 0) throw new Error(`blueprint block #${index} has no block name`)
    return {
      x: Math.round(Number(entry.x ?? 0)),
      y: Math.round(Number(entry.y ?? 0)),
      z: Math.round(Number(entry.z ?? 0)),
      block
    }
  })
  return withSize(parsed, name, 'inline')
}

/**
 * Attach the bounding size to a parsed block list.
 * @param blocks - Parsed blocks.
 * @param name - Blueprint name.
 * @param source - Where the blueprint came from.
 * @param palette - Optional palette from a schematic.
 * @returns A blueprint.
 */
function withSize (blocks, name, source, palette) {
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const block of blocks) {
    if (block.x > maxX) maxX = block.x
    if (block.y > maxY) maxY = block.y
    if (block.z > maxZ) maxZ = block.z
  }
  return {
    name,
    size: { x: maxX + 1, y: maxY + 1, z: maxZ + 1 },
    blocks,
    source,
    ...(palette === undefined ? {} : { palette })
  }
}

/**
 * Build a blueprint from a named shape generator.
 * @param shape - Generator name.
 * @param options - Generator parameters.
 * @returns A blueprint.
 */
export function blueprintFromShape (shape, options = {}) {
  const generators = {
    wall: shapeWall,
    floor: shapeFloor,
    box: shapeBox,
    hollow_box: shapeHollowBox,
    tower: shapeTower,
    pyramid: shapePyramid,
    platform: shapeFloor,
    pillar: shapeTower
  }
  const generator = generators[String(shape ?? '').toLowerCase()]
  if (!generator) {
    throw new Error(`unknown shape "${shape}". Available shapes: ${Object.keys(generators).join(', ')}`)
  }
  return generator(options)
}

/**
 * Require a positive integer size field.
 * @param value - Raw value.
 * @param fallback - Used when the value is absent.
 * @param label - Field name.
 * @returns A positive integer.
 */
function size (value, fallback, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(number) || number < 1) throw new Error(`${label} must be a positive number`)
  return Math.round(number)
}

/**
 * A flat rectangular layer.
 * @param options - `width`, `length`, `block`, `y`.
 * @returns A blueprint.
 */
function shapeFloor (options) {
  const width = size(options.width, 5, 'width')
  const length = size(options.length ?? options.depth, 5, 'length')
  const block = String(options.block ?? 'stone')
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) blocks.push({ x, y: 0, z, block })
  }
  return withSize(blocks, options.name ?? `floor_${width}x${length}`, 'shape:floor')
}

/**
 * An upright wall along the X axis.
 * @param options - `width`, `height`, `block`, `thickness`.
 * @returns A blueprint.
 */
function shapeWall (options) {
  const width = size(options.width, 5, 'width')
  const height = size(options.height, 3, 'height')
  const thickness = size(options.thickness, 1, 'thickness')
  const block = String(options.block ?? 'stone_bricks')
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < thickness; z++) blocks.push({ x, y, z, block })
    }
  }
  return withSize(blocks, options.name ?? `wall_${width}x${height}`, 'shape:wall')
}

/**
 * A solid rectangular volume.
 * @param options - `width`, `height`, `length`, `block`.
 * @returns A blueprint.
 */
function shapeBox (options) {
  const width = size(options.width, 3, 'width')
  const height = size(options.height, 3, 'height')
  const length = size(options.length ?? options.depth, 3, 'length')
  const block = String(options.block ?? 'stone')
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) blocks.push({ x, y, z, block })
    }
  }
  return withSize(blocks, options.name ?? `box_${width}x${height}x${length}`, 'shape:box')
}

/**
 * A hollow rectangular shell, optionally with a different material per face.
 * @param options - `width`, `height`, `length`, `block`, `floorBlock`.
 * @returns A blueprint.
 */
function shapeHollowBox (options) {
  const width = size(options.width, 5, 'width')
  const height = size(options.height, 3, 'height')
  const length = size(options.length ?? options.depth, 5, 'length')
  const block = String(options.block ?? 'oak_planks')
  const floorBlock = String(options.floorBlock ?? block)
  const roofBlock = String(options.roofBlock ?? block)
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        const onEdge = x === 0 || x === width - 1 || z === 0 || z === length - 1
        const onFloor = y === 0
        const onRoof = y === height - 1
        if (!onEdge && !onFloor && !onRoof) continue
        const material = onFloor ? floorBlock : onRoof ? roofBlock : block
        blocks.push({ x, y, z, block: material })
      }
    }
  }
  return withSize(blocks, options.name ?? `hollow_box_${width}x${height}x${length}`, 'shape:hollow_box')
}

/**
 * A square tower.
 * @param options - `width`, `height`, `block`.
 * @returns A blueprint.
 */
function shapeTower (options) {
  const width = size(options.width, 3, 'width')
  const height = size(options.height, 8, 'height')
  const block = String(options.block ?? 'stone_bricks')
  const blocks = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < width; z++) blocks.push({ x, y, z, block })
    }
  }
  return withSize(blocks, options.name ?? `tower_${width}x${height}`, 'shape:tower')
}

/**
 * A square step pyramid.
 * @param options - `base`, `height`, `block`.
 * @returns A blueprint.
 */
function shapePyramid (options) {
  const base = size(options.base, 7, 'base')
  const height = size(options.height, Math.ceil(base / 2), 'height')
  const block = String(options.block ?? 'sandstone')
  const blocks = []
  for (let y = 0; y < height; y++) {
    const inset = y
    const span = base - inset * 2
    if (span <= 0) break
    for (let x = 0; x < span; x++) {
      for (let z = 0; z < span; z++) blocks.push({ x: x + inset, y, z: z + inset, block })
    }
  }
  return withSize(blocks, options.name ?? `pyramid_${base}`, 'shape:pyramid')
}

/**
 * Read and decode a schematic file.
 *
 * Supports the modern sponge/WorldEdit `.schem` layout and the legacy MCEdit
 * `.schematic` layout. Block state ids are resolved through the connected
 * server's registry when one is available, so modded palettes resolve to their
 * real names whenever the registry knows them.
 * @param path - File path.
 * @param options - `registry` (a Mineflayer registry) and `version` for offline decoding.
 * @returns A blueprint.
 */
export async function blueprintFromFile (path, options = {}) {
  const buffer = await readFile(path)
  const nbt = await import('prismarine-nbt')
  const parse = nbt.parseUncompressed ?? nbt.default?.parseUncompressed
  if (typeof parse !== 'function') throw new Error('prismarine-nbt could not be loaded')
  const result = await parse(buffer)
  // `parseUncompressed` returns the tree itself; older shapes nest it under `parsed`.
  const root = result?.parsed ?? result
  const flat = root?.value ?? root
  const data = flat?.Schematic?.value ?? flat?.schem?.value ?? flat
  if (!data) throw new Error(`${path} is not a readable NBT schematic`)
  const name = String(path).split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'schematic'
  if (data.Palette ?? data.palette) return decodeModern(data, name, path)
  if (data.Width !== undefined || data.width !== undefined) return decodeLegacy(data, name, path, options)
  throw new Error(`${path} is missing both a modern palette and legacy dimensions`)
}

/**
 * Read a plain integer from a possibly-wrapped NBT tag.
 * @param value - Tag value.
 * @returns The number, or undefined.
 */
function num (value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && 'value' in value) return num(value.value)
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read a tag that may hold an array of values.
 * @param tag - Possibly wrapped tag.
 * @returns A plain array.
 */
function arr (tag) {
  if (tag === undefined || tag === null) return []
  if (Array.isArray(tag)) return tag
  if (Array.isArray(tag.value)) return tag.value
  return []
}

/**
 * Decode the modern `.schem` format (palette + varint block data).
 * @param data - NBT compound value.
 * @param name - Blueprint name.
 * @param path - Source path for diagnostics.
 * @returns A blueprint.
 */
function decodeModern (data, name, path) {
  const width = num(data.Width ?? data.width) ?? 0
  const height = num(data.Height ?? data.height) ?? 0
  const length = num(data.Length ?? data.length) ?? 0
  const paletteTag = (data.Palette ?? data.palette)?.value ?? data.Palette ?? data.palette ?? {}
  const paletteEntries = Object.entries(paletteTag).map(([key, value]) => [key, num(value) ?? 0])
  const byId = new Map(paletteEntries.map(([blockName, id]) => [id, blockName]))
  const container = (data.Blocks ?? data.blocks)?.value ?? data.Blocks ?? data.blocks
  const rawBytes = container?.value ?? container
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : Uint8Array.from(arr(rawBytes))
  const blocks = []
  let cursor = 0
  let index = 0
  while (cursor < bytes.length && index < width * height * length) {
    let value = 0
    let shift = 0
    let byte
    do {
      byte = bytes[cursor++]
      value |= (byte & 0x7f) << shift
      shift += 7
    } while ((byte & 0x80) !== 0 && cursor < bytes.length)
    const blockName = byId.get(value)
    if (blockName && blockName !== 'minecraft:air' && blockName !== 'air') {
      // The block array is indexed y * width * length + z * width + x.
      const x = index % width
      const z = Math.floor(index / width) % length
      const y = Math.floor(index / (width * length))
      blocks.push({ x, y, z, block: blockName })
    }
    index++
  }
  if (blocks.length === 0) throw new Error(`${path} contains no non-air blocks`)
  return withSize(blocks, name, 'schem', Object.fromEntries(paletteEntries))
}

/**
 * Decode the legacy `.schematic` format (numeric block ids + data nibbles).
 * @param data - NBT compound value.
 * @param name - Blueprint name.
 * @param path - Source path for diagnostics.
 * @param options - `registry` for id-to-name resolution.
 * @returns A blueprint.
 */
function decodeLegacy (data, name, path, options) {
  const width = num(data.Width ?? data.width) ?? 0
  const height = num(data.Height ?? data.height) ?? 0
  const length = num(data.Length ?? data.length) ?? 0
  const ids = arr((data.Blocks ?? data.blocks)?.value ?? data.Blocks ?? data.blocks).map(Number)
  const registry = options.registry
  const blocks = []
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (!id || id === 0) continue
    const resolved = registry?.blocks?.[id]
    const x = index % width
    const z = Math.floor(index / width) % length
    const y = Math.floor(index / (width * length))
    blocks.push({ x, y, z, block: resolved?.name ?? `legacy_id_${id}` })
  }
  if (blocks.length === 0) throw new Error(`${path} contains no non-air blocks`)
  return withSize(blocks, name, 'schematic-legacy')
}
