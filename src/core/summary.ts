/**
 * Rolling-summary core: the prompt that folds an existing summary together
 * with a new event digest into an updated summary plus a title, and the
 * strict JSON result parser. Pure functions — the LLM call itself lives in
 * the host half.
 */

/** JSON result the model must return: updated summary + a concise title. */
export interface SummaryResult {
  summary: string
  title: string
}

/** Bounds for one generated summary (keeps the rolling file small). */
export const SUMMARY_MAX_CHARS = 2000

/** Bound the model's total output budget before parsing. */
export const RESULT_MAX_CHARS = 4096

/**
 * Build the system instruction for the folding call. The instruction asks
 * the model to compress the old summary and retain detail for the newest
 * work — the "the further back, the less detail" decay the user asked for.
 * @param targetWords - target title length in words (non-CJK).
 * @param targetCjkCharacters - target title length in CJK characters.
 * @returns the system prompt text.
 */
export function buildSystemPrompt(targetWords: number, targetCjkCharacters: number): string {
  return [
    'You are a session-summary assistant for an AI coding tool.',
    'You maintain a rolling summary of everything the user and the assistant did in this session.',
    '',
    'You receive:',
    '- "Old summary": a compressed account of everything that happened BEFORE the new work.',
    '- "New work": a fresh digest of the most recent user messages, assistant replies, and tool calls.',
    '',
    'Produce a single JSON object with exactly two keys:',
    '- "summary": the UPDATED rolling summary. Fold the old summary and the new work together. ',
    '  The further back an item is, the less detail it keeps — older steps become one short clause, ',
    '  the most recent work keeps concrete detail (file names, commands, decisions, outcomes). ',
    `  Keep the whole summary under ${SUMMARY_MAX_CHARS} characters.`,
    '- "title": a concise session title reflecting the CURRENT task the session is working on, ',
    `  about ${targetWords} words (non-CJK) or ${targetCjkCharacters} CJK characters, in the language of the session.`,
    '',
    'Rules:',
    '- Return ONLY the JSON object. No markdown fences, no commentary, no trailing text.',
    '- The summary must be self-contained prose (it replaces the old summary).',
    '- Never invent facts that are not in the old summary or the new work.',
    '- If the session has no title yet, the title names the current task; if it has one, update it to the newest focus.',
  ].join('\n')
}

/**
 * Frame one folding request: the old summary plus the new digest.
 * @param oldSummary - previous rolling summary, or undefined on first fold.
 * @param newDigest - digest of the newest events.
 * @returns the user-message text.
 */
export function buildUserPrompt(oldSummary: string | undefined, newDigest: string): string {
  const parts: string[] = []
  parts.push(`<old summary>\n${oldSummary === undefined || oldSummary.trim() === '' ? '(none — this is the first fold)' : oldSummary.trim()}`)
  parts.push(`<new work>\n${newDigest.trim()}`)
  return parts.join('\n\n')
}

/**
 * Parse the model's raw output as a {@link SummaryResult}. Tolerates a
 * surrounding markdown fence; requires both keys, non-empty strings, and a
 * sane size bound.
 * @param raw - the model's raw output text.
 * @returns the parsed result, or undefined when the output is not usable.
 */
export function parseSummaryResult(raw: string): SummaryResult | undefined {
  let text = raw.trim()
  if (text.length > RESULT_MAX_CHARS) return undefined
  // Strip one optional ```json ... ``` fence.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (summary === '' || title === '') return undefined
  return { summary: summary.slice(0, SUMMARY_MAX_CHARS), title }
}

/**
 * Fold one rolling-summary step: given the old state (or none) and the
 * parsed result, produce the next durable state.
 * @param oldSummary - previous summary text, or undefined.
 * @param result - the parsed folding result.
 * @returns the next summary text (the folded summary, bounded).
 */
export function nextSummary(oldSummary: string | undefined, result: SummaryResult): string {
  // The model already folded old + new; we only bound it defensively.
  return result.summary.slice(0, SUMMARY_MAX_CHARS)
}
