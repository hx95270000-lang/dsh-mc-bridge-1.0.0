/**
 * Bounded event log.
 *
 * Everything the bot sees - chat, joins, deaths, task progress - lands in one
 * ring so a later `mc_observe` call can replay what happened while the model
 * was not looking. Bounded storage keeps a long-running bot from leaking.
 */

import { plainText } from './text.js'

/** @typedef {'system'|'chat'|'action'|'warn'|'error'|'death'|'player'} LogKind */

export class EventLog {
  /** @type {number} */
  #limit
  /** @type {Array<{ seq: number, at: number, kind: LogKind, text: string, from?: string }>} */
  #entries = []
  /** @type {number} */
  #seq = 0

  /**
   * @param limit - Maximum retained entries.
   */
  constructor (limit = 400) {
    this.#limit = Math.max(20, Number(limit) || 400)
  }

  /**
   * Append one event.
   * @param kind - Event category.
   * @param text - Human-readable description.
   * @param from - Optional player name for chat events.
   * @returns The stored entry.
   */
  push (kind, text, from) {
    const entry = {
      seq: ++this.#seq,
      at: Date.now(),
      kind,
      text: plainText(text),
      ...(from === undefined ? {} : { from })
    }
    this.#entries.push(entry)
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit)
    }
    return entry
  }

  /**
   * Read the most recent entries, oldest first.
   * @param limit - Maximum entries to return.
   * @param kinds - Optional allowlist of kinds.
   * @returns A copy of the selected slice.
   */
  tail (limit = 40, kinds) {
    const source = kinds === undefined || kinds.length === 0
      ? this.#entries
      : this.#entries.filter(entry => kinds.includes(entry.kind))
    return source.slice(-Math.max(1, limit)).map(entry => ({ ...entry }))
  }

  /**
   * Entries added after a sequence number, for incremental polling.
   * @param sinceSeq - Last sequence number the caller already saw.
   * @param limit - Maximum entries to return.
   * @returns Entries with a greater sequence number.
   */
  since (sinceSeq, limit = 200) {
    return this.#entries
      .filter(entry => entry.seq > sinceSeq)
      .slice(-Math.max(1, limit))
      .map(entry => ({ ...entry }))
  }

  /** Highest assigned sequence number. */
  get cursor () {
    return this.#seq
  }

  /** Drop every retained entry. */
  clear () {
    this.#entries = []
  }
}
