import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PruneFrontier } from "../../src/types.js";

// ── Inline: PruneFrontierTracker (no external deps beyond types) ──────

const CUSTOM_TYPE_FRONTIER = "context-prune-frontier";

class PruneFrontierTracker {
  private frontier: PruneFrontier | null = null;

  reset(): void {
    this.frontier = null;
  }

  get(): PruneFrontier | null {
    return this.frontier ? { ...this.frontier } : null;
  }

  fromJSON(data: PruneFrontier): void {
    if (!data?.lastAttemptedToolCallId) return;
    this.frontier = {
      lastAttemptedToolCallId: data.lastAttemptedToolCallId,
      lastAttemptedToolName: data.lastAttemptedToolName ?? "unknown",
      lastAttemptedTurnIndex: data.lastAttemptedTurnIndex ?? 0,
      lastAttemptedTimestamp: data.lastAttemptedTimestamp ?? 0,
      attemptedBatchCount: data.attemptedBatchCount ?? 0,
      attemptedToolCallCount: data.attemptedToolCallCount ?? 0,
      rawCharCount: data.rawCharCount ?? 0,
      summaryCharCount: data.summaryCharCount ?? 0,
      outcome: data.outcome ?? "summarized",
    };
  }

  advance(frontier: PruneFrontier): void {
    this.frontier = { ...frontier };
  }

  persist(api: { appendEntry: (type: string, data: PruneFrontier) => void }): void {
    if (!this.frontier) return;
    api.appendEntry(CUSTOM_TYPE_FRONTIER, this.frontier);
  }

