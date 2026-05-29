import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, IndexEntryData, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  type SummaryToolCallRef,
} from "./summary-refs.js";

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();
  private aliasToToolCallId = new Map<string, string>();
  private nextShortAliasNumber = 1;
  /** Set of toolCallIds whose content is stale (e.g. reads of files later edited). */
  private stale = new Set<string>();

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   * Accepts an optional pre-fetched branch to avoid redundant scans.
   */
  reconstructFromSession(ctx: ExtensionContext, branch?: any[]): void {
    this.index.clear();
    this.aliasToToolCallId.clear();
    this.nextShortAliasNumber = 1;
    this.stale.clear();

    const entries = branch ?? ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            this.index.set(toolCall.toolCallId, toolCall);
          }
        }
        continue;
      }

      if (entry.type === "custom_message" && (entry as any).customType === CUSTOM_TYPE_SUMMARY) {
        const refs = normalizeSummaryToolCallRefs((entry as any).details);
        this.registerSummaryRefs(refs);
      }
    }

    // Detect stale records from the reconstructed index
    this.detectStaleRecords();
  }

  /**
   * Returns true if the given toolCallId has been summarized (exists in index).
   */
  isSummarized(toolCallId: string): boolean {
    return this.index.has(toolCallId);
  }

  /** Extract file path from tool call args if applicable (read/edit/write). */
  private extractFilePath(toolName: string, args: Record<string, unknown>): string | undefined {
    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      const p = args.path ?? args.filePath;
      return typeof p === "string" ? p : undefined;
    }
    return undefined;
  }

  /**
   * Scan all indexed records to detect stale reads.
   * A read is stale if the file it read was later edited/written by another indexed record.
   * Called after each flush to retroactively mark old reads as stale.
   */
  detectStaleRecords(): void {
    // Collect all files that have been mutated (edit/write)
    const mutatedFiles = new Map<string, number[]>(); // path → [order indices of mutations]
    const readRecords = new Map<string, Array<{ toolCallId: string; order: number }>>(); // path → reads

    let order = 0;
    for (const [_id, record] of this.index) {
      const path = record.filePath;
      if (!path) { order++; continue; }

      if (record.toolName === "edit" || record.toolName === "write") {
        if (!mutatedFiles.has(path)) mutatedFiles.set(path, []);
        mutatedFiles.get(path)!.push(order);
      } else if (record.toolName === "read") {
        if (!readRecords.has(path)) readRecords.set(path, []);
        readRecords.get(path)!.push({ toolCallId: record.toolCallId, order });
      }
      order++;
    }

    // For each file with reads, find reads that precede any mutation
    for (const [path, reads] of readRecords) {
      const mutations = mutatedFiles.get(path);
      if (!mutations || mutations.length === 0) continue; // no edits → nothing stale

      for (const read of reads) {
        // If this read comes before ANY mutation of the same file, it's stale
        if (mutations.some((mOrder) => read.order < mOrder)) {
          this.stale.add(read.toolCallId);
        }
      }
    }
  }

  /** Check if a toolCallId is marked as stale. */
  isStale(toolCallId: string): boolean {
    return this.stale.has(toolCallId);
  }

  /** Get all stale toolCallIds. */
  getStaleIds(): Set<string> {
    return this.stale;
  }

  /**
   * Returns the full runtime index map.
   */
  getIndex(): Map<string, ToolCallRecord> {
    return this.index;
  }

  /**
   * Register short aliases for a summary message so future recovery queries can
   * resolve the short ids back to the persisted toolCallIds.
   */
  registerSummaryRefs(refs: SummaryToolCallRef[]): void {
    for (const ref of refs) {
      if (!ref.shortId || !ref.toolCallId) continue;
      if (ref.shortId !== ref.toolCallId) {
        this.aliasToToolCallId.set(ref.shortId, ref.toolCallId);
      }
      const match = /^t(\d+)$/.exec(ref.shortId);
      if (match) {
        this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
      }
    }
  }

  /**
   * Allocates short aliases for a batch's tool calls and registers them in the
   * runtime alias map.
   */
  allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[] {
    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const { refs, nextIndex } = buildShortToolCallRefs(toolCallIds, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  /**
   * Resolve a short alias or a full toolCallId to the canonical toolCallId.
   */
  resolveToolCallId(toolCallIdOrAlias: string): string | undefined {
    if (this.index.has(toolCallIdOrAlias)) return toolCallIdOrAlias;
    return this.aliasToToolCallId.get(toolCallIdOrAlias);
  }

  /**
   * Look up a single record by toolCallId or short alias (used by query tool).
   */
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (!resolved) return undefined;
    return this.index.get(resolved);
  }

  /**
   * Looks up multiple tool call records by ID. Skips any IDs not found.
   */
  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.getRecord(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Adds all tool calls from a captured batch to the runtime index and
   * persists an IndexEntryData entry to the session via pi.appendEntry.
   */
  addBatch(batch: CapturedBatch, pi: ExtensionAPI): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
        filePath: this.extractFilePath(tc.toolName, tc.args),
      };
      this.index.set(record.toolCallId, record);
      records.push(record);
    }

    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);

    // Re-detect stale records after adding new entries
    this.detectStaleRecords();
  }
}
