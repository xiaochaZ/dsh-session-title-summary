/**
 * Turn session log events into a compact human-readable digest of "what
 * happened" — user prompts, assistant replies, and every tool invocation with
 * its outcome. Pure functions over event arrays; no cordis, no I/O.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Bound one digest line so a long tool result cannot blow the LLM input budget. */
export const LINE_MAX_CHARS = 240

/** Bound the total digest produced from one batch of events. */
export const DIGEST_MAX_CHARS = 8000

/** Shorten a line with an ellipsis when it exceeds the bound. */
export function clip(text: string, max: number = LINE_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Join the text blocks of a content array (skips reasoning/tool-call blocks). */
function textOf(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Pretty-print one tool arguments JSON (or fall back to the raw string). */
function argsOf(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return JSON.stringify(parsed)
  } catch {
    return trimmed
  }
}

/**
 * Render one session event as a short digest line, or undefined when the
 * event carries no model-visible work (boundaries, chunks, usage, headers).
 * @param event - one session log event.
 * @returns one digest line, or undefined to skip the event.
 */
export function digestEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message': {
      const text = textOf(event.data.content)
      if (text === '') return undefined
      return `用户: ${clip(text)}`
    }
    case 'assistant/message': {
      const text = textOf(event.data.message.content)
      if (text === '') return undefined
      return `助手: ${clip(text)}`
    }
    case 'tool/call': {
      const args = argsOf(event.data.arguments)
      const suffix = args === '' ? '' : `(${clip(args, 160)})`
      return `工具调用: ${event.data.name}${suffix}`
    }
    case 'tool/result': {
      const text = textOf(event.data.message.content)
      const prefix = event.data.error !== undefined ? '工具结果(出错)' : '工具结果'
      return `${prefix}: ${clip(text)}`
    }
    default:
      return undefined
  }
}

/**
 * Digest a contiguous batch of events (in seq order) into one bounded text
 * block. Skips events that render nothing. The digest keeps the NEWEST lines:
 * events are scanned from the tail and older lines are dropped first when the
 * total exceeds {@link DIGEST_MAX_CHARS} — the session's current work always
 * stays, early history decays away (the "further back, less detail" rule).
 * @param events - events in ascending seq order.
 * @returns the bounded digest text.
 */
export function digestEvents(events: readonly SessionEvent[]): string {
  // Collect all digestible lines first, then keep the tail that fits.
  const lines: string[] = []
  for (const event of events) {
    const line = digestEvent(event)
    if (line === undefined) continue
    lines.push(line)
  }
  // Trim from the front (oldest) until the whole digest fits.
  let used = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (used + cost > DIGEST_MAX_CHARS && start < lines.length) break
    used += cost
    start = i
  }
  return lines.slice(start).join('\n')
}