  reconstructFromSession(
    ctx: { sessionManager: { getBranch: () => any[] } },
    branch?: any[]
  ): void {
    this.reset();
    const entries = branch ?? ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === CUSTOM_TYPE_FRONTIER
      ) {
        const data = entry.data as PruneFrontier;
        if (data) {
          this.fromJSON(data);
        }
      }
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("PruneFrontierTracker", () => {
  let tracker: PruneFrontierTracker;

  beforeEach(() => {
    tracker = new PruneFrontierTracker();
  });

  it("returns null when frontier is not set", () => {
    expect(tracker.get()).toBeNull();
  });

  it("stores and retrieves frontier after advance", () => {
    tracker.advance({
      lastAttemptedToolCallId: "tc1",
      lastAttemptedToolName: "read",
      lastAttemptedTurnIndex: 5,
      lastAttemptedTimestamp: 1000,
      attemptedBatchCount: 2,
      attemptedToolCallCount: 8,
      rawCharCount: 4000,
      summaryCharCount: 600,
      outcome: "summarized",
    });

    const got = tracker.get();
    expect(got).not.toBeNull();
    expect(got!.lastAttemptedToolCallId).toBe("tc1");
    expect(got!.outcome).toBe("summarized");
  });

  it("returns a copy (not the same reference)", () => {
    tracker.advance({
      lastAttemptedToolCallId: "tc1",
      lastAttemptedToolName: "read",
      lastAttemptedTurnIndex: 1,
      lastAttemptedTimestamp: 0,
      attemptedBatchCount: 1,
      attemptedToolCallCount: 1,
      rawCharCount: 100,
      summaryCharCount: 50,
      outcome: "summarized",
    });

    const first = tracker.get()!;
    first.lastAttemptedToolCallId = "mutated";
    expect(tracker.get()!.lastAttemptedToolCallId).toBe("tc1");
  });

  it("clears frontier on reset", () => {
    tracker.advance({
      lastAttemptedToolCallId: "tc1",
      lastAttemptedToolName: "read",
      lastAttemptedTurnIndex: 1,
      lastAttemptedTimestamp: 0,
      attemptedBatchCount: 1,
      attemptedToolCallCount: 1,
      rawCharCount: 100,
      summaryCharCount: 50,
      outcome: "summarized",
    });
    tracker.reset();
    expect(tracker.get()).toBeNull();
  });

  it("advance overwrites previous frontier", () => {
    tracker.advance({
      lastAttemptedToolCallId: "tc1",
      lastAttemptedToolName: "read",
      lastAttemptedTurnIndex: 1,
      lastAttemptedTimestamp: 0,
      attemptedBatchCount: 1,
      attemptedToolCallCount: 1,
      rawCharCount: 100,
      summaryCharCount: 50,
      outcome: "summarized",
    });

    tracker.advance({
      lastAttemptedToolCallId: "tc5",
      lastAttemptedToolName: "edit",
      lastAttemptedTurnIndex: 8,
      lastAttemptedTimestamp: 200,
      attemptedBatchCount: 4,
      attemptedToolCallCount: 15,
      rawCharCount: 8000,
      summaryCharCount: 1200,
      outcome: "summarized",
    });

    const got = tracker.get();
    expect(got!.lastAttemptedToolCallId).toBe("tc5");
    expect(got!.attemptedBatchCount).toBe(4);
  });

  describe("fromJSON", () => {
    it("loads all fields correctly", () => {
      tracker.fromJSON({
        lastAttemptedToolCallId: "tc99",
        lastAttemptedToolName: "edit",
        lastAttemptedTurnIndex: 42,
        lastAttemptedTimestamp: 999,
        attemptedBatchCount: 10,
        attemptedToolCallCount: 50,
        rawCharCount: 30000,
        summaryCharCount: 5000,
        outcome: "skipped-oversized",
      });

      const got = tracker.get();
      expect(got!.lastAttemptedToolCallId).toBe("tc99");
      expect(got!.outcome).toBe("skipped-oversized");
      expect(got!.attemptedBatchCount).toBe(10);
    });

    it("applies defaults for missing fields", () => {
      tracker.fromJSON({
        lastAttemptedToolCallId: "tc1",
        lastAttemptedToolName: "read",
      });

      const got = tracker.get();
      expect(got!.lastAttemptedTurnIndex).toBe(0);
      expect(got!.lastAttemptedTimestamp).toBe(0);
      expect(got!.attemptedBatchCount).toBe(0);
      expect(got!.outcome).toBe("summarized");
    });

    it("ignores incomplete data (no lastAttemptedToolCallId)", () => {
      tracker.fromJSON({} as PruneFrontier);
      expect(tracker.get()).toBeNull();
    });
  });

  describe("persist", () => {
    it("calls appendEntry with frontier data", () => {
      const mockApi = {
        appendEntry: vi.fn(),
      };

      tracker.advance({
        lastAttemptedToolCallId: "tc1",
        lastAttemptedToolName: "read",
        lastAttemptedTurnIndex: 5,
        lastAttemptedTimestamp: 1000,
        attemptedBatchCount: 2,
        attemptedToolCallCount: 8,
        rawCharCount: 4000,
        summaryCharCount: 600,
        outcome: "summarized",
      });

      tracker.persist(mockApi as any);
      expect(mockApi.appendEntry).toHaveBeenCalledTimes(1);
      const [customType, data] = mockApi.appendEntry.mock.calls[0];
      expect(customType).toBe(CUSTOM_TYPE_FRONTIER);
      expect(data.lastAttemptedToolCallId).toBe("tc1");
    });

    it("does nothing when frontier is null", () => {
      const mockApi = { appendEntry: vi.fn() };
      tracker.persist(mockApi as any);
      expect(mockApi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe("reconstructFromSession", () => {
    it("finds the last frontier entry in the session", () => {
      const mockCtx = {
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: CUSTOM_TYPE_FRONTIER,
              data: { lastAttemptedToolCallId: "tc-old", lastAttemptedTurnIndex: 1 },
            },
            {
              type: "custom",
              customType: CUSTOM_TYPE_FRONTIER,
              data: { lastAttemptedToolCallId: "tc-new", lastAttemptedTurnIndex: 8 },
            },
          ],
        },
      };

      tracker.reconstructFromSession(mockCtx as any);
      expect(tracker.get()!.lastAttemptedToolCallId).toBe("tc-new");
    });

    it("resets when no frontier entries exist", () => {
      tracker.advance({
        lastAttemptedToolCallId: "tc1",
        lastAttemptedToolName: "read",
        lastAttemptedTurnIndex: 1,
        lastAttemptedTimestamp: 0,
        attemptedBatchCount: 1,
        attemptedToolCallCount: 1,
        rawCharCount: 100,
        summaryCharCount: 50,
        outcome: "summarized",
      });

      const mockCtx = {
        sessionManager: { getBranch: () => [] },
      };

      tracker.reconstructFromSession(mockCtx as any);
      expect(tracker.get()).toBeNull();
    });

    it("accepts a custom branch argument", () => {
      const customBranch = [
        {
          type: "custom",
          customType: CUSTOM_TYPE_FRONTIER,
          data: { lastAttemptedToolCallId: "tc-custom", lastAttemptedTurnIndex: 3 },
        },
      ];

      tracker.reconstructFromSession({} as any, customBranch);
      expect(tracker.get()!.lastAttemptedToolCallId).toBe("tc-custom");
    });
  });
});
