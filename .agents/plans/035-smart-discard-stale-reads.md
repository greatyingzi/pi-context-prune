---
name: 035-smart-discard-stale-reads
description: Detect and discard stale/duplicate file reads before summarization — reads of files that were later edited, and earlier reads of files read multiple times.
steps:
  - phase: design
    steps:
      - "- [x] step 1: analyze read/write patterns and define discard rules"
  - phase: implementation
    steps:
      - "- [ ] step 2: add detectDiscardableReads() to batch-capture.ts"
      - "- [ ] step 3: integrate discardable detection into flushPending classify phase"
      - "- [ ] step 4: discardable tool calls get indexed but no summary (direct prune)"
      - "- [ ] step 5: add discardable count to FlushBreakdown and notification"
  - phase: validation
    steps:
      - "- [ ] step 6: brace balance + commit + push"
---

# 035 — Smart discard of stale file reads

## Phase 1 — Design
- [x] step 1: analyze read/write patterns and define discard rules

## Phase 2 — Implementation
- [ ] step 2: add detectDiscardableReads() to batch-capture.ts
- [ ] step 3: integrate discardable detection into flushPending classify phase
- [ ] step 4: discardable tool calls get indexed but no summary (direct prune)
- [ ] step 5: add discardable count to FlushBreakdown and notification

## Phase 3 — Validation
- [ ] step 6: brace balance + commit + push

## Discard Rules

### Rule 1: Stale reads (file was edited after read)
If a `read` of `path/to/file.ts` appears before an `edit`/`write` of the same file,
the read result is stale → discard (no summary needed).

### Rule 2: Duplicate reads (same file read multiple times)
If `path/to/file.ts` is read N times, keep only the last read.
Earlier reads → discard.

### What "discard" means:
- Tool call is added to indexer (so it's pruned from context)
- No summary message is created
- No LLM call is made
- `context_tree_query` still works (original result preserved in indexer)
- This is even cheaper than "small batch skip" — zero summarizer overhead
