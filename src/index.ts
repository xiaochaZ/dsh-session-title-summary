/**
 * dsh-session-title-summary — host half.
 *
 * After every completed turn (`agent/turn-stopping`), spawns a subagent that
 * folds the session's new events (user prompts, assistant replies, tool calls)
 * into a durable rolling summary and returns a session title reflecting the
 * CURRENT task. The rolling summary decays naturally: older work is compressed
 * by each fold, newest work keeps detail — "the further back, the less detail".
 *
 * Trigger design follows dsh-auto-memory: `agent/turn-stopping` is the event
 * a host plugin reliably receives (session/event is session-scoped and a
 * plugin fiber may not observe it), and the work runs in a subagent so the
 * main conversation is never blocked or polluted. Everything rides official
 * NPM SDK packages; no dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { digestEvents } from './core/events.ts'
import { buildSystemPrompt, buildUserPrompt, nextSummary, parseSummaryResult } from './core/summary.ts'
import { readSummary, writeSummary } from './core/store.ts'

/** Stable cordis plugin name. */
export const name = 'session-title-summary'

/** Services the host half needs (mirrors dsh-auto-memory's inject pattern so
 * the plugin fiber attaches where agent events are observable). */
export const inject = ['sessions', 'sessionTitle', 'subagents']

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
  /** Per-fold subagent timeout. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  targetWords: z.natural().min(1).default(8),
  targetCjkCharacters: z.natural().min(1).default(18),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.natural().min(1000).default(90000),
})

/** Default for the master switch (composition entry may omit it). */
const DEFAULT_ENABLED = true

/** How long to wait after turn-stopping before spawning the subagent (avoid
 * racing the session teardown; same pattern as dsh-auto-memory). */
const SETTLE_DELAY_MS = 600

/** Resolved, defaulted config the fold loop reads. */
interface ResolvedConfig {
  enabled: boolean
  targetWords: number
  targetCjkCharacters: number
  provider?: string
  model?: string
  timeoutMs: number
}

/** Resolve the live config (settings section first, composition entry fallback). */
function resolveConfig(source: () => Config): ResolvedConfig {
  const value = source()
  return {
    enabled: value.enabled ?? DEFAULT_ENABLED,
    targetWords: value.targetWords ?? 8,
    targetCjkCharacters: value.targetCjkCharacters ?? 18,
    provider: value.provider,
    model: value.model,
    timeoutMs: value.timeoutMs ?? 90000,
  }
}

/**
 * Mount the summary loop: on every `agent/turn-stopping`, spawn a subagent to
 * fold the session's new work and rename the session.
 * @param ctx - host plugin context carrying sessions/subagents/sessionTitle.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the loop reads: the settings section once the Web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}

  // Serialize per-session folds: a fast second turn must not race the first.
  const chains = new Map<string, Promise<void>>()

  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent
    const turn = payload?.turn
    if (!agent?.session) return
    ctx.logger.info(`[session-title-summary] turn-stopping: session=${agent.session.id} turn=${turn}`)
    // Delay past the turn teardown, then fold in the background.
    setTimeout(() => {
      const cfg = resolveConfig(current)
      const previous = chains.get(agent.session.id) ?? Promise.resolve()
      const run = previous.then(() => foldOnce(ctx, agent, cfg, turn)).catch((e) => {
        ctx.logger.warn(`[session-title-summary] fold error: ${String(e)}`)
      })
      chains.set(agent.session.id, run)
    }, SETTLE_DELAY_MS)
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

/** One rolling fold: digest new events, call the summarizer subagent, persist, rename. */
async function foldOnce(ctx: Context, agent: Agent, cfg: ResolvedConfig, turn: number): Promise<void> {
  const session = agent.session
  if (!cfg.enabled) return
  // Subagent children keep their own titles; leave them to their parent.
  if (session.header.origin === 'subagent' || session.header.parentSession !== undefined) return

  const record = readSummary(session.id)
  const sinceSeq = record?.lastSeq ?? 0
  const fresh = session.events.filter((event) => event.seq > sinceSeq)
  if (fresh.length === 0) return
  const digest = digestEvents(fresh)
  const lastSeq = fresh[fresh.length - 1].seq
  if (digest.trim() === '') return

  const result = await callSummarizer(ctx, agent, cfg, record?.summary, digest)
  if (result === undefined) {
    // The subagent produced nothing usable; still advance the cursor so the
    // same events are not re-fed forever.
    if (record !== undefined && lastSeq > record.lastSeq) {
      writeSummary(session.id, { version: 1, lastSeq, summary: record.summary })
    }
    return
  }
  writeSummary(session.id, { version: 1, lastSeq, summary: nextSummary(record?.summary, result) })
  try {
    ctx.sessionTitle.rename(session, result.title)
    ctx.logger.info(`[session-title-summary] renamed ${session.id} (turn ${turn}) -> "${result.title}"`)
  } catch (error) {
    ctx.logger.warn(`[session-title-summary] rename failed for ${session.id}: ${String(error)}`)
  }
}

/** Resolve the fold result through one subagent call (parent = the live agent,
 * so the child inherits the same model route and workspace). */
async function callSummarizer(
  ctx: Context,
  agent: Agent,
  cfg: ResolvedConfig,
  oldSummary: string | undefined,
  digest: string,
): Promise<{ summary: string; title: string } | undefined> {
  const subagents = ctx.subagents
  if (subagents === undefined) return undefined

  const userPrompt = buildUserPrompt(oldSummary, digest)
  const system = buildSystemPrompt(cfg.targetWords, cfg.targetCjkCharacters)

  // Route override: ask the subagent to prefer a specific provider/model when
  // configured; otherwise it inherits the parent's route automatically.
  const routeNote = cfg.provider !== undefined && cfg.model !== undefined
    ? `\nUse provider "${cfg.provider}" and model "${cfg.model}" for this task.`
    : ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('session-title-summary timeout'), cfg.timeoutMs)
  try {
    const run = await subagents.start('spawn', {
      label: 'session-title-summary',
      prompt: [
        { type: 'text', text: `${system}${routeNote}\n\n${userPrompt}` },
      ],
      signal: controller.signal,
      parent: agent,
    })
    const result = await run.result
    const blocks = result?.output ?? []
    const raw = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim()
    return parseSummaryResult(raw)
  } catch (error) {
    if (controller.signal.aborted) {
      ctx.logger.warn(`[session-title-summary] subagent timed out after ${cfg.timeoutMs}ms`)
    } else {
      ctx.logger.warn(`[session-title-summary] subagent failed: ${String(error)}`)
    }
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
