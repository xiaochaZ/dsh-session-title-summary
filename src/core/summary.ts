/**
 * Rolling-summary core: the prompt that folds an existing summary together
 * with a new event digest into an updated summary plus a title, and the
 * strict JSON result parser. Pure functions — the LLM call itself lives in
 * the host half.
 *
 * Summary format: a nested outline of "major topic - minor topic" lines that
 * covers the WHOLE session (everything stays present; older topics keep one
 * short bullet, the current topic keeps concrete detail). Title: focuses on
 * the CURRENT task only.
 */

/** JSON result the model must return: updated summary + a concise title. */
export interface SummaryResult {
  summary: string
  title: string
}

/** Bounds for one generated summary (keeps the rolling file compact; the
 * outline covers the whole session but stays terse). */
export const SUMMARY_MAX_CHARS = 3000

/** Bound the model's total output budget before parsing. */
export const RESULT_MAX_CHARS = 8192

/**
 * Build the system instruction for the folding call.
 * @param targetWords - target title length in words (non-CJK).
 * @param targetCjkCharacters - target title length in CJK characters.
 * @returns the system prompt text.
 */
export function buildSystemPrompt(targetWords: number, targetCjkCharacters: number): string {
  return [
    'You are a session-summary assistant for an AI coding tool.',
    'You maintain a rolling outline of EVERYTHING the user and the assistant did in this session.',
    '',
    'You receive:',
    '- "Old summary": the previous outline of everything that happened BEFORE the new work.',
    '- "New work": a fresh digest of the most recent user messages, assistant replies, and tool calls, newest at the END.',
    '',
    'Produce a single JSON object with exactly two keys:',
    '- "summary": the UPDATED outline, covering the WHOLE session — nothing important is dropped. ',
    '  Every line is ONE bullet of the form "major topic - minor topic", joined with a "-". ',
    '  Example lines: "插件开发 - 修复摘要格式", "照片归档 - 解压与分类". ',
    '  Group lines by major topic: lines of the same major topic stay together, and different major topics ',
    '  are separated by a blank line. ',
    '  Keep every topic that still matters from the old summary (ONE short bullet each — a few words, not a sentence), and add the new work. ',
    '  The CURRENT topic gets up to 3-4 bullets with a little detail (file names, commands, outcomes); ',
    '  older topics stay as one brief bullet each. Be terse: every bullet is short.',
    `  Keep the whole outline under ${SUMMARY_MAX_CHARS} characters.`,
    '',
    '  Example shape:',
    '  插件开发 - 会话标题总结插件',
    '  插件开发 - 修复:摘要保留最新工作',
    '  插件开发 - 当前:调整摘要为大问题-小问题格式',
    '',
    '  历史任务 - 照片归档',
    '  历史任务 - 完成:解压-分类-整理',
    '',
    '- "title": a concise session title reflecting the CURRENT task the session is working on right now — ',
    '  base it on the NEWEST work at the END of the digest, NOT on how the session started. ',
    '  Use the SAME "major topic - minor topic" structure as the summary: a "-" joins the major topic ',
    '  (what the session is about) and the specific current item. ',
    '  Example: "截断问题 - 修复标题不更新" rather than a run-on sentence. ',
    '  Early topics are background and must NOT dominate the title. ',
    `  About ${targetWords} words (non-CJK) or ${targetCjkCharacters} CJK characters, in the language of the session. `,
    '  A slightly longer title is fine if it names the current task clearly.',
    '',
    'Rules:',
    '- Return ONLY the JSON object. No markdown fences, no commentary, no trailing text.',
    '- The summary must be self-contained (it replaces the old summary).',
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
