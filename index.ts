/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save ~/.pi/agent/context-prune/settings.json
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode, detectDiscardableReads } from "./src/batch-capture.js";
import { cleanToolResults as doCleanToolResults } from "./src/cleaner.js";
import { KnowledgeGraph } from "./src/knowledge-graph.js";
import { summarizeBatch, summarizeAllBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { annotateWithUnprunedCount, countUnprunedToolCalls } from "./src/reminder.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { formatSummaryToolCallRefs, makeSummaryDetails } from "./src/summary-refs.js";
import type { ContextPruneConfig, CapturedBatch, IndexEntryData, PruneFrontier, FlushOptions, FlushResult, SummarizeResult, FlushBreakdown } from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CONTEXT_PRUNE_TOOL_NAME,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
  CUSTOM_TYPE_KNOWLEDGE,
  formatFlushNotification,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Knowledge graph — organizes file knowledge for compact context injection
  const knowledgeGraph = new KnowledgeGraph();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let isFlushing = false;

  /** Extract file path from tool call args for knowledge graph. */
  const extractFilePathForKnowledge = (toolName: string, args: Record<string, unknown>): string | undefined => {
    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      const p = args.path ?? args.filePath;
      return typeof p === "string" ? p : undefined;
    }
    return undefined;
  };

  /** Get current context usage percent from Pi, or undefined. */
  const getContextPercent = (ctx: ExtensionContext): number | null | undefined => {
    try {
      return ctx.getContextUsage?.()?.percent;
    } catch {
      return undefined;
    }
  };

  /** Raw content threshold below which batches skip LLM summarization entirely. */
  const MIN_BATCH_RAW_CHARS_TO_SUMMARIZE = 800;

  /** Total raw characters across all tool calls in a batch. */
  const rawCharCount = (batch: CapturedBatch) => batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);

  /** Whether a batch is too small to be worth an LLM summarization call. */
  const shouldSkipSmallBatch = (batch: CapturedBatch) => rawCharCount(batch) < MIN_BATCH_RAW_CHARS_TO_SUMMARIZE;

  /** Build a placeholder message for discarded reads (no LLM call needed). */
  const buildDiscardPlaceholder = (batch: CapturedBatch): string => {
    const fileOps = batch.toolCalls
      .filter((tc) => tc.toolName === "read" || tc.toolName === "edit" || tc.toolName === "write")
      .map((tc) => {
        const path = String(tc.args.path ?? tc.args.filePath ?? "unknown");
        return `${tc.toolName} ${path}`;
      });
    const files = [...new Set(fileOps.map((op) => op.split(" ").slice(1).join(" ")))];
    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId).join(", ");
    return [
      `\u{1F4C4} Discarded stale/duplicate file reads (turn ${batch.turnIndex})`,
      `Files: ${files.join(", ")}`,
      `These file reads were superseded by later edits or newer reads and are no longer accurate.`,
      `Use \`context_tree_query\` with IDs [${toolCallIds}] to recover original content, or re-read the file.`,
    ].join("\n");
  };

  // ── Batch classification + result processing ───────────────────────────────

  /**
   * Classify batches into small (skip LLM) and summarizable (send to LLM).
   * Returns indices for each category, preserving original batch order.
   */
  const classifyBatches = (batches: CapturedBatch[]) => {
    const smallBatchIndexes = new Set<number>();
    const discardableIndexes = new Set<number>();
    const summarizableBatches: { batch: CapturedBatch; originalIndex: number }[] = [];

    // Detect stale/duplicate file reads across all batches
    const discardableIds = detectDiscardableReads(batches);

    batches.forEach((batch, index) => {
      // Check if ALL tool calls in this batch are discardable
      const allDiscardable = batch.toolCalls.length > 0 &&
        batch.toolCalls.every((tc) => discardableIds.has(tc.toolCallId));
      if (allDiscardable) {
        discardableIndexes.add(index);
      } else if (shouldSkipSmallBatch(batch)) {
        smallBatchIndexes.add(index);
      } else {
        summarizableBatches.push({ batch, originalIndex: index });
      }
    });
    return { smallBatchIndexes, discardableIndexes, summarizableBatches };
  };

  // ── Result processing ──────────────────────────────────────────────────────

  /**
   * Process summarization results, persist summaries, advance frontier.
   * Returns the processed batch count, tool call count, and frontier outcome.
   */
  const processResults = (
    batches: CapturedBatch[],
    results: Array<SummarizeResult | null | undefined>,
    smallBatchIndexes: Set<number>,
    discardableIndexes: Set<number>,
    delivery: "runtime" | "session",
    appendEntry: (customType: string, data?: unknown) => void,
    appendSummaryMessage: (content: string, details: unknown) => void,
    ctx: ExtensionContext,
  ): {
    processedBatches: CapturedBatch[];
    smallBatches: CapturedBatch[];
    oversizedBatches: CapturedBatch[];
    summarizedBatches: CapturedBatch[];
    totalRawCharCount: number;
    totalSummaryCharCount: number;
    totalToolCallCount: number;
    summarizedRawChars: number;
    summarizedSummaryChars: number;
    summarizedToolCalls: number;
    summarizedBatchesCount: number;
    smallRawChars: number;
    smallToolCalls: number;
    smallBatchesCount: number;
    oversizedRawChars: number;
    oversizedSummaryChars: number;
    oversizedToolCalls: number;
    oversizedBatchesCount: number;
    firstFailureIndex: number;
  } => {
    const processedBatches: CapturedBatch[] = [];
    let totalRawCharCount = 0;
    let totalSummaryCharCount = 0;
    let totalToolCallCount = 0;
    const smallBatches: CapturedBatch[] = [];
    const oversizedBatches: CapturedBatch[] = [];
    const summarizedBatches: CapturedBatch[] = [];
    let summarizedRawChars = 0;
    let summarizedSummaryChars = 0;
    let summarizedToolCalls = 0;
    let summarizedBatchesCount = 0;
    let smallRawChars = 0;
    let smallToolCalls = 0;
    let smallBatchesCount = 0;
    let discardableRawChars = 0;
    let discardableToolCalls = 0;
    let discardableBatchesCount = 0;
    let oversizedRawChars = 0;
    let oversizedSummaryChars = 0;
    let oversizedToolCalls = 0;
    let oversizedBatchesCount = 0;
    let firstFailureIndex = -1;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchRawCharCount = rawCharCount(batch);

      if (smallBatchIndexes.has(i)) {
        totalRawCharCount += batchRawCharCount;
        totalToolCallCount += batch.toolCalls.length;
        smallBatches.push(batch);
        processedBatches.push(batch);
        smallRawChars += batchRawCharCount;
        smallToolCalls += batch.toolCalls.length;
        smallBatchesCount += 1;
        continue;
      }

      // Discardable reads: index them (so they get pruned from context) + send placeholder
      if (discardableIndexes.has(i)) {
        totalRawCharCount += batchRawCharCount;
        totalToolCallCount += batch.toolCalls.length;
        processedBatches.push(batch);
        discardableRawChars += batchRawCharCount;
        discardableToolCalls += batch.toolCalls.length;
        discardableBatchesCount += 1;
        const placeholder = buildDiscardPlaceholder(batch);
        const summaryRefs = indexer.allocateSummaryRefs(batch);
        const batchDetails = makeSummaryDetails(batch, summaryRefs);
        try {
          if (delivery === "runtime") {
            pi.sendMessage(
              { customType: CUSTOM_TYPE_SUMMARY, content: placeholder, display: true, details: batchDetails },
              { deliverAs: "steer" }
            );
            indexer.registerSummaryRefs(summaryRefs);
            indexer.addBatch(batch, pi);
          } else {
            appendSummaryMessage(placeholder, batchDetails);
            indexer.registerSummaryRefs(summaryRefs);
            persistBatchIndex(batch, appendEntry);
          }
        } catch (err) {
          if (isStaleContextError(err)) {
            restoreBatches(batches.slice(i));
            break;
          }
          throw err;
        }
        continue;
      }

      const result = results[i];
      if (!result) {
        firstFailureIndex = i;
        break;
      }

      totalRawCharCount += batchRawCharCount;
      totalToolCallCount += batch.toolCalls.length;

      const summaryRefs = indexer.allocateSummaryRefs(batch);
      const summaryText = result.summaryText + formatSummaryToolCallRefs(summaryRefs);
      const shouldSkipOversized = summaryText.length > batchRawCharCount;

      statsAccum.add(result.usage);
      totalSummaryCharCount += summaryText.length;

      const batchDetails = makeSummaryDetails(batch, summaryRefs);

      try {
        if (!shouldSkipOversized) {
          if (delivery === "runtime") {
            pi.sendMessage(
              { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: true, details: batchDetails },
              { deliverAs: "steer" }
            );
            indexer.registerSummaryRefs(summaryRefs);
            indexer.addBatch(batch, pi);
          } else {
            appendSummaryMessage(summaryText, batchDetails);
            indexer.registerSummaryRefs(summaryRefs);
            persistBatchIndex(batch, appendEntry);
          }
          summarizedBatches.push(batch);
          summarizedRawChars += batchRawCharCount;
          summarizedSummaryChars += summaryText.length;
          summarizedToolCalls += batch.toolCalls.length;
          summarizedBatchesCount += 1;

          // Update knowledge graph from summarized tool calls
          for (const tc of batch.toolCalls) {
            const filePath = extractFilePathForKnowledge(tc.toolName, tc.args);
            if (filePath) {
              const isEdit = tc.toolName === "edit" || tc.toolName === "write";
              knowledgeGraph.updateFromSummary(filePath, result.summaryText, batch.turnIndex, isEdit);
            }
          }
        } else {
          oversizedBatches.push(batch);
          oversizedRawChars += batchRawCharCount;
          oversizedSummaryChars += summaryText.length;
          oversizedToolCalls += batch.toolCalls.length;
          oversizedBatchesCount += 1;
        }
      } catch (err) {
        if (isStaleContextError(err)) {
          restoreBatches(batches.slice(i));
          break;
        }
        throw err;
      }

      processedBatches.push(batch);
    }

    return {
      processedBatches, smallBatches, oversizedBatches, summarizedBatches,
      totalRawCharCount, totalSummaryCharCount, totalToolCallCount, firstFailureIndex,
      summarizedRawChars, summarizedSummaryChars, summarizedToolCalls, summarizedBatchesCount,
      smallRawChars, smallToolCalls, smallBatchesCount,
      discardableRawChars, discardableToolCalls, discardableBatchesCount,
      oversizedRawChars, oversizedSummaryChars, oversizedToolCalls, oversizedBatchesCount,
    };
  };

  // ── flushPending ────────────────────────────────────────────────────────

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedBatch): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    let toolCalls = batch.toolCalls;

    // The indexer tells us what was successfully summarized earlier.
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(tc.toolCallId));
    if (toolCalls.length === 0) return null;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  const extractFilePath = (toolName: string, args: Record<string, unknown>): string | undefined => {
    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      const p = args.path ?? args.filePath;
      return typeof p === "string" ? p : undefined;
    }
    return undefined;
  };

  const persistBatchIndex = (batch: CapturedBatch, appendEntry: (customType: string, data?: unknown) => void) => {
    const records = batch.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      isError: tc.isError,
      turnIndex: batch.turnIndex,
      timestamp: batch.timestamp,
      filePath: extractFilePath(tc.toolName, tc.args),
    }));

    for (const record of records) {
      indexer.getIndex().set(record.toolCallId, record);
    }

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);

    // Re-detect stale records after adding new entries
    indexer.detectStaleRecords();
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  const capturePendingBatches = (ctx: ExtensionContext): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedBatchesFromSession(branch, indexer, [CONTEXT_PRUNE_TOOL_NAME]);
    } catch {
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  // Summarizes + indexes all pending batches.
  // When options.onProgress is provided batches are processed sequentially
  // (one LLM call each) so the caller can update per-row UI. Otherwise all
  // batches are summarized in one structured LLM call (summarizeAllBatches).
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  const flushPending = async (ctx: ExtensionContext, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    // Use pre-captured batches if provided (avoids double-capture when the
    // caller previewed the queue before opening the progress overlay).
    let batches: CapturedBatch[] = options.previewedBatches ?? capturePendingBatches(ctx);

    if (batches.length === 0) return { ok: false, reason: "empty" };

    // Bail out before we drain pendingBatches so they don't need restoring.
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    // Draining the queue since we've captured the state via session or slice.
    // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
    // or rapid turn-ends don't result in double-summarization.
    pendingBatches.length = 0;

    isFlushing = true;

    const delivery = options.delivery ?? "runtime";
    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
    }

    const appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, true, details);

    try {
      setPruneStatusWidget(ctx, currentConfig.value, "prune: summarizing…");

      const reportBatchTextProgress = (index: number, total: number, batch: CapturedBatch, receivedChars: number) => {
        options.onBatchTextProgress?.(index, total, batch, receivedChars);
      };

      // Classify tiny batches before any LLM work.
      const { smallBatchIndexes, discardableIndexes, summarizableBatches } = classifyBatches(batches);

      // Summarize only batches that clear the minimum raw-size threshold. When
      // onProgress is provided (i.e. /pruner now with the multi-row overlay), we
      // process sequentially so each row can be checked off as its LLM call
      // completes; small rows are marked skipped without an LLM call.
      const results: Array<SummarizeResult | null | undefined> = new Array(batches.length);
      if (options.onProgress) {
        for (let i = 0; i < batches.length; i++) {
          options.onProgress(i, batches.length, batches[i], "start");
          if (smallBatchIndexes.has(i)) {
            options.onProgress(i, batches.length, batches[i], "skipped");
            continue;
          }
          if (discardableIndexes.has(i)) {
            options.onProgress(i, batches.length, batches[i], "skipped");
            continue;
          }
          const r = await summarizeBatch(batches[i], currentConfig.value, ctx, {
            signal: options.signal,
            onTextProgress: (receivedChars) => {
              reportBatchTextProgress(i, batches.length, batches[i], receivedChars);
            },
          });
          results[i] = r;
          options.onProgress(i, batches.length, batches[i], r ? "done" : "skipped");
        }
      } else if (summarizableBatches.length > 0) {
        const summarizedResults = await summarizeAllBatches(
          summarizableBatches.map((entry) => entry.batch),
          currentConfig.value,
          ctx,
          {
            onBatchTextProgress: (index, _total, batch, receivedChars) => {
              const originalIndex = summarizableBatches[index]?.originalIndex ?? batches.indexOf(batch);
              reportBatchTextProgress(originalIndex, batches.length, batch, receivedChars);
            },
            signal: options.signal,
          }
        );
        summarizedResults.forEach((result, index) => {
          results[summarizableBatches[index].originalIndex] = result;
        });
      }

      // Process results in original order; stop at first null for a summarizable
      // batch (LLM failure). Batches before the first failure are persisted or
      // frontier-skipped; remaining are restored for retry.
      const proc = processResults(batches, results, smallBatchIndexes, discardableIndexes, delivery, appendEntry, appendSummaryMessage, ctx);

      // Restore unprocessed batches (those at and after the first failure)
      if (proc.firstFailureIndex >= 0) {
        restoreBatches(batches.slice(proc.firstFailureIndex));
      }

      if (proc.processedBatches.length === 0) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "summarizer-failed" };
      }

      // Advance frontier to the last batch we actually processed.
      const lastBatch = proc.processedBatches[proc.processedBatches.length - 1];
      const lastTC = lastBatch.toolCalls[lastBatch.toolCalls.length - 1];
      const frontierOutcome: PruneFrontier["outcome"] =
        proc.summarizedBatches.length > 0
          ? "summarized"
          : proc.oversizedBatches.length > 0
            ? "skipped-oversized"
            : "skipped-small";
      const frontierSnapshot: PruneFrontier = {
        lastAttemptedToolCallId: lastTC.toolCallId,
        lastAttemptedToolName: lastTC.toolName,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: proc.processedBatches.length,
        attemptedToolCallCount: proc.totalToolCallCount,
        rawCharCount: proc.totalRawCharCount,
        summaryCharCount: proc.totalSummaryCharCount,
        outcome: frontierOutcome,
      };

      try {
        if (delivery === "runtime") {
          frontier.advance(frontierSnapshot);
          frontier.persist(pi);
          statsAccum.persist(pi);
          knowledgeGraph.persist(pi);
        } else {
          frontier.advance(frontierSnapshot);
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
          try {
            appendEntry(CUSTOM_TYPE_KNOWLEDGE, knowledgeGraph.toJSON());
          } catch {
            // Ignore knowledge graph persistence failures
          }
        }

        // Inject knowledge graph into context as a steer message
        const graphText = knowledgeGraph.serialize();
        if (graphText && delivery === "runtime") {
          try {
            pi.sendMessage(
              { customType: "context-prune-knowledge", content: graphText, display: false },
              { deliverAs: "steer" }
            );
          } catch {
            // Non-critical: knowledge graph is supplementary
          }
        }
      } catch (err) {
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats(), getContextPercent(ctx));

      // Single unified notification with per-category breakdown
      const breakdown = {
        summarized: {
          batchCount: proc.summarizedBatchesCount,
          toolCallCount: proc.summarizedToolCalls,
          rawCharCount: proc.summarizedRawChars,
          summaryCharCount: proc.summarizedSummaryChars,
        },
        skippedSmall: {
          batchCount: proc.smallBatchesCount,
          toolCallCount: proc.smallToolCalls,
          rawCharCount: proc.smallRawChars,
          summaryCharCount: 0,
        },
        discarded: {
          batchCount: proc.discardableBatchesCount,
          toolCallCount: proc.discardableToolCalls,
          rawCharCount: proc.discardableRawChars,
          summaryCharCount: 0,
        },
        skippedOversized: {
          batchCount: proc.oversizedBatchesCount,
          toolCallCount: proc.oversizedToolCalls,
          rawCharCount: proc.oversizedRawChars,
          summaryCharCount: proc.oversizedSummaryChars,
        },
      };

      safeNotify(ctx, formatFlushNotification(breakdown), "info");

      return {
        ok: true,
        reason: frontierOutcome === "summarized" ? "flushed" : frontierOutcome,
        batchCount: proc.processedBatches.length,
        toolCallCount: proc.totalToolCallCount,
        rawCharCount: proc.totalRawCharCount,
        summaryCharCount: proc.totalSummaryCharCount,
        summarized: breakdown.summarized,
        skippedSmall: breakdown.skippedSmall,
        discarded: breakdown.discarded,
        skippedOversized: breakdown.skippedOversized,
      };
    } catch (err) {
      restoreBatches(batches);
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from ~/.pi/agent/context-prune/settings.json
    currentConfig.value = await loadConfig();

    // Single branch scan for all reconstructors
    const branch = ctx.sessionManager.getBranch();
    indexer.reconstructFromSession(ctx, branch);
    statsAccum.reconstructFromSession(ctx, branch);
    frontier.reconstructFromSession(ctx, branch);
    knowledgeGraph.reconstructFromSession(ctx, branch);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats(), getContextPercent(ctx));

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    indexer.reconstructFromSession(ctx, branch);
    statsAccum.reconstructFromSession(ctx, branch);
    frontier.reconstructFromSession(ctx, branch);
    knowledgeGraph.reconstructFromSession(ctx, branch);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by message_end in agent-message mode.
      // In print mode, turn_end can fire after session shutdown, so do not start
      // deferred LLM work from this late lifecycle event.
      return;
    }

    const capturedBatch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    const batch = trimBatchToPendingRange({
      ...capturedBatch,
      // Do not summarize the pruner's own housekeeping tool result. Otherwise
      // agentic-auto mode can queue the context_prune result and try to flush it
      // during agent_end, when Pi may already have invalidated the extension ctx.
      toolCalls: capturedBatch.toolCalls.filter((tc) => tc.toolName !== CONTEXT_PRUNE_TOOL_NAME),
    });
    if (!batch) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_tag";
          break;
        case "agent-message":
          trigger = "agent's next text response";
          break;
        case "agentic-auto":
          trigger = "agent calling context_prune";
          break;
        default:
          trigger = "/pruner now";
          break;
      }
      if (currentConfig.value.showPruneStatusLine) {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
        safeNotify(
          ctx,
          `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
          "info"
        );
      }
    }
  });

  // ── tool_execution_end: flush when context_tag fires ─────────────────────
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, { delivery: "runtime" });
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    await flushPending(ctx, { delivery: "session" });
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    setPruneStatusWidget(ctx, currentConfig.value, `prune: ${pendingBatches.length} pending`);
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;

    const indexEmpty = indexer.getIndex().size === 0;
    let messages = event.messages;
    let changed = false;

    if (!indexEmpty) {
      const pruned = pruneMessages(messages, indexer);
      if (pruned.length !== messages.length) {
        messages = pruned;
        changed = true;
      }
    }

    // Append a small `<pruner-note>` to the last toolResult telling the model
    // how many unpruned tool calls are sitting in context. Only active in
    // agentic-auto mode (where the LLM itself decides when to call
    // context_prune) and only when the user has the reminder enabled.
    if (
      currentConfig.value.pruneOn === "agentic-auto" &&
      currentConfig.value.remindUnprunedCount
    ) {
      const count = countUnprunedToolCalls(messages, indexer);
      if (count > 0) {
        const annotated = annotateWithUnprunedCount(messages, count);
        if (annotated !== messages) {
          messages = annotated;
          changed = true;
        }
      }
    }

    if (!changed) return undefined;
    return { messages };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, (ctx, options) => flushPending(ctx, { delivery: "runtime", ...options }));

  // ── Register /pruner command + summary message renderer ────────────
  /**
   * Build ALL batches (indexed + unindexed) for accurate stale-read detection.
   * Fix #1: detectDiscardableReads needs full history to know which read is "latest".
   */
  const buildAllBatches = (branch: any[], idx: ToolCallIndexer): CapturedBatch[] => {
    // Get unindexed batches from session
    const unindexed = captureUnindexedBatchesFromSession(branch, idx);

    // Reconstruct indexed batches from indexer records
    const indexedByTurn = new Map<number, CapturedBatch>();
    for (const [_id, record] of idx.getIndex()) {
      if (!indexedByTurn.has(record.turnIndex)) {
        indexedByTurn.set(record.turnIndex, {
          turnIndex: record.turnIndex,
          timestamp: record.timestamp,
          assistantText: "",
          toolCalls: [],
        });
      }
      indexedByTurn.get(record.turnIndex)!.toolCalls.push({
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        args: record.args,
        resultText: record.resultText,
        isError: record.isError,
      });
    }

    const indexed = [...indexedByTurn.values()];

    // Merge and sort by turnIndex
    return [...indexed, ...unindexed].sort((a, b) => a.turnIndex - b.turnIndex);
  };

  // ── /pruner clean handler ──────────────────────────────────────────────────
  const cleanToolResultsWrapper = async (ctx: any): Promise<{ evaluated: number; codeRemoved: number; llmRemoved: number }> => {
    const branch = ctx.sessionManager.getBranch();

    // Collect ALL messages (toolResult + summary) for candidate scanning
    const messages: any[] = [];
    for (const entry of branch) {
      if (entry.type === "message") {
        const msg = entry.message;
        if (msg.role === "toolResult" || msg.customType === CUSTOM_TYPE_SUMMARY) {
          messages.push(msg);
        }
      }
    }

    // Fix #1: build ALL batches (indexed + unindexed) for accurate read ordering
    // captureUnindexedBatchesFromSession only returns unindexed, so we also
    // reconstruct indexed batches from the indexer records
    const allBatches = buildAllBatches(branch, indexer);

    return doCleanToolResults(messages, allBatches, indexer, currentConfig.value, ctx, (phase) => {
      switch (phase) {
        case "scan": setPruneStatusWidget(ctx, currentConfig.value, "prune: clean — scanning…"); break;
        case "code": setPruneStatusWidget(ctx, currentConfig.value, "prune: clean — code detection…"); break;
        case "llm":  setPruneStatusWidget(ctx, currentConfig.value, "prune: clean — LLM evaluating…"); break;
        case "done": break;
      }
    });
  };

  registerCommands(pi, currentConfig, flushPending, capturePendingBatches, syncToolActivation, () => statsAccum.getStats(), indexer, cleanToolResultsWrapper);
}
