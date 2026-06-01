import { describe, it, expect } from "vitest";
import type { CapturedBatch } from "../../src/types.js";

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

function classifyBatches(batches: CapturedBatch[]) {
  const MIN_CHARS = 800;
  const smallBatchIndexes = new Set<number>();
  const summarizableBatches: { batch: CapturedBatch; originalIndex: number }[] = [];

  batches.forEach((batch, index) => {
    const rawChars = batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
    if (rawChars < MIN_CHARS) {
      smallBatchIndexes.add(index);
    } else {
      summarizableBatches.push({ batch, originalIndex: index });
    }
  });

  return { smallBatchIndexes, summarizableBatches };
}

describe("classifyBatches", () => {
  it("marks small batches (<800 chars) as skipped", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "t1", toolName: "search", args: {}, resultText: "short" }]),
    ];
    const result = classifyBatches(batches);
    expect(result.smallBatchIndexes.has(0)).toBe(true);
    expect(result.summarizableBatches.length).toBe(0);
  });

  it("marks large batches (>=800 chars) as summarizable", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(800) }]),
    ];
    const result = classifyBatches(batches);
    expect(result.smallBatchIndexes.has(0)).toBe(false);
    expect(result.summarizableBatches.length).toBe(1);
    expect(result.summarizableBatches[0].originalIndex).toBe(0);
  });

  it("sums across all tool calls in a batch", () => {
    const batches = [
      makeBatch(1, [
        { toolCallId: "t1", toolName: "read", args: {}, resultText: "a".repeat(500) },
        { toolCallId: "t2", toolName: "read", args: {}, resultText: "b".repeat(350) },
      ]),
    ];
    const result = classifyBatches(batches);
    expect(result.summarizableBatches.length).toBe(1); // 500+350=850 >= 800
  });

  it("handles exactly-at-threshold (800)", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(800) }]),
    ];
    const result = classifyBatches(batches);
    expect(result.summarizableBatches.length).toBe(1);
  });

  it("handles exactly-below-threshold (799)", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(799) }]),
    ];
    const result = classifyBatches(batches);
    expect(result.smallBatchIndexes.has(0)).toBe(true);
  });

  it("handles mixed sizes", () => {
    const batches = [
      makeBatch(1, [{ toolCallId: "t1", toolName: "search", args: {}, resultText: "x".repeat(100) }]),
      makeBatch(2, [{ toolCallId: "t2", toolName: "read", args: {}, resultText: "y".repeat(900) }]),
      makeBatch(3, [{ toolCallId: "t3", toolName: "search", args: {}, resultText: "z".repeat(200) }]),
    ];
    const result = classifyBatches(batches);
    expect(result.smallBatchIndexes.has(0)).toBe(true);
    expect(result.smallBatchIndexes.has(2)).toBe(true);
    expect(result.summarizableBatches.length).toBe(1);
    expect(result.summarizableBatches[0].originalIndex).toBe(1);
  });

  it("handles empty input", () => {
    const result = classifyBatches([]);
    expect(result.smallBatchIndexes.size).toBe(0);
    expect(result.summarizableBatches.length).toBe(0);
  });

  it("handles batch with zero tool calls", () => {
    const result = classifyBatches([makeBatch(1, [])]);
    expect(result.smallBatchIndexes.has(0)).toBe(true);
  });
});
