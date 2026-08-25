/**
 * Durable rolling-summary store: one JSON file per session under
 * `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`, written atomically
 * (tmp + rename). Pure file I/O — no cordis dependency, unit-testable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './home.ts'

/** Directory holding per-session rolling summaries. */
export function summaryDir(home: string = dshHome()): string {
  return join(home, 'dsh-session-title-summary')
}

/** File path for one session's rolling summary. */
export function summaryPath(sessionId: string, home: string = dshHome()): string {
  return join(summaryDir(home), `${sessionId}.json`)
}

/** On-disk shape. `lastSeq` is the highest session event seq already folded. */
export interface SummaryRecord {
  version: 1
  lastSeq: number
  summary: string
}

/** Read a session's summary record, or undefined when absent/corrupt. */
export function readSummary(sessionId: string, home: string = dshHome()): SummaryRecord | undefined {
  const path = summaryPath(sessionId, home)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || typeof record.lastSeq !== 'number' || typeof record.summary !== 'string') return undefined
    return { version: 1, lastSeq: record.lastSeq, summary: record.summary }
  } catch {
    return undefined
  }
}

/** Write a session's summary record atomically (tmp + rename). */
export function writeSummary(sessionId: string, record: SummaryRecord, home: string = dshHome()): void {
  const path = summaryPath(sessionId, home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(tmp, path)
}
