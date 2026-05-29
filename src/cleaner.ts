/**
 * `/pruner clean` — hybrid stale tool result + summary removal.
 *
 * Phase 1 (code-based, deterministic):
 *   - Detect stale/duplicate file reads via detectDiscardableReads() (ALL batches, not just unindexed)
 *   - Detect stale summaries via indexer + context scan
 *   - Collect edited files from BOTH indexer records AND unflushed messages
 *
 * Phase 2 (LLM-evaluated): for remaining results, ask the LLM which are stale.
 *
 * Results are added to the indexer so they're pruned on the next context event.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig, ToolCallRecord } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import { detectDiscardableReads } from "./batch-capture.js";

/** Max toolResults per LLM evaluation call. */
const MAX_EVAL_PER_CALL = 40;

/** Max chars of result text to include in the evaluation prompt. */
const RESULT_PREVIEW_LENGTH = 200;

const EVAL_SYSTEM_PROMPT = `You are cleaning up a long AI coding session's context window.
The session has been running for many turns. Context space is valuable — removing old, stale
tool results frees space for the assistant to keep working effectively.

You will receive a list of tool results and summaries still in context, with their tool name,
arguments, turn index, and a preview of the content. You also receive the file edit history.

DECISIVELY remove results that are clearly stale. The assistant can always re-read a file or
use context_tree_query to recover removed content. Being too conservative wastes context space.

Evaluate results in THREE tiers based on age:

── TIER 1: Old results (20+ turns ago) — AGGRESSIVE pruning
These are from early exploration. Default to REMOVE unless the result has clear ongoing value.
- Old reads of files that were later edited — REMOVE (content is outdated)
- Exploratory project scans, directory listings, initial reads — REMOVE
- Old grep/find results already acted upon — REMOVE
- Old bash diagnostics — REMOVE
- Only KEEP if it's the sole source of unique, unrecoverable information

── TIER 2: Mid-session results (10–20 turns ago) — BALANCED pruning
These may still be relevant. Judge by value:
- Reads of files later edited — REMOVE (outdated)
- Reads of files NOT later edited — KEEP if the information is still useful
- Search results, diagnostics — REMOVE if already acted upon
- Edit/write results — KEEP (record what changed)

── TIER 3: Recent results (last 10 turns) — CONSERVATIVE pruning
These are likely still relevant. Only remove if clearly redundant:
- Exact duplicates of information available elsewhere — REMOVE
- Trivial outputs (empty results, "not found") — REMOVE
- Everything else — KEEP

Respond with valid JSON only:
{
  "removeIds": ["toolCallId1", "toolCallId2", ...]
}

If nothing should be removed: { "removeIds": [] }`;

interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  turnIndex: number;
  resultPreview: string;
  resultFullText: string;
  filePath?: string;
  isSummary?: boolean;
  /** For summary removal: the message content to preserve in indexer for recovery. */
  summaryContent?: string;
}

/** Extract file path from tool call args if applicable. */
function filePathFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const p = args.path ?? args.filePath;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}

/** Extract a short preview of tool call arguments. */
function argsPreview(args: Record<string, unknown>): string {
  const path = args.path ?? args.filePath;
  if (typeof path === "string") return `path: ${path}`;
  const command = args.command;
  if (typeof command === "string") return `command: ${command.substring(0, 80)}`;
  const entries = Object.entries(args).slice(0, 3);
  return entries.map(([k, v]) => `${k}: ${String(v).substring(0, 40)}`).join(", ");
}

/** Truncate text to a preview length. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "…";
}

/**
 * Hybrid stale content removal: code-based detection + LLM evaluation.
 * Handles both raw toolResults AND summary messages.
 *
 * @param messages     All messages from the session branch (toolResult + summary)
 * @param allBatches   ALL batches (indexed + unindexed) for accurate read/edit ordering
 * @param indexer      The tool call indexer
 * @param config       Current pruner config
 * @param ctx          Extension context
 * @param onPhase      Optional phase callback for UI updates
 */
