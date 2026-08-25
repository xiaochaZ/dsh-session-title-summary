/**
 * dsh-session-title-summary — host half.
 *
 * After every completed turn, folds the session's new events (user prompts,
 * assistant replies, tool calls) into a durable rolling summary and renames
 * the session to a title reflecting the CURRENT task. The rolling summary
 * decays naturally: older work is compressed by each fold, newest work keeps
 * detail — "the further back, the less detail".
 *
 * Everything rides official NPM SDK packages; no dsh source changes. The
 * browser half is deliberately absent: the enabled switch lives in the host-
 * registered settings section, which the Web settings surface renders.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { digestEvents } from './core/events.ts'
import { buildSystemPrompt, buildUserPrompt, nextSummary, parseSummaryResult } from './core/summary.ts'
import { readSummary, writeSummary } from './core/store.ts'

/** Stable cordis plugin name. */
export const name = 'session-title-summary'

/** Settings namespace of the capability — spelled here and in the GUI surface. */
export const SUMMARY_SETTINGS_NAMESPACE = settingsNamespace('dsh-session-title-summary')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch: false keeps the session title untouched. */
  enabled?: boolean
  /** Target title length in words (non-CJK languages). */
  targetWords?: number
  /** Target title length in CJK characters. */
  targetCjkCharacters?: number
  /** Explicit LLM route override; defaults to the session's current route. */
  provider?: string
  /** Explicit LLM route override; defaults to the session's current route. */
  model?: string
  /** Per-fold model output budget. */
  maxOutputTokens?: number
  /** Per-fold call timeout. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  targetWords: z.natural().min(1).default(5),
  targetCjkCharacters: z.natural().min(1).default(10),
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.natural().min(1).default(256),
  timeoutMs: z.natural().min(1000).default(60000),
})

/** Default for the master switch (composition entry may omit it). */
const DEFAULT_ENABLED = true

/** Resolved, defaulted config the fold loop reads. */
interface ResolvedConfig {
  enabled: boolean
  targetWords: number
  targetCjkCharacters: number
  provider?: string
  model?: string
  maxOutputTokens: number
  timeoutMs: number
}

/** Resolve the live config (settings section first, composition entry fallback). */
function resolveConfig(source: () => Config): ResolvedConfig {
  const value = source()
  return {
    enabled: value.enabled ?? DEFAULT_ENABLED,
    targetWords: value.targetWords ?? 5,
    targetCjkCharacters: value.targetCjkCharacters ?? 10,
    provider: value.provider,
    model: value.model,
    maxOutputTokens: value.maxOutputTokens ?? 256,
    timeoutMs: value.timeoutMs ?? 60000,
  }
}

/**
 * Mount the summary loop: on every `turn/end` of a live session, fold the new
 * events into the rolling summary and rename the session.
 * @param ctx - host plugin context carrying sessions/llm/sessionTitle.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the loop reads: the settings section once the Web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}

  // Serialize per-session folds: a fast second turn must not race the first.
  const chains = new Map<string, Promise<void>>()
  const fold = (session: Session): void => {
    const previous = chains.get(session.id) ?? Promise.resolve()
    const cfg = resolveConfig(current)
    const run = previous.then(() => foldOnce(ctx, session, cfg)).catch(() => {})
    chains.set(session.id, run)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    ctx.logger.info(`[session-title-summary] turn/end received for ${session.id} (origin=${session.header.origin})`)
    fold(session)
  })

  ctx.effect(() => () => {
    chains.clear()
  }, 'dsh-session-title-summary: chains')

  installSettingsSection(ctx, SUMMARY_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
}

/** One rolling fold: digest new events, call the model, persist, rename. */
async function foldOnce(ctx: Context, session: Session, cfg: ResolvedConfig): Promise<void> {
  if (!cfg.enabled) return
  // Subagent children keep their own titles; leave them to their parent.
  if (session.header.origin === 'subagent') return
  // The session's current model route — the fold must use the same provider.
  const header = session.requestHeader()
  const provider = cfg.provider ?? header?.config.provider
  const model = cfg.model ?? header?.config.model
  if (provider === undefined || model === undefined) return

  const record = readSummary(session.id)
  const sinceSeq = record?.lastSeq ?? 0
  const fresh = session.events.filter((event) => event.seq > sinceSeq)
  ctx.logger.info(`[session-title-summary] fold: ${session.id} enabled=${cfg.enabled} origin=${session.header.origin} route=${provider}/${model} since=${sinceSeq} fresh=${fresh.length}`)
  if (fresh.length === 0) return
  const digest = digestEvents(fresh)
  const lastSeq = fresh[fresh.length - 1].seq

  const result = await callFold(ctx, session, provider, model, cfg, record?.summary, digest)
  if (result === undefined) {
    // The model produced nothing usable; still advance the cursor so the same
    // events are not re-fed forever.
    if (record !== undefined && lastSeq > record.lastSeq) {
      writeSummary(session.id, { version: 1, lastSeq, summary: record.summary })
    }
    return
  }
  writeSummary(session.id, { version: 1, lastSeq, summary: nextSummary(record?.summary, result) })
  ctx.sessionTitle.rename(session, result.title)
}

/** Resolve the fold result through one auxiliary model call. */
async function callFold(
  ctx: Context,
  session: Session,
  provider: string,
  model: string,
  cfg: { targetWords: number; targetCjkCharacters: number; maxOutputTokens: number; timeoutMs: number },
  oldSummary: string | undefined,
  digest: string,
): Promise<{ summary: string; title: string } | undefined> {
  if (digest.trim() === '') return undefined
  const userPrompt = buildUserPrompt(oldSummary, digest)
  const system = buildSystemPrompt(cfg.targetWords, cfg.targetCjkCharacters)
  const assembler = new BlockAssembler()
  const signal = AbortSignal.timeout(cfg.timeoutMs)
  try {
    const messages = [createUserMessage({
      content: [{ type: 'text', text: userPrompt }],
      source: { kind: 'plugin', plugin: 'dsh-session-title-summary' },
    })]
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      messages,
      system,
      maxTokens: cfg.maxOutputTokens,
      sessionId: session.id,
      purpose: 'session-title',
      signal,
    })) {
      assembler.push(chunk)
    }
  } catch (error) {
    if (signal.aborted) {
      ctx.logger.warn(`session "${session.id}": summary fold timed out after ${cfg.timeoutMs}ms`)
    } else {
      ctx.logger.warn(`session "${session.id}": summary fold failed: ${String(error)}`)
    }
    return undefined
  }
  const blocks = assembler.blocks()
  const raw = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  return parseSummaryResult(raw)
}
