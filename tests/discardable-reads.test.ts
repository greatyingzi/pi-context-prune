import { describe, it, expect } from "vitest";
import type { CapturedBatch } from "../../src/types.js";

// ── Inline implementation of filePathFromArgs (from batch-capture.ts) ──

function filePathFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const path = args.path ?? args.filePath;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return undefined;
}

// ── Inline implementation of detectDiscardableReads (from batch-capture.ts) ──

function detectDiscardableReads(batches: CapturedBatch[]): Set<string> {
  const discardable = new Set<string>();

  interface FileOp {
    toolCallId: string;
    toolName: string;
    path: string;
    order: number;
  }
  const ops: FileOp[] = [];
  let order = 0;
  for (const batch of batches) {
    for (const tc of batch.toolCalls) {
      const path = filePathFromArgs(tc.toolName, tc.args);
      if (path) {
        ops.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, path, order });
      }
      order++;
    }
  }

  const opsByPath = new Map<string, FileOp[]>();
  for (const op of ops) {
    if (!opsByPath.has(op.path)) opsByPath.set(op.path, []);
    opsByPath.get(op.path)!.push(op);
  }

  for (const [_path, fileOps] of opsByPath) {
    const mutationIndices: number[] = [];
    fileOps.forEach((op, i) => {
      if (op.toolName === "edit" || op.toolName === "write") {
        mutationIndices.push(i);
      }
    });

    if (mutationIndices.length === 0) {
      const reads = fileOps.filter((op) => op.toolName === "read");
      if (reads.length > 1) {
        for (let i = 0; i < reads.length - 1; i++) {
          discardable.add(reads[i].toolCallId);
        }
      }
      continue;
    }

    const lastMutationIdx = mutationIndices[mutationIndices.length - 1];

    let segmentStart = 0;
    const mutationBoundaries = [...mutationIndices];
    mutationBoundaries.push(fileOps.length);

    for (let b = 0; b < mutationBoundaries.length; b++) {
      const boundary = mutationBoundaries[b];
      const segmentOps = fileOps.slice(segmentStart, boundary);
      const segmentReads = segmentOps.filter((op) => op.toolName === "read");
      const isPreMutation = b < mutationIndices.length;

      if (segmentReads.length > 1) {
        for (let i = 0; i < segmentReads.length - 1; i++) {
          discardable.add(segmentReads[i].toolCallId);
        }
      }

      if (isPreMutation && segmentReads.length > 0) {
        discardable.add(segmentReads[segmentReads.length - 1].toolCallId);
      }

      segmentStart = boundary;
    }
  }

  return discardable;
}

// ── Helpers ──

function makeBatch(
  turnIndex: number,
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, any>;
    resultText: string;
  }>
): CapturedBatch {
  return {
    turnIndex,
    timestamp: Date.now() + turnIndex,
    assistantText: "",
    toolCalls: toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      status: "success",
    })),
  };
}

// ── Tests ──

