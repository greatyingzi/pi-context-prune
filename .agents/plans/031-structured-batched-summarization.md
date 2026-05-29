---
name: 031-structured-batched-summarization
description: Replace the parallel-per-batch summarization (N LLM calls) with a single structured LLM call that summarizes all pending batches at once, using XML tags to delimit each turn and JSON output for machine parsing.
steps:
  - phase: design
    steps:
      - "- [x] step 1: define the structured JSON output schema — one entry per batch with turnIndex, summaryText"
      - "- [x] step 2: define the prompt template — XML-delimited batch sections + JSON output instructions"
      - "- [ ] step 3: decide on max batches per call (chunk if > threshold, e.g. 20 batches → 2 calls)"
  - phase: implementation_types
    steps:
      - "- [x] step 1: inline JSON parsing types in tryParseStructuredJson() — no separate types needed"
      - "- [ ] step 2: add SummarizeBatchesStrategy config option if needed (structured vs parallel), or make it the default"
  - phase: implementation_serialization
    steps:
      - "- [x] step 1: add serializeAllBatchesForStructured() in src/batch-capture.ts — wraps each batch in <turn index=\"N\">...</turn> XML tags"
  - phase: implementation_summarizer
    steps:
      - "- [x] step 1: add summarizeAllBatches() function in src/summarizer.ts — single LLM call with structured prompt, returns parsed JSON"
      - "- [x] step 2: implement JSON parsing with fallback — if the LLM returns malformed JSON, attempt repair or fall back to the old parallel path"
      - "- [ ] step 3: add chunking logic — if batch count exceeds threshold, split into 2+ calls"
  - phase: implementation_flush
    steps:
      - "- [x] step 1: refactor flushPending in index.ts to use the new structured path by default (replacing the parallel summarizeBatches path)"
      - "- [x] step 2: adapt the per-batch result processing loop to work with the structured output"
      - "- [x] step 3: keep the progress widget / onProgress callbacks working (sequential reporting even though the LLM call is single)"
  - phase: validation
    steps:
      - "- [ ] step 1: verify the new path produces the same per-batch summary messages as before"
      - "- [ ] step 2: verify context_tree_query still works for recovered outputs"
      - "- [ ] step 3: verify /pruner tree shows correct summaries"
      - "- [ ] step 4: verify the progress widget still updates during the single LLM call"
  - phase: cleanup
    steps:
      - "- [ ] step 1: remove or deprecate the old parallel summarizeBatches path if no longer needed"
      - "- [ ] step 2: update AGENTS.md to describe the new structured summarization architecture"
      - "- [ ] step 3: commit and push"
---

# 031 — Structured batched summarization (single LLM call)

## Problem

Currently `flushPending` makes **one LLM call per batch** via `summarizeBatches()` (parallel `Promise.all`).
When there are 10 pending batches, that's 10 simultaneous LLM calls — each with its own system prompt,
authentication handshake, and overhead. This is wasteful in both cost and latency.

## Proposed Solution

Combine all pending batches into **a single LLM call** (or at most 2 for very large batches).
Use XML tags to clearly delimit each turn's content, instruct the LLM to produce a **structured JSON
output** with one summary entry per batch, then parse the JSON and distribute each entry back to its
corresponding batch for persistence.

### Prompt structure

```
<System prompt: summarize tool calls>

<batch turn="0">
  tool call 1...
  tool call 2...
</batch>

<batch turn="1">
  tool call 3...
</batch>

<output>
Return a JSON array with one object per batch:
[
  {
    "turnIndex": 0,
    "summary": "markdown summary of this turn's tool calls",
    "toolCalls": [
      { "toolCallId": "...", "name": "...", "outcome": "..." },
      ...
    ]
  },
  ...
]
</output>
```

### Benefits

| Aspect | Before (parallel) | After (structured) |
|--------|-------------------|-------------------|
| LLM calls | N (one per batch) | 1 (or 2 if chunked) |
| System prompt overhead | N copies | 1 copy |
| Authentication handshakes | N | 1 |
| Cost | Higher (repeated base cost) | Lower (shared context) |
| Latency | Max of N parallel calls | 1 serial call (usually faster overall) |
| Per-batch granularity | Native | Parsed from JSON |

## Phase 1 — Design

### D1. JSON output schema

```ts
interface StructuredSummaryEntry {
  turnIndex: number;
  summary: string;           // markdown summary text for this batch
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    outcome: string;         // 1-sentence outcome
  }>;
}

interface StructuredSummaryResult {
  entries: StructuredSummaryEntry[];
  usage: SummarizeResult["usage"];
}
```

### D2. Chunking threshold

If the combined serialized text of all batches exceeds ~60% of the model's context window,
split into 2 chunks (first half / second half). For most practical cases (< 20 batches),
a single call suffices.

### D3. Fallback strategy

If the LLM returns malformed JSON:
1. Attempt basic repair (trim markdown fences, fix trailing commas)
2. If still invalid, fall back to the old parallel-per-batch path for this flush
3. Log a warning to the user

## Phase 2 — Types (`src/types.ts`)

Add new types alongside existing ones:

```ts
export interface StructuredSummaryEntry {
  turnIndex: number;
  summary: string;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    outcome: string;
  }>;
}

export interface StructuredSummaryResult {
  entries: StructuredSummaryEntry[];
  usage: SummarizeResult["usage"];
}
```

## Phase 3 — Serialization (`src/batch-capture.ts`)

New function:

```ts
export function serializeAllBatchesForStructured(batches: CapturedBatch[]): string {
  // Wraps each batch in <batch turn="N">...</batch> XML tags
  // Reuses serializeBatchForSummarizer() for the inner content
}
```

## Phase 4 — Summarizer (`src/summarizer.ts`)

New function `summarizeAllBatches()`:

1. Serialize all batches with XML delimiters
2. Single LLM call with structured system + user prompt
3. Parse JSON response → `StructuredSummaryResult`
4. Handle malformed JSON with repair + fallback
5. Chunk into 2 calls if input exceeds threshold

Keep existing `summarizeBatch()` and `summarizeBatches()` for the fallback path and for
`/pruner now` sequential mode (which needs per-batch completion events for the progress overlay).

## Phase 5 — Flush integration (`index.ts`)

In `flushPending`:

1. Replace the `summarizeBatches()` call with `summarizeAllBatches()` for the parallel path
2. Map the parsed `entries` to the per-batch result array that the existing processing loop expects
3. Keep the per-batch persistence loop unchanged (it already handles one summary per batch)
4. For the sequential path (`onProgress` set), keep the existing `summarizeBatch` loop
   — the progress overlay needs per-batch completion events that a single call can't provide

## Phase 6 — Validation

Same validation criteria as the existing parallel path:
- Per-turn summary messages are written correctly
- `context_tree_query` recovers original outputs
- `/pruner tree` shows correct structure
- Frontier advances correctly
- Oversized detection still works per-batch

## Phase 7 — Cleanup

- Remove `summarizeBatches` if no longer referenced (or keep as fallback)
- Update AGENTS.md project context
- Commit and push
