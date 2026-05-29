---
name: 037-pruner-clean-command
description: Add /pruner clean command that uses LLM to evaluate which old tool results are stale and can be removed from context.
steps:
  - phase: implementation
    steps:
      - "- [ ] step 1: add cleanToolResults() to src/cleaner.ts (LLM evaluation)"
      - "- [ ] step 2: add /pruner clean command to commands.ts"
      - "- [ ] step 3: wire up in index.ts flushPending dependency"
  - phase: validation
    steps:
      - "- [ ] step 4: brace balance + commit + push"
---

# 037 — /pruner clean command

## Phase 1 — Implementation
- [ ] step 1: add cleanToolResults() to src/cleaner.ts (LLM evaluation)
- [ ] step 2: add /pruner clean command to commands.ts
- [ ] step 3: wire up in index.ts flushPending dependency

## Phase 2 — Validation
- [ ] step 4: brace balance + commit + push

## Design

1. /pruner clean scans context for unindexed toolResults
2. Builds a compact list: toolCallId, toolName, args summary, turn index, result preview (100 chars)
3. Sends to LLM with evaluation prompt
4. LLM returns list of IDs to remove
5. IDs added to indexer (marked as summarized, no actual summary)
6. Next context event: pruneMessages auto-removes them
