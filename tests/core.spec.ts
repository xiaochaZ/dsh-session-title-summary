/**
 * Unit tests for the rolling-summary core: event digestion, prompt building,
 * result parsing, and the durable store. Pure logic — no LLM, no cordis.
 */

import { describe, expect, it } from 'vitest'
import { digestEvent, digestEvents } from '../src/core/events.ts'
import { buildSystemPrompt, buildUserPrompt, nextSummary, parseSummaryResult } from '../src/core/summary.ts'
import { readSummary, summaryPath, writeSummary } from '../src/core/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal event-shaped fixtures (the digest only reads a few fields). */
function event(type: string, data: unknown, seq: number) {
  return { type, data, seq } as never
}

describe('digestEvent', () => {
  it('renders a user message from text blocks', () => {
    const line = digestEvent(event('user/message', {
      content: [{ type: 'text', text: '解压文件后分类整理' }],
    }, 1))
    expect(line).toBe('用户: 解压文件后分类整理')
  })

  it('skips non-text user content', () => {
    expect(digestEvent(event('user/message', { content: [{ type: 'image', image: {} }] }, 1))).toBeUndefined()
  })

  it('renders an assistant reply', () => {
    const line = digestEvent(event('assistant/message', {
      message: { content: [{ type: 'text', text: '已完成分类' }] },
    }, 2))
    expect(line).toBe('助手: 已完成分类')
  })

  it('renders tool calls with parsed arguments', () => {
    const line = digestEvent(event('tool/call', {
      name: 'extract_archive',
      arguments: '{"path":"a.7z"}',
    }, 3))
    expect(line).toBe('工具调用: extract_archive({"path":"a.7z"})')
  })

  it('renders tool results and marks errors', () => {
    expect(digestEvent(event('tool/result', {
      message: { content: [{ type: 'text', text: 'ok' }] },
    }, 4))).toBe('工具结果: ok')
    expect(digestEvent(event('tool/result', {
      message: { content: [{ type: 'text', text: 'boom' }] },
      error: { name: 'E', code: 'ERR' },
    }, 5))).toBe('工具结果(出错): boom')
  })

  it('skips boundaries and log-only events', () => {
    expect(digestEvent(event('turn/end', { turn: 1, reason: { kind: 'stop' } }, 6))).toBeUndefined()
    expect(digestEvent(event('request/header', { header: {}, reason: 'new' }, 7))).toBeUndefined()
  })

  it('clips long lines', () => {
    const line = digestEvent(event('user/message', { content: [{ type: 'text', text: 'x'.repeat(500) }] }, 8))
    // 4-char "用户: " prefix + the 240-char clip bound.
    expect(line?.length).toBeLessThanOrEqual(245)
    expect(line?.endsWith('…')).toBe(true)
  })})

describe('digestEvents', () => {
  it('joins digestible events in order and skips the rest', () => {
    const digest = digestEvents([
      event('user/message', { content: [{ type: 'text', text: 'a' }] }, 1),
      event('turn/end', { turn: 1, reason: { kind: 'stop' } }, 2),
      event('tool/call', { name: 'x', arguments: '{}' }, 3),
      event('assistant/message', { message: { content: [{ type: 'text', text: 'b' }] } }, 4),
    ])
    expect(digest).toBe('用户: a\n工具调用: x({})\n助手: b')
  })

  it('keeps the newest lines when the digest exceeds the bound', () => {
    // 200 events x ~50 chars each exceed DIGEST_MAX_CHARS (8000);
    // the OLDEST lines must be dropped, the newest kept.
    const many = Array.from({ length: 200 }, (_, i) => event('user/message', { content: [{ type: 'text', text: `m${i}`.repeat(50) }] }, i))
    const digest = digestEvents(many)
    expect(digest.length).toBeLessThanOrEqual(8000)
    // Newest content (m199) survives; the oldest (m0) was dropped.
    expect(digest).toContain('m199'.repeat(50).slice(0, 20))
    expect(digest).not.toContain('m0'.repeat(50).slice(0, 20))
  })
})

describe('summary prompts', () => {
  it('builds a system prompt with the requested title lengths', () => {
    const system = buildSystemPrompt(5, 10)
    expect(system).toContain('5 words')
    expect(system).toContain('10 CJK characters')
    expect(system).toContain('further back')
  })

  it('frames the first fold and a subsequent fold distinctly', () => {
    const first = buildUserPrompt(undefined, 'new work')
    expect(first).toContain('(none — this is the first fold)')
    expect(first).toContain('new work')
    const next = buildUserPrompt('old summary', 'newer work')
    expect(next).toContain('old summary')
    expect(next).toContain('newer work')
  })
})

describe('parseSummaryResult', () => {
  it('parses a plain JSON object', () => {
    expect(parseSummaryResult('{"summary":"s","title":"t"}')).toEqual({ summary: 's', title: 't' })
  })

  it('tolerates a markdown fence', () => {
    expect(parseSummaryResult('```json\n{"summary":"s","title":"t"}\n```')).toEqual({ summary: 's', title: 't' })
  })

  it('rejects missing keys, empty values, and non-JSON', () => {
    expect(parseSummaryResult('{"summary":"s"}')).toBeUndefined()
    expect(parseSummaryResult('{"summary":"","title":"t"}')).toBeUndefined()
    expect(parseSummaryResult('not json')).toBeUndefined()
    expect(parseSummaryResult('42')).toBeUndefined()
  })

  it('rejects oversized output', () => {
    const huge = `{"summary":"${'x'.repeat(4096)}","title":"t"}`
    expect(parseSummaryResult(huge)).toBeUndefined()
  })
})

describe('nextSummary', () => {
  it('bounds the summary length', () => {
    const result = { summary: 'x'.repeat(5000), title: 't' }
    expect(nextSummary('old', result).length).toBe(2000)
  })
})

describe('store', () => {
  it('round-trips a summary record through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-title-summary-'))
    const sessionId = 'session-test-roundtrip'
    try {
      writeSummary(sessionId, { version: 1, lastSeq: 42, summary: 'so far' }, dir)
      const record = readSummary(sessionId, dir)
      expect(record).toEqual({ version: 1, lastSeq: 42, summary: 'so far' })
      expect(summaryPath(sessionId, dir)).toContain('dsh-session-title-summary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for missing or corrupt records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-title-summary-'))
    const sessionId = 'session-test-missing'
    try {
      expect(readSummary(sessionId, dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
