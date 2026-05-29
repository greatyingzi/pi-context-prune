---
name: 037b-enhance-clean-summary-removal
description: Enhance /pruner clean to also remove stale summary messages and improve LLM evaluation prompt aggressiveness.
steps:
  - phase: implementation
    steps:
      - "- [ ] step 1: clean also removes stale summary messages from context"
      - "- [ ] step 2: improve LLM prompt to be more aggressive + add summary context"
  - phase: validation
    steps:
      - "- [ ] step 3: brace balance + commit + push"
---

# 037b — Enhance /pruner clean

## Phase 1 — Implementation
- [ ] step 1: clean also removes stale summary messages from context
- [ ] step 2: improve LLM prompt to be more aggressive + add summary context

## Phase 2 — Validation
- [ ] step 3: brace balance + commit + push

## Root cause analysis

The clean command only found 1 removal because:
1. Most tool calls were already flushed — their toolResults are gone, only summaries remain
2. detectStaleRecords() only works on indexer records, not on candidates
3. LLM was too conservative — returned 0 removals

## Fix

1. Also scan for stale summary messages (customType: context-prune-summary)
   and add their toolCallRef IDs to the stale set
2. Improve LLM prompt to be more aggressive about removing old content
3. Pass summary info to LLM so it can identify stale summaries
