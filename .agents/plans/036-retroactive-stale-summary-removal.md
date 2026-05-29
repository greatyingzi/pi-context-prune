---
name: 036-retroactive-stale-summary-removal
description: Detect stale summaries (reads of files later edited) and remove them from context, not just the raw tool results.
steps:
  - phase: extend-indexer
    steps:
      - "- [ ] step 1: add filePath to ToolCallRecord, extract and store during addBatch"
      - "- [ ] step 2: add stale set + detectStaleRecords() to indexer"
      - "- [ ] step 3: trigger stale detection after each flush"
  - phase: update-pruner
    steps:
      - "- [ ] step 4: extend pruneMessages to also remove stale summary messages"
  - phase: validation
    steps:
      - "- [ ] step 5: brace balance + commit + push"
---

# 036 — Retroactive stale summary removal

## Phase 1 — Extend indexer
- [ ] step 1: add filePath to ToolCallRecord, extract and store during addBatch
- [ ] step 2: add stale set + detectStaleRecords() to indexer
- [ ] step 3: trigger stale detection after each flush

## Phase 2 — Update pruner
- [ ] step 4: extend pruneMessages to also remove stale summary messages

## Phase 3 — Validation
- [ ] step 5: brace balance + commit + push

## Design

When a file is edited, all prior summaries of reads of that file become stale.
We detect this retroactively by scanning the indexer after each flush:

1. Indexer stores filePath for each tool call record
2. detectStaleRecords() finds all read records whose file was later edited
3. These are added to a stale set in the indexer
4. pruneMessages() removes:
   - toolResult messages (existing behavior)
   - summary messages whose toolCallRefs are ALL stale (new behavior)

This means stale summaries vanish from context entirely, freeing space.
The original data is still recoverable via context_tree_query.
