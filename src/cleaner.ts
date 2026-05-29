/**
 * `/pruner clean` — hybrid stale tool result + summary removal.
 *
 * Phase 1 (code-based, deterministic):
 *   - Detect stale/duplicate file reads via detectDiscardableReads()
 *   - Detect stale summaries (reads of files later edited) via indexer
 *   - Detect stale summary messages in context (old read summaries for edited files)
 *
 * Phase 2 (LLM-evaluated): for remaining results, ask the LLM which are stale.
 *
 * Results are added to the indexer so they're pruned on the next context event.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig } from "./types.js";
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

REMOVE these without hesitation:
- Reads of files that were later edited — the content is outdated
- Exploratory reads from 20+ turns ago that were just project scanning
- Old grep/find results that were already acted upon
- Old bash diagnostic outputs (ls, wc, node brace checks, etc.)
- Summaries of old file reads where the file has since been edited
- Any result older than 30 turns that isn't the ONLY source of unique information

KEEP only:
- The most recent read of each file (if file was NOT edited after the read)
- All edit/write operations and their results
- Results from the last 10 turns
- Results containing unresolved errors
- Results with unique data that cannot be easily recovered

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
  filePath?: string;
  isSummary?: boolean;
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
 */
export async function cleanToolResults(
  messages: any[],
  batches: CapturedBatch[],
  indexer: ToolCallIndexer,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  onPhase?: (phase: "scan" | "code" | "llm" | "done") => void,
): Promise<{ evaluated: number; codeRemoved: number; llmRemoved: number }> {
  onPhase?.("scan");

  // Collect unindexed toolResults AND summary messages
  const candidates: ToolResultInfo[] = [];
  const maxTurn = Math.max(...messages.map((m: any) => m.turnIndex ?? 0), 0);

  for (const msg of messages) {
    // Raw tool results that haven't been indexed yet
    if (msg.role === "toolResult" && !indexer.isSummarized(msg.toolCallId)) {
      const toolName = msg.toolName ?? "unknown";
      const args = msg.args ?? msg.input ?? {};
      const turnIndex = msg.turnIndex ?? -1;
      const resultText = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => c.text ?? "").join("")
          : "";

      candidates.push({
        toolCallId: msg.toolCallId,
        toolName,
        argsPreview: argsPreview(args),
        turnIndex,
        resultPreview: truncate(resultText, RESULT_PREVIEW_LENGTH),
        filePath: filePathFromArgs(toolName, args),
      });
    }

    // Summary messages — check if they're stale
    if (msg.customType === CUSTOM_TYPE_SUMMARY && msg.details?.toolCallRefs) {
      const refs: Array<{ toolCallId: string }> = msg.details.toolCallRefs;
      const toolNames: string[] = msg.details.toolNames ?? [];
      const turnIndex: number = msg.details.turnIndex ?? msg.turnIndex ?? -1;
      const content: string = typeof msg.content === "string"
        ? msg.content
        : "";

      // Create a pseudo-candidate for each summary
      for (const ref of refs) {
        if (indexer.isStale(ref.toolCallId)) {
          // This summary references a stale read — remove it via code detection
          candidates.push({
            toolCallId: ref.toolCallId,
            toolName: "summary",
            argsPreview: `summary of ${toolNames.join(", ")}`,
            turnIndex,
            resultPreview: truncate(content, RESULT_PREVIEW_LENGTH),
            isSummary: true,
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

  // 1a. Detect stale/duplicate reads using the same logic as flushPending
  const discardableIds = detectDiscardableReads(batches);

  // 1b. Detect stale records using indexer history (reads before edits)
  indexer.detectStaleRecords();
  const staleIds = indexer.getStaleIds();

  // 1c. Collect file paths that were edited (for stale summary detection)
  const editedFilePaths = new Set<string>();
  for (const [_id, record] of indexer.getIndex()) {
    if ((record.toolName === "edit" || record.toolName === "write") && record.filePath) {
      editedFilePaths.add(record.filePath);
    }
  }

  let codeRemoved = 0;
  const remaining: ToolResultInfo[] = [];

  for (const candidate of candidates) {
    let shouldRemove = false;

    // Code-detection: discardable reads
    if (discardableIds.has(candidate.toolCallId)) {
      shouldRemove = true;
    }

    // Code-detection: stale indexer records
    if (staleIds.has(candidate.toolCallId)) {
      shouldRemove = true;
    }

    // Code-detection: stale summary (read of file that was later edited)
    if (candidate.isSummary && candidate.filePath && editedFilePaths.has(candidate.filePath)) {
      shouldRemove = true;
    }

    // Code-detection: summary for an already-stale toolCallId
    if (candidate.isSummary && staleIds.has(candidate.toolCallId)) {
      shouldRemove = true;
    }

    if (shouldRemove) {
      addToIndexer(indexer, candidate);
      codeRemoved++;
    } else if (!candidate.isSummary) {
      // Don't send summary pseudo-candidates to LLM (they're handled by code)
      remaining.push(candidate);
    }
  }

  // ── Phase 2: LLM evaluation for remaining results ─────────────────────
  onPhase?.("llm");

  // Build file edit history for LLM context
  const editHistory = buildEditHistory(candidates);
  const recentThreshold = Math.max(maxTurn - 10, 0);

  // Filter out very recent results
  const llmCandidates = remaining.filter((c) => c.turnIndex <= recentThreshold);

  if (llmCandidates.length === 0) {
    onPhase?.("done");
    return { evaluated: candidates.length, codeRemoved, llmRemoved: 0 };
  }

  // Process in batches
  let llmRemoved = 0;
  for (let offset = 0; offset < llmCandidates.length; offset += MAX_EVAL_PER_CALL) {
    const batch = llmCandidates.slice(offset, offset + MAX_EVAL_PER_CALL);
    onPhase?.("llm");

    const lines = batch.map((c, i) =>
      `${offset + i + 1}. [${c.toolCallId}] turn ${c.turnIndex}: ${c.toolName}(${c.argsPreview})\n   Preview: ${c.resultPreview}`
    );

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

/** Add a tool result to the indexer as "summarized" (marks it for pruning). */
function addToIndexer(indexer: ToolCallIndexer, info: ToolResultInfo): void {
  indexer.getIndex().set(info.toolCallId, {
    toolCallId: info.toolCallId,
    toolName: info.toolName,
    args: {},
    resultText: "",
    isError: false,
    turnIndex: info.turnIndex,
    timestamp: 0,
    filePath: info.filePath,
  });
}

/** Build a list of file edit operations for LLM context. */
function buildEditHistory(candidates: ToolResultInfo[]): Array<{ toolName: string; path: string; turnIndex: number }> {
  return candidates
    .filter((c) => (c.toolName === "edit" || c.toolName === "write") && c.filePath)
    .map((c) => ({ toolName: c.toolName, path: c.filePath!, turnIndex: c.turnIndex }));
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
