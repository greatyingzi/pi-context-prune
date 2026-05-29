---
name: 033-codebase-cleanup-and-optimization
description: Comprehensive codebase cleanup — unify types, remove dead code, merge redundant branch scans, extract helpers, type ctx parameters.
steps:
  - phase: unify-types
    steps:
      - "- [x] step 1: move FlushResult to src/types.ts and update all consumers"
      - "- [x] step 2: unify Usage interface (remove duplicate from stats.ts, export from types.ts)"
  - phase: dead-code
    steps:
      - "- [x] step 3: remove unused summarizeBatches() from summarizer.ts"
      - "- [x] step 4: remove stale/duplicate JSDoc blocks from summarizer.ts"
      - "- [x] step 4b: remove orphaned serializeBatchesForSummarizer() from batch-capture.ts"
  - phase: performance
    steps:
      - "- [x] step 5: merge reconstructFromSession into single branch scan"
      - "- [x] step 6: optimize captureBatch to use pre-built resultMap (O(1) lookup)"
  - phase: architecture
    steps:
      - "- [x] step 7: extract classifyBatches() from flushPending"
      - "- [x] step 8: extract processResults() from flushPending"
      - "- [x] step 9: type ctx parameters (replace any with ExtensionContext)"
  - phase: validation
    steps:
      - "- [x] step 10: brace-balance check on all changed files"
      - "- [ ] step 11: git diff review and commit"
---

# 033 — Codebase cleanup and optimization

## Phase 1 — Unify types
- [x] step 1: move FlushResult to src/types.ts and update all consumers
- [x] step 2: unify Usage interface (remove duplicate from stats.ts, export SummarizerUsage from types.ts)

## Phase 2 — Dead code removal
- [x] step 3: remove unused summarizeBatches() from summarizer.ts
- [x] step 4: remove stale/duplicate JSDoc blocks from summarizer.ts
- [x] step 4b: remove orphaned serializeBatchesForSummarizer() from batch-capture.ts

## Phase 3 — Performance
- [x] step 5: merge reconstructFromSession into single branch scan
- [x] step 6: optimize captureBatch to use pre-built resultMap (O(1) lookup)

## Phase 4 — Architecture
- [x] step 7: extract classifyBatches() from flushPending
- [x] step 8: extract processResults() from flushPending
- [x] step 9: type ctx parameters (replace any with ExtensionContext)

## Phase 5 — Validation
- [x] step 10: brace-balance check on all changed files
- [ ] step 11: git diff review and commit
