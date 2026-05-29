---
name: 038-knowledge-graph
description: Add a knowledge graph that organizes summarized tool results by file, appended after each flush as structured context.
steps:
  - phase: design
    steps:
      - "- [x] step 1: design FileKnowledge structure and graph update flow"
  - phase: implementation
    steps:
      - "- [ ] step 2: add FileKnowledge types to types.ts"
      - "- [ ] step 3: add KnowledgeGraph class to src/knowledge-graph.ts"
      - "- [ ] step 4: add buildKnowledgeFromBatch() to extract file knowledge from summaries"
      - "- [ ] step 5: integrate graph update into flushPending after processResults"
      - "- [ ] step 6: serialize graph and append to context (last summary message or steer)"
      - "- [ ] step 7: persist graph to session for reconstruction"
  - phase: validation
    steps:
      - "- [ ] step 8: brace balance + commit + push"
---

# 038 — Knowledge Graph

## Phase 1 — Design
- [x] step 1: design FileKnowledge structure and graph update flow

## Phase 2 — Implementation
- [ ] step 2: add FileKnowledge types to types.ts
- [ ] step 3: add KnowledgeGraph class to src/knowledge-graph.ts
- [ ] step 4: add buildKnowledgeFromBatch() to extract file knowledge from summaries
- [ ] step 5: integrate graph update into flushPending after processResults
- [ ] step 6: serialize graph and append to context (last summary message or steer)
- [ ] step 7: persist graph to session for reconstruction

## Phase 3 — Validation
- [ ] step 8: brace balance + commit + push

## Design

### FileKnowledge structure
```typescript
interface FileKnowledge {
  path: string;
  exports: string[];       // exported names
  imports: string[];       // import statements
  structure: string[];     // interfaces, classes, functions (signatures only)
  changes: string[];       // recent edit descriptions
  lastReadTurn: number;    // turn of last read
  lastEditTurn: number;    // turn of last edit
}
```

### Update flow (after each flush)
1. For each summarized batch, extract file paths from tool calls
2. For `read` calls: parse summary for exports/imports/structure
3. For `edit` calls: add change description
4. Update FileKnowledge map (new data overwrites old for same file)
5. Serialize graph to compact text, inject into context

### Persistence
- Stored as custom session entry (CUSTOM_TYPE_KNOWLEDGE)
- Rebuilt on session_start like index/stats

### Context injection
- Serialized graph appended as a steer message after summaries
- Format: compact key-per-file block, not verbose prose
