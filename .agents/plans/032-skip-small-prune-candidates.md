---
name: 032-skip-small-prune-candidates
description: Add a pruning-candidate classification layer so tiny tool results skip LLM summarization, advance the prune frontier, and emit one aggregate info notification.
steps:
  - phase: design
    steps:
      - "- [x] step 1: define small-candidate thresholds and skip behavior"
      - "- [x] step 2: define outcome semantics for summarized, oversized, and skipped-small batches"
  - phase: implementation
    steps:
      - "- [x] step 1: add local classification helpers in index.ts"
      - "- [x] step 2: refactor flushPending to produce per-batch outcomes aligned with original batch order"
      - "- [x] step 3: skip small batches without LLM calls, still advancing frontier"
      - "- [x] step 4: add aggregate info notifications for skipped-small batches"
      - "- [x] step 5: extend FlushResult and PruneFrontier outcome types for skipped-small"
  - phase: documentation
    steps:
      - "- [x] step 1: update AGENTS.md to describe small-candidate filtering"
  - phase: validation
    steps:
      - "- [x] step 1: run lightweight grep/build checks"
      - "- [x] step 2: inspect git diff for correctness"
---

# 032 — Skip small prune candidates

## Phase 1 — Design
- [x] step 1: define small-candidate thresholds and skip behavior
- [x] step 2: define outcome semantics for summarized, oversized, and skipped-small batches

## Phase 2 — Implementation
- [x] step 1: add local classification helpers in index.ts
- [x] step 2: refactor flushPending to produce per-batch outcomes aligned with original batch order
- [x] step 3: skip small batches without LLM calls, still advancing frontier
- [x] step 4: add aggregate info notifications for skipped-small batches
- [x] step 5: extend FlushResult and PruneFrontier outcome types for skipped-small

## Phase 3 — Documentation
- [x] step 1: update AGENTS.md to describe small-candidate filtering

## Phase 4 — Validation
- [x] step 1: run lightweight grep/build checks
- [x] step 2: inspect git diff for correctness
