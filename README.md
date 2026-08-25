# dsh-session-title-summary — Rolling session summary + task title

English | [中文](README.zh.md)

[![GitHub stars](https://img.shields.io/github/stars/xiaochaZ/dsh-session-title-summary?style=flat-square)](https://github.com/xiaochaZ/dsh-session-title-summary)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.1.1--rc.1-purple?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A host-only plugin for DeepSeek Harness (DSH): after every completed turn it
summarizes the session's work in a **rolling "major topic - minor topic"
outline** and renames the session to a title that names the session GOAL and
the specific item being handled right now. Implemented entirely through the
official NPM SDK — no DSH source changes.

## How it works

- The plugin listens for `agent/turn-stopping` (the same event dsh-auto-memory
  uses) on every live top-level agent.
- After the turn settles, it spawns a **subagent** with the live agent as the
  parent, so the child inherits the same model route and workspace and the main
  conversation is never blocked or polluted.
- The subagent receives the previous rolling summary plus a digest of the new
  events (user prompts, assistant replies, tool calls with names/arguments/
  results) and returns an updated summary and a new title as a structured
  object.
- The summary is stored atomically per session under
  `$DSH_HOME/dsh-session-title-summary/<sessionId>.json` and the session is
  renamed via the official `sessionTitle` service.

### Summary format: "major topic - minor topic"

The summary covers the WHOLE session as a terse outline. A **major topic** is
the session-level GOAL the user is working toward (e.g. "开发标题自动总结功能");
a **minor topic** is one specific item under it (e.g. "修复子代理输出token上限").
Each line reads "major topic - minor topic", lines of the same major topic stay
together, and different major topics are separated by a blank line. The current
major topic gets the most bullets; older topics keep one short bullet each.

### Title follows the current work

The title uses the same form, e.g. "开发标题自动总结功能 - 修复子代理输出token上限".
It is based on the newest work at the end of the digest, never on how the
session started, so it tracks the current task as the session evolves.

### Cache safety

The `session/title` event is log-only: it never enters `deriveMessages()`, the
system prompt, tool schemas, or the request prefix, so renaming does not touch
the input cache hit rate or the KV cache. Summarization runs in a detached
subagent with its own prompt — it shares no prefix with the main conversation.

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
| `targetWords` | `8` | Target title length in words for non-CJK sessions. |
| `targetCjkCharacters` | `18` | Target title length in CJK characters. |
| `provider` / `model` | session route | Optional explicit LLM route override; default follows the session's current model. |
| `timeoutMs` | `90000` | Per-fold subagent timeout. |

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

- The summarizer subagent has a fixed 4096-token output budget; a very long
  summary can still be cut off (the fold then advances the cursor without
  renaming, so the same events are not re-fed forever).
- Explicitly user-renamed sessions are re-titled by the plugin on the next
  turn while enabled (turn the switch off to stop that).
- Subagent child sessions are skipped; only their parent's title is managed.

## License

BSD-3-Clause.