describe("detectDiscardableReads", () => {
  it("marks all-but-last reads as discardable when file is never mutated", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "r1", toolName: "read", args: { path: "a.txt" }, resultText: "v1" }]),
      makeBatch(2, [{ toolCallId: "r2", toolName: "read", args: { path: "a.txt" }, resultText: "v2" }]),
      makeBatch(3, [{ toolCallId: "r3", toolName: "read", args: { path: "a.txt" }, resultText: "v3" }]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("r1")).toBe(true);
    expect(result.has("r2")).toBe(true);
    expect(result.has("r3")).toBe(false);
  });

  it("marks pre-edit reads as stale", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "r1", toolName: "read", args: { path: "a.txt" }, resultText: "v1" }]),
      makeBatch(2, [{ toolCallId: "e1", toolName: "edit", args: { path: "a.txt" }, resultText: "edited" }]),
      makeBatch(3, [{ toolCallId: "r2", toolName: "read", args: { path: "a.txt" }, resultText: "v2" }]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("r1")).toBe(true);
    expect(result.has("r2")).toBe(false);
  });

  it("keeps only the last read in post-edit segment", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "r1", toolName: "read", args: { path: "a.txt" }, resultText: "v1" }]),
      makeBatch(2, [{ toolCallId: "e1", toolName: "edit", args: { path: "a.txt" }, resultText: "edited" }]),
      makeBatch(3, [{ toolCallId: "r2", toolName: "read", args: { path: "a.txt" }, resultText: "v2" }]),
      makeBatch(4, [{ toolCallId: "r3", toolName: "read", args: { path: "a.txt" }, resultText: "v3" }]),
      makeBatch(5, [{ toolCallId: "r4", toolName: "read", args: { path: "a.txt" }, resultText: "v4" }]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("r1")).toBe(true);
    expect(result.has("r2")).toBe(true);
    expect(result.has("r3")).toBe(true);
    expect(result.has("r4")).toBe(false);
  });

  it("handles write as a mutation boundary", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "r1", toolName: "read", args: { path: "a.txt" }, resultText: "v1" }]),
      makeBatch(2, [{ toolCallId: "w1", toolName: "write", args: { path: "a.txt" }, resultText: "written" }]),
      makeBatch(3, [{ toolCallId: "r2", toolName: "read", args: { path: "a.txt" }, resultText: "v2" }]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("r1")).toBe(true);
    expect(result.has("r2")).toBe(false);
  });

  it("handles multiple files independently", () => {
    const batches = [
      makeBatch(1, [
        { toolCallId: "ra1", toolName: "read", args: { path: "a.txt" }, resultText: "va1" },
        { toolCallId: "rb1", toolName: "read", args: { path: "b.txt" }, resultText: "vb1" },
      ]),
      makeBatch(2, [{ toolCallId: "ra2", toolName: "read", args: { path: "a.txt" }, resultText: "va2" }]),
      makeBatch(3, [
        { toolCallId: "ea1", toolName: "edit", args: { path: "a.txt" }, resultText: "edited a" },
        { toolCallId: "rb2", toolName: "read", args: { path: "b.txt" }, resultText: "vb2" },
      ]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("ra1")).toBe(true);  // pre-edit, stale
    expect(result.has("ra2")).toBe(true);  // pre-edit, stale (only read after edit is ra1→ea1, ra2 is between ra1 and ea1)
    expect(result.has("rb1")).toBe(true);  // duplicate (rb2 is last)
    expect(result.has("rb2")).toBe(false); // kept
  });

  it("handles multiple mutations with interleaved reads", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "r1", toolName: "read", args: { path: "a.txt" }, resultText: "v1" }]),
      makeBatch(2, [{ toolCallId: "e1", toolName: "edit", args: { path: "a.txt" }, resultText: "e1" }]),
      makeBatch(3, [{ toolCallId: "r2", toolName: "read", args: { path: "a.txt" }, resultText: "v2" }]),
      makeBatch(4, [{ toolCallId: "e2", toolName: "edit", args: { path: "a.txt" }, resultText: "e2" }]),
      makeBatch(5, [{ toolCallId: "r3", toolName: "read", args: { path: "a.txt" }, resultText: "v3" }]),
      makeBatch(6, [{ toolCallId: "r4", toolName: "read", args: { path: "a.txt" }, resultText: "v4" }]),
    ];
    const result = detectDiscardableReads(batches);
    expect(result.has("r1")).toBe(true);  // before e1
    expect(result.has("r2")).toBe(true);  // between e1 and e2 (pre-edit e2)
    expect(result.has("r3")).toBe(true);  // after e2 but not last
    expect(result.has("r4")).toBe(false); // last read
  });

  it("ignores non-file tool calls", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "s1", toolName: "search", args: { query: "foo" }, resultText: "match" }]),
      makeBatch(2, [{ toolCallId: "s2", toolName: "bash", args: { command: "ls" }, resultText: "ok" }]),
    ];
    expect(detectDiscardableReads(batches).size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(detectDiscardableReads([]).size).toBe(0);
  });
});