export async function cleanToolResults(
  messages: any[],
  allBatches: CapturedBatch[],
  indexer: ToolCallIndexer,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  onPhase?: (phase: "scan" | "code" | "llm" | "done") => void,
): Promise<{ evaluated: number; codeRemoved: number; llmRemoved: number }> {
  onPhase?.("scan");

  // ── Collect edited file paths from ALL sources ──────────────────────
  // Fix #3: include both indexer records AND unflushed messages
  const editedFilePaths = new Set<string>();

  // From indexer (already flushed edits)
  for (const [_id, record] of indexer.getIndex()) {
    if ((record.toolName === "edit" || record.toolName === "write") && record.filePath) {
      editedFilePaths.add(record.filePath);
    }
  }

  // From messages (unflushed edits still in context)
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const toolName = msg.toolName ?? "";
      const args = msg.args ?? msg.input ?? {};
      if ((toolName === "edit" || toolName === "write")) {
        const path = filePathFromArgs(toolName, args);
        if (path) editedFilePaths.add(path);
      }
    }
  }

  // ── Collect candidates ──────────────────────────────────────────────
  const candidates: ToolResultInfo[] = [];
  const maxTurn = Math.max(...messages.map((m: any) => m.turnIndex ?? 0), 0);

  for (const msg of messages) {
    // Raw tool results that haven't been indexed yet
    if (msg.role === "toolResult" && !indexer.isSummarized(msg.toolCallId)) {
      const toolName = msg.toolName ?? "unknown";
      const args = msg.args ?? msg.input ?? {};
      const turnIndex = msg.turnIndex ?? -1;
      const resultText = extractText(msg.content);

      candidates.push({
        toolCallId: msg.toolCallId,
        toolName,
        argsPreview: argsPreview(args),
        turnIndex,
        resultPreview: truncate(resultText, RESULT_PREVIEW_LENGTH),
        resultFullText: resultText,
        filePath: filePathFromArgs(toolName, args),
      });
    }

    // Summary messages — check if they reference stale reads
    if (msg.customType === CUSTOM_TYPE_SUMMARY && msg.details?.toolCallRefs) {
      const refs: Array<{ toolCallId: string }> = msg.details.toolCallRefs;
      const toolNames: string[] = msg.details.toolNames ?? [];
      const turnIndex: number = msg.details.turnIndex ?? msg.turnIndex ?? -1;
      const content: string = extractText(msg.content);

      // Extract file paths from tool names in the summary
      const summaryFilePaths = refs
        .map((ref) => indexer.getIndex().get(ref.toolCallId)?.filePath)
        .filter(Boolean) as string[];

      // Check if ANY referenced file was later edited
      const hasStaleRef = summaryFilePaths.some((p) => editedFilePaths.has(p));

      if (hasStaleRef) {
        // Create pseudo-candidates for the stale summary
        for (const ref of refs) {
          candidates.push({
            toolCallId: ref.toolCallId,
            toolName: "summary",
            argsPreview: `summary of ${toolNames.join(", ")}`,
            turnIndex,
            resultPreview: truncate(content, RESULT_PREVIEW_LENGTH),
            resultFullText: content,
            isSummary: true,
            summaryContent: content,
            filePath: indexer.getIndex().get(ref.toolCallId)?.filePath,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    onPhase?.("done");
    return { evaluated: 0, codeRemoved: 0, llmRemoved: 0 };
  }

  // ── Phase 1: Code-based detection (deterministic, zero cost) ──────────
  onPhase?.("code");

  // Fix #1: detectDiscardableReads uses ALL batches for accurate ordering
  const discardableIds = detectDiscardableReads(allBatches);

  // Fix #2: detect stale records from indexer
  indexer.detectStaleRecords();
  const staleIds = indexer.getStaleIds();

  let codeRemoved = 0;
  const remaining: ToolResultInfo[] = [];

  for (const candidate of candidates) {
    let shouldRemove = false;

    // Code-detection: discardable reads (from all-batch analysis)
    if (discardableIds.has(candidate.toolCallId)) {
      shouldRemove = true;
    }

    // Code-detection: stale indexer records (reads before edits)
    if (staleIds.has(candidate.toolCallId)) {
      shouldRemove = true;
    }

    // Code-detection: stale summary (references a file that was later edited)
    if (candidate.isSummary) {
      // Already filtered above — all summary candidates here are stale
      shouldRemove = true;
    }

    if (shouldRemove) {
      addToIndexer(indexer, candidate);
      codeRemoved++;
    } else if (!candidate.isSummary) {
      remaining.push(candidate);
    }
  }

  // ── Phase 2: LLM evaluation for remaining results ─────────────────────
  onPhase?.("llm");

  const editHistory = buildEditHistory(messages, indexer);
  const recentThreshold = Math.max(maxTurn - 10, 0);
  const llmCandidates = remaining.filter((c) => c.turnIndex <= recentThreshold);

  if (llmCandidates.length === 0) {
    onPhase?.("done");
    return { evaluated: candidates.length, codeRemoved, llmRemoved: 0 };
  }

  let llmRemoved = 0;
  for (let offset = 0; offset < llmCandidates.length; offset += MAX_EVAL_PER_CALL) {
    const batch = llmCandidates.slice(offset, offset + MAX_EVAL_PER_CALL);
    onPhase?.("llm");

    const lines = batch.map((c, i) => {
      const age = maxTurn - c.turnIndex;
      const tier = age >= 20 ? "T1-old" : age >= 10 ? "T2-mid" : "T3-recent";
      return `${offset + i + 1}. [${c.toolCallId}] turn ${c.turnIndex} (${tier}): ${c.toolName}(${c.argsPreview})\n   Preview: ${c.resultPreview}`;
    });

    const editLines = editHistory.length > 0
      ? `\n\nFile edit history (these files were modified):\n${editHistory.map((e) => `  - turn ${e.turnIndex}: ${e.toolName} ${e.path}`).join("\n")}`
      : "";

    const userMessage = `Current turn is ~${maxTurn}. Evaluate these ${batch.length} results from earlier turns.${editLines}\n\nWhich should be removed to free context?\n\n${lines.join("\n\n")}`;

    try {
      const model = ctx.model;
      const response = await model.complete([
        { role: "system", content: EVAL_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ]);

      const text = typeof response === "string" ? response : (response as any).content ?? "";
      const parsed = tryParseJson(text);

      if (parsed && Array.isArray(parsed.removeIds)) {
        const removeSet = new Set(parsed.removeIds);
        for (const candidate of batch) {
          if (removeSet.has(candidate.toolCallId)) {
            addToIndexer(indexer, candidate);
            llmRemoved++;
          }
        }
      }
    } catch {
      // Continue with next batch even if this one fails
    }
  }

  onPhase?.("done");
  return { evaluated: candidates.length, codeRemoved, llmRemoved };
}

/** Extract text content from message content (string or array of blocks). */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c.text ?? "").join("");
  return "";
}

/**
 * Add a tool result to the indexer.
 * Fix #2: preserve original content for context_tree_query recovery.
 */
function addToIndexer(indexer: ToolCallIndexer, info: ToolResultInfo): void {
  // For summary removals, store the summary content so context_tree_query
  // can recover it. For raw toolResults, store the full result text.
  const preservedText = info.isSummary
    ? (info.summaryContent ?? info.resultFullText)
    : info.resultFullText;

  indexer.getIndex().set(info.toolCallId, {
    toolCallId: info.toolCallId,
    toolName: info.toolName,
    args: {},
    resultText: preservedText,
    isError: false,
    turnIndex: info.turnIndex,
    timestamp: 0,
    filePath: info.filePath,
  });
}

/**
 * Build edit history from BOTH indexer records and unindexed messages.
 * Fix #3: complete edit history for LLM context.
 */
function buildEditHistory(
  messages: any[],
  indexer: ToolCallIndexer,
): Array<{ toolName: string; path: string; turnIndex: number }> {
  const edits: Array<{ toolName: string; path: string; turnIndex: number }> = [];
  const seen = new Set<string>();

  // From indexer
  for (const [_id, record] of indexer.getIndex()) {
    if ((record.toolName === "edit" || record.toolName === "write") && record.filePath) {
      const key = `${record.filePath}:${record.turnIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        edits.push({ toolName: record.toolName, path: record.filePath, turnIndex: record.turnIndex });
      }
    }
  }

  // From messages (unflushed)
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const toolName = msg.toolName ?? "";
      if (toolName === "edit" || toolName === "write") {
        const args = msg.args ?? msg.input ?? {};
        const path = filePathFromArgs(toolName, args);
        const turnIndex = msg.turnIndex ?? -1;
        if (path) {
          const key = `${path}:${turnIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            edits.push({ toolName, path, turnIndex });
          }
        }
      }
    }
  }

  return edits.sort((a, b) => a.turnIndex - b.turnIndex);
}

/** Try to parse JSON from LLM response, handling markdown fences. */
function tryParseJson(text: string): { removeIds: string[] } | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.substring(start, end + 1));
  } catch {
    return null;
  }
}
