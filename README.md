# pi-context-prune

A [Pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that **summarizes completed tool-call batches**, prunes raw tool outputs from future LLM context, and exposes a `context_tree_query` escape hatch to recover any original output on demand.

> **Fork of [championswimmer/pi-context-prune](https://github.com/championswimmer/pi-context-prune)** with additional features:
> - **Structured batch summarization** — up to 3 parallel JSON-structured LLM calls instead of N parallel calls
> - **Small-batch skip** — batches under 800 chars of raw content skip LLM summarization entirely
> - **Aggregate notifications** — single info notification for skipped/oversized batches instead of per-turn warnings
> - **Context usage tracking** — shows current context usage percentage in the pruner status widget
> - **Codebase cleanup** — unified types, dead-code removal, single-pass branch reconstruction

## Related Extensions

| Extension | What it does | Why use with pruner |
|---|---|---|
| [pi-context-usage](https://github.com/championswimmer/pi-context-usage) | Visualizes context size breakdown | See *why* you need pruning; compare before/after |
| [pi-cache-graph](https://github.com/championswimmer/pi-cache-graph) | Live graph of cache hits/misses | See real-time effect of `pruneOn` mode on cache stability |

---

## How it works

1. **Detects** when an assistant turn finishes calling tools (`turn_end`)
2. **Classifies** batches — tiny results (< 800 chars) skip LLM; the rest are summarized
3. **Summarizes** tool-call batches via structured JSON LLM calls (max 3 parallel groups)
4. **Injects** a compact summary message before the next LLM call (`deliverAs: "steer"`)
5. **Prunes** the original verbose tool outputs from future context (`context` event)
6. **Preserves** every original output in the session index — retrievable at any time via `context_tree_query`
7. **Shows** context usage percentage in the footer status widget

The session file is never modified. Pruning only affects the next request's context build.

## Installation

```bash
# Install from this fork (cutting-edge)
pi install git:github.com/greatyingzi/pi-context-prune

# Or load for this session only
pi -e git:github.com/greatyingzi/pi-context-prune
```

### From source (development)

```bash
git clone https://github.com/greatyingzi/pi-context-prune
cd pi-context-prune
pi -e .
```

## Prune-On Modes

Five trigger modes controlling **when** summarization and pruning happen:

| Mode | Trigger | Cache impact | Use case |
|---|---|---|---|
| `every-turn` | After each tool-calling turn | ⚠️ High — rewrites context every turn | Debugging/testing only |
| `on-context-tag` | When `context_tag` is called | Medium — aligned with checkpoints | Paired with `pi-context` extension |
| `on-demand` | Only on `/pruner now` | ✅ Minimal — you control timing | Advanced users wanting full control |
| `agent-message` | On agent's final text response | ✅ Low — one prune per work batch | **Recommended default** |
| `agentic-auto` | LLM decides via `context_prune` tool | Medium — depends on model judgment | Long autonomous sessions |

### Cache-aware guidance

On providers with **prefix / prompt caching** (Anthropic, AWS Bedrock, etc.), pruning rewrites the earlier context, which invalidates the cache. **`agent-message`** is the default because it batches many tool turns into one prune, then leaves the shorter context stable — one cache bust per work batch instead of one per turn.

References:
- [Anthropic prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [AWS Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [pi-context](https://github.com/ttttmr/pi-context) (`context_tag`, `context_log`, `context_checkout`)

## Commands

| Command | Effect |
|---|---|
| `/pruner` | Interactive picker over all subcommands |
| `/pruner settings` | Open interactive settings overlay |
| `/pruner on` / `off` | Enable / disable pruning |
| `/pruner status` | Show config + cumulative stats + context usage |
| `/pruner model [id]` | Get/set summarizer model |
| `/pruner model id:thinking` | Set model + thinking level together |
| `/pruner thinking [level]` | Get/set summarizer thinking level |
| `/pruner prune-on [mode]` | Get/set trigger mode |
| `/pruner batching [mode]` | Get/set batching mode (`turn` or `agent-message`) |
| `/pruner stats` | Show cumulative summarizer token/cost stats |
| `/pruner tree` | Browse pruned tool calls in foldable tree |
| `/pruner now` | Flush pending tool calls immediately with live progress |
| `/pruner help` | Full help text |

## Tools

### `context_tree_query`

Always available when the extension is loaded. Lets the LLM recover any pruned output by ID or short ref (`t1`, `t2`, etc.).

### `context_prune` (agentic-auto mode only)

Activated only when `pruneOn` is `"agentic-auto"`. The model calls it after a meaningful batch of work to compact context. Streams live progress in the tool output box.

## Configuration

Config stored in `~/.pi/agent/context-prune/settings.json`:

```json
{
  "enabled": false,
  "showPruneStatusLine": true,
  "summarizerModel": "default",
  "summarizerThinking": "default",
  "pruneOn": "agent-message",
  "batchingMode": "turn",
  "remindUnprunedCount": true
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | `true` / `false` | `false` |
| `showPruneStatusLine` | `true` / `false` | `true` |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` |
| `summarizerThinking` | `"default"`, `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` | `"default"` |
| `pruneOn` | `"every-turn"`, `"on-context-tag"`, `"on-demand"`, `"agent-message"`, `"agentic-auto"` | `"agent-message"` |
| `batchingMode` | `"turn"`, `"agent-message"` | `"turn"` |
| `remindUnprunedCount` | `true` / `false` | `true` |

### Choosing a Summarizer Model

`"default"` reuses the active Pi model. **Using a cheaper model saves both latency and cost** — you don't need a powerful coding model to write summaries.

| Provider | Recommended summarizer |
|---|---|
| GitHub Copilot / Codex | `openai/gpt-4.1-mini` or `google/gemini-2.5-flash` |
| OpenRouter | `openrouter/qwen/qwen3-30b-a3b` |
| Anthropic direct | `anthropic/claude-haiku-3-5` |
| Google AI direct | `google/gemini-2.5-flash` |

## Architecture

```
index.ts                    — entry point, wires events + modules
src/
  types.ts                  — shared types, constants, FlushResult, PruneOn modes
  config.ts                 — load/save ~/.pi/agent/context-prune/settings.json
  batch-capture.ts          — serialize turn_end event → CapturedBatch
  summarizer.ts             — structured JSON summarization (max 3 groups)
  indexer.ts                — Map<toolCallId, ToolCallRecord> + session persistence
  pruner.ts                 — filter context event messages
  frontier.ts               — persisted prune-frontier tracker
  query-tool.ts             — context_tree_query tool
  context-prune-tool.ts     — context_prune tool (agentic-auto)
  stats.ts                  — StatsAccumulator for token/cost tracking
  summary-refs.ts           — short alias (t1, t2…) mapping
  tree-browser.ts           — foldable tree browser for /pruner tree
  multi-batch-loader.ts     — progress overlay for /pruner now
  commands.ts               — /pruner command + settings + message renderer
  reminder.ts               — unpruned-count reminder (agentic-auto)
```

### Event flow

```
session_start
  └─► Single branch scan → indexer + stats + frontier reconstruct
  └─► loadConfig() + syncToolActivation()

session_tree
  └─► Single branch scan → indexer + stats + frontier reconstruct

turn_end (enabled + tool calls)
  └─► captureBatch() → pendingBatches
  └─► if every-turn: flushPending() immediately

context (enabled + index non-empty)
  └─► pruneMessages() — remove indexed toolResult messages
  └─► if agentic-auto: annotate with unpruned count reminder

flushPending()
  └─► classifyBatches() — small (<800 chars) vs summarizable
  └─► summarizeAllBatches() — max 3 structured JSON LLM groups
  └─► processResults() — persist/index, skip oversized, advance frontier
  └─► update context usage in status widget
```

## Limitations

- Summarization only runs when pruning is **enabled** — mid-session enable does not retroactively summarize
- `context_tree_query` only works while the extension is loaded
- Summarizer call adds latency between turns proportional to the model's response time
- Summary grouping across multiple turns (meta-summaries) is a follow-up item
