# dsh-session-title-summary — Rolling session summary + task title

English | [中文](README.zh.md)

[![GitHub stars](https://img.shields.io/github/stars/xiaochaZ/dsh-session-title-summary?style=flat-square)](https://github.com/xiaochaZ/dsh-session-title-summary)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.1.1--rc.1-purple?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A host-only plugin for DeepSeek Harness (DSH): after every completed turn it
folds the session's new work (user messages, assistant replies, tool calls)
into a **durable rolling summary** and renames the session to a title that
reflects the **current task**. Implemented entirely through the official NPM
SDK — no DSH source changes.

## How it works

- The plugin listens for `turn/end` on every live session.
- New events since the last fold are digested into text (prompts, replies,
  tool names + arguments, tool results).
- The digest is sent together with the previous rolling summary to the same
  model route the session is using; the model returns a JSON object with an
  updated summary and a new title.
- The updated summary is stored atomically per session under
  `$DSH_HOME/dsh-session-title-summary/<sessionId>.json` and the session is
  renamed via the official `sessionTitle` service.

### The rolling decay you asked for

Each fold compresses the old summary and keeps detail for the newest work —
so the further back something happened, the less detail the summary keeps,
while the current task stays concrete. A long session like "extract archives,
then classify and organize photos" keeps every stage in the summary, with the
organizing step described in the most detail, and the title tracks the
currently active step.

### Cache safety

The `session/title` event is log-only: it never enters `deriveMessages()`,
the system prompt, tool schemas, or the request prefix, so renaming does not
touch the input cache hit rate or the KV cache. The fold itself is a separate
auxiliary model request (`purpose: "session-title"`) with its own prompt —
it does not share a prefix with the main conversation.

## Install

```sh
### From npm (when published)
dsh plugin --profile <name> add @xiaochaz/dsh-session-title-summary@latest

### From the repository (development)
git clone <this repo>
cd xiaochaz-session-title-summary
pnpm install && pnpm build
dsh plugin --profile <name> add link:$(pwd)
```

After installing, **restart `dsh web`**. The plugin takes effect on the next
completed turn.

## Configuration

The Web settings surface renders a section for this plugin:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Turn it off to keep session titles untouched (the plugin then does nothing). |
| `targetWords` | `5` | Target title length in words for non-CJK sessions. |
| `targetCjkCharacters` | `10` | Target title length in CJK characters. |
| `provider` / `model` | session route | Optional explicit LLM route override; default follows the session's current model. |
| `maxOutputTokens` | `256` | Per-fold model output budget. |
| `timeoutMs` | `60000` | Per-fold call timeout. |

## Data

- Rolling summaries: `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`
  (versioned JSON, atomic write; `lastSeq` is the highest folded event seq).

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## Known limitations

- A fold that produces no usable model output advances the cursor without
  renaming, so the same events are not re-fed forever.
- Explicitly user-renamed sessions are re-titled by the plugin on the next
  turn while enabled (turn the switch off to stop that).
- Subagent child sessions are skipped; only their parent's title is managed.

## License

BSD-3-Clause.
