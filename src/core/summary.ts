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

/** Bounds for one generated summary (keeps the rolling file compact AND well
 * under the summarizer subagent's token budget. A 1000-char CJK outline plus
 * JSON wrapper plus title stays comfortably inside even a modest output cap;
 * structured-output JSON escaping + reasoning eat extra tokens, so smaller is
 * safer.) */
export const SUMMARY_MAX_CHARS = 1000

/** Bound the model's total output budget before parsing. */
export const RESULT_MAX_CHARS = 4096

/** Display width of one character: CJK/full-width chars count as 2, ASCII
 * and half-width chars count as 1 (two ASCII chars = one CJK char). */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK unified ideographs, full-width forms, hangul, kana, and other wide ranges.
  if (
    (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
    (code >= 0x2E80 && code <= 0xA4CF) || // CJK Radicals .. Yi
    (code >= 0xAC00 && code <= 0xD7A3) || // Hangul Syllables
    (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
    (code >= 0xFE30 && code <= 0xFE4F) || // CJK Compatibility Forms
    (code >= 0xFF00 && code <= 0xFF60) || // Full-width Forms
    (code >= 0xFFE0 && code <= 0xFFE6) || // Full-width Signs
    (code >= 0x20000 && code <= 0x2FFFD) // CJK Extension B..
  ) {
    return 2
  }
  return 1
}

/** Display width of a string (two ASCII chars = one CJK char). */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/**
 * Fit a title into a display-width budget WITHOUT breaking its meaning and
 * WITHOUT losing the "major topic - minor topic" structure. The "-" join is
 * preserved whenever possible; both sides are compressed at token boundaries
 * (never mid-word, never mid-CJK-word). Only if the minor topic is squeezed
 * to nothing do we fall back to the bare major topic.
 * @param title - the model-produced title.
 * @param maxCjkChars - maximum CJK-character count (default 10).
 * @returns a width-bounded title that keeps both sides when it can.
 */
export function truncateTitleByWidth(title: string, maxCjkChars: number = 10): string {
  const maxWidth = maxCjkChars * 2
  const trimmed = title.trim()
  if (trimmed === '') return ''

  // 1. Fits as-is.
  if (displayWidth(trimmed) <= maxWidth) return trimmed

  // Split into token runs (CJK runs and non-CJK runs) so a word is never cut.
  const tokens = splitTokens(trimmed)

  // 2. Find the dash that joins major and minor topics.
  const dashIndex = tokens.findIndex((t) => t === '-' || t === '–' || t === '—' || t === ' - ' || t.trim() === '-')
  const hasDash = dashIndex !== -1 && dashIndex < tokens.length - 1
  if (hasDash) {
    const majorTokens = tokens.slice(0, dashIndex)
    const minorTokens = tokens.slice(dashIndex + 1)
    // Reserve width for the dash and one space.
    const dashWidth = 2 // "-" + space
    const spaceForSides = maxWidth - dashWidth
    const major = fitTokens(majorTokens, spaceForSides * 0.55)
    const minor = fitTokens(minorTokens, spaceForSides * 0.45)
    const joined = `${major} - ${minor}`.trim()
    if (joined !== '-' && displayWidth(joined) <= maxWidth) return joined
    // Minor got squeezed out entirely; keep a complete major topic.
    const majorOnly = fitTokens(majorTokens, maxWidth)
    if (majorOnly !== '') return majorOnly
  }

  // 3. No dash: truncate at token boundaries.
  return fitTokens(tokens, maxWidth)
}

/** Split a string into CJK-run and non-CJK-run tokens (words never split). */
function splitTokens(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const ch of text) {
    const wide = charWidth(ch) === 2
    if (current !== '' && wide !== (charWidth(current[0]) === 2)) {
      tokens.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Keep the longest prefix of tokens that fits the width budget. */
function fitTokens(tokens: string[], maxWidth: number): string {
  let width = 0
  const kept: string[] = []
  for (const token of tokens) {
    if (width + displayWidth(token) > maxWidth) break
    kept.push(token)
    width += displayWidth(token)
  }
  return kept.join('').trim()
}

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
    'Definitions:',
    '- "Major topic" (大问题): the session-level GOAL the user is working toward — the overall thing being built or done, e.g. "开发标题自动总结功能", "整理照片归档".',
    '- "Minor topic" (小问题): one specific item UNDER that major topic — a concrete step, issue, or fix, e.g. "修复子代理输出token上限", "调整摘要格式".',
    '',
    'You receive:',
    '- "Old summary": the previous outline of everything that happened BEFORE the new work.',
    '- "New work": a fresh digest of the most recent user messages, assistant replies, and tool calls, newest at the END.',
    '',
    'Produce a single JSON object with exactly two keys:',
    '- "summary": the UPDATED outline, covering the WHOLE session — nothing important is dropped. ',
    '  Every line is ONE bullet of the form "major topic - minor topic", joined with a "-". ',
    '  The major topic names the GOAL; the minor topic names the specific item under it. ',
    '  Example lines: "开发标题自动总结功能 - 修复子代理输出token上限", "整理照片归档 - 解压与分类". ',
    '  Group lines by major topic: lines of the same major topic stay together, and different major topics ',
    '  are separated by a blank line. ',
    '  Keep every topic that still matters from the old summary (ONE short bullet each — a few words, not a sentence), and add the new work. ',
    '  The CURRENT major topic gets up to 3-4 bullets with a little detail (file names, commands, outcomes); ',
    '  older major topics stay as one brief bullet each. Be terse: every bullet is short.',
    `  Keep the whole outline under ${SUMMARY_MAX_CHARS} characters.`,
    '',
    '  Example shape:',
    '  开发标题自动总结功能 - 插件架构(agent/turn-stopping + 子代理)',
    '  开发标题自动总结功能 - 修复:子代理输出token上限',
    '  开发标题自动总结功能 - 当前:调整摘要格式',
    '',
    '  整理照片归档 - 解压与分类',
    '  整理照片归档 - 按人物整理',
    '',
    '- "title": a concise session title reflecting the CURRENT work — the overall GOAL first, then the specific item being handled right now, ',
    '  in the same "major topic - minor topic" form. ',
    '  Example: "开发总结功能 - 修复token", NOT a run-on sentence. ',
    '  Base it on the NEWEST work at the END of the digest, NOT on how the session started. ',
    '  Early topics are background and must NOT dominate the title. ',
    '  WIDTH RULE: the title display width must fit 10 CJK characters — every CJK/full-width char counts 1, ',
    '  every 2 ASCII/half-width chars count 1 (so 20 ASCII chars is the max). ',
    '  The MAJOR topic must be SHORT (about 3-5 CJK chars or 2-3 words) so the "-" and the minor topic still fit. ',
    '  Never write a full package or file name. ',
    '  That is a HARD LIMIT of 20 display units. ',
    '  Examples within the limit: "开发总结功能 - 修复token" (6 CJK + 2 + 5 ASCII), "插件修复 - 标题截断".',
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
