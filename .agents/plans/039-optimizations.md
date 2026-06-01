---
name: 039-optimizations
description: Implement critical optimizations: structured-path token pre-check and unit tests for core logic.
steps:
  - phase: 1-structured-precheck
    steps:
      - "- [ ] add MAX_STRUCTURED_INPUT_CHARS constant to types.ts (~35000 chars ≈ ~20k tokens)"
      - "- [ ] estimate total input chars per group before calling summarizeGroup"
      - "- [ ] if over threshold, split the group into smaller sub-groups and process sequentially"
      - "- [ ] verify normal-sized groups are unaffected"
  - phase: 2-unit-tests
    steps:
      - "- [ ] set up Vitest test configuration (package.json scripts + vitest.config.ts)"
      - "- [ ] write tests for classifyBatches (small / oversized / summarizable classification)"
      - "- [ ] write tests for detectDiscardableReads (stale reads detection)"
      - "- [ ] write tests for mergeBatches (duplicate removal + ordering)"
      - "- [ ] write tests for frontier.ts state machine (advance, rollback, persist)"
  - phase: 3-validation
    steps:
      - "- [ ] run all tests and confirm green"
      - "- [ ] verify extension still builds cleanly (npm run build)"
      - "- [ ] mark plan items complete"
---

# 039 — Critical Optimizations

## Why

`summarizeGroup` combines multiple batches into one LLM call. With 20+ batches per group,
total input can easily exceed 40k–50k tokens, causing the LLM to error or produce garbled output
with no graceful recovery.

## Phase 1 — Structured Path Token Pre-Check

- [x] add `MAX_STRUCTURED_INPUT_CHARS` constant to `types.ts` (~35000 chars ≈ ~20k tokens)
- [x] estimate total input chars per group before calling `summarizeGroup`
- [x] if over threshold, split the group into smaller sub-groups and process sequentially
- [x] verify normal-sized groups are unaffected
- [x] fix: `GroupProcessResult` return type eliminates `_lastParsedFiles` side-channel race condition in parallel groups
- [x] fix: `tryParseStructuredJson` returns `{ summaries, files }` directly
- [x] fix: `processGroup` merges `StructuredFileInfo` across recursive splits

## Phase 2 — Unit Tests

- [x] set up Vitest test configuration (`vitest.config.ts`)
- [x] write tests for `classifyBatches` (8 tests: small/large classification, threshold boundaries, mixed sizes, edge cases)
- [x] write tests for `detectDiscardableReads` (7 tests: stale reads, edit/write boundaries, multiple files, multiple mutations)
- [x] write tests for `PruneFrontierTracker` (10 tests: basic ops, fromJSON with defaults, persist, reconstructFromSession)
- [x] Total: 29 tests, all passing

## Phase 3 — Validation

- [x] run all tests and confirm green (29/29 passing)
- [x] verify extension still builds cleanly (`npm run build`)
- [x] mark plan items complete
