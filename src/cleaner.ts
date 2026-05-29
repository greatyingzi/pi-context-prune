/**
 * `/pruner clean` — hybrid stale tool result removal.
 *
 * Phase 1 (code-based, deterministic): detect stale/duplicate file reads
 *   using detectDiscardableReads() and detectStaleRecords().
 * Phase 2 (LLM-evaluated): for remaining results, ask the LLM which are stale.
 *
 * Results are added to the indexer so they're pruned on the next context event.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import { detectDiscardableReads } from "./batch-capture.js";

/** Max toolResults per LLM evaluation call. If more remain, split into batches. */
const MAX_EVAL_PER_CALL = 40;

/** Max chars of result text to include in the evaluation prompt. */
const RESULT_PREVIEW_LENGTH = 200;

const EVAL_SYSTEM_PROMPT = `You are evaluating tool call results from a long AI coding session.
The assistant has been working for many turns. Some early tool results are no longer needed.

You will receive a list of tool results with their tool name, arguments, turn index, and
a preview of the result text. You also receive a list of file edits that happened, so you
can identify reads of files whose content has since changed.

Decide which tool results can be safely removed from context. The results will be completely
removed — the assistant won't be able to see them anymore (though they can be recovered).

IMPORTANT — Always KEEP:
- The most recent read of any file (unless that file was edited AFTER the read)
- Any edit/write operation (these record what was changed)
- Results from the last 10 turns (too recent to be stale)
- Results containing errors that haven't been resolved
- Results with unique information (e.g., specific values, IDs, names) not repeated elsewhere

Safe to REMOVE:
- Old reads of files that were later edited (content is outdated — the file has changed)
- Very old exploratory reads (project structure, initial scanning) from 30+ turns ago
- Old search results (grep/find) that were just exploration and already acted upon
- Old bash outputs that were one-time diagnostic checks
- Duplicate reads of the same file where the information is captured in a later read

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
 * Hybrid stale content removal: code-based detection first, then LLM evaluation.
 *
 * @param messages   ToolResult messages from the session branch
 * @param batches    CapturedBatches reconstructed from the session (for code-based detection)
 * @param indexer    The tool call indexer
 * @param config     Current pruner config
 * @param ctx        Extension context (for LLM access)
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
  // Collect unindexed toolResults
  const candidates: ToolResultInfo[] = [];
  const maxTurn = Math.max(...messages.map((m: any) => m.turnIndex ?? 0), 0);

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (indexer.isSummarized(msg.toolCallId)) continue;

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

  if (candidates.length === 0) {
    return { evaluated: 0, codeRemoved: 0, llmRemoved: 0 };
  }

  // ── Phase 1: Code-based detection (deterministic, zero cost) ──────────
  onPhase?.("code");

  // 1a. Detect stale/duplicate reads using the same logic as flushPending
  const discardableIds = detectDiscardableReads(batches);

  // 1b. Detect stale records using indexer history (reads before edits)
  indexer.detectStaleRecords();
  const staleIds = indexer.getStaleIds();

  let codeRemoved = 0;
  const remaining: ToolResultInfo[] = [];

  for (const candidate of candidates) {
    if (discardableIds.has(candidate.toolCallId) || staleIds.has(candidate.toolCallId)) {
      // Deterministically stale — remove without LLM
      addToIndexer(indexer, candidate);
      codeRemoved++;
    } else {
      remaining.push(candidate);
    }
  }

  // ── Phase 2: LLM evaluation for remaining results ─────────────────────
  onPhase?.("llm");

  if (remaining.length === 0) {
    return { evaluated: candidates.length, codeRemoved, llmRemoved: 0 };
  }

  // Build file edit history for LLM context
  const editHistory = buildEditHistory(candidates);
  const recentThreshold = Math.max(maxTurn - 10, 0);

  // Filter out very recent results (don't waste LLM tokens evaluating them)
  const llmCandidates = remaining.filter((c) => c.turnIndex <= recentThreshold);

  if (llmCandidates.length === 0) {
    onPhase?.("done");
    return { evaluated: candidates.length, codeRemoved, llmRemoved: 0 };
  }

  // Build file edit history for LLM context
  const editHistory = buildEditHistory(candidates);

  // Process in batches to avoid oversized prompts
  let llmRemoved = 0;
  for (let offset = 0; offset < llmCandidates.length; offset += MAX_EVAL_PER_CALL) {
    const batch = llmCandidates.slice(offset, offset + MAX_EVAL_PER_CALL);
    const batchNum = Math.floor(offset / MAX_EVAL_PER_CALL) + 1;
    const totalBatches = Math.ceil(llmCandidates.length / MAX_EVAL_PER_CALL);
    onPhase?.("llm");

    const lines = batch.map((c, i) =>
      `${offset + i + 1}. [${c.toolCallId}] turn ${c.turnIndex}: ${c.toolName}(${c.argsPreview})\n   Preview: ${c.resultPreview}`
    );

    const editLines = editHistory.length > 0
      ? `\n\nFile edit history (these files were modified):\n${editHistory.map((e) => `  - turn ${e.turnIndex}: ${e.toolName} ${e.path}`).join("\n")}`
      : "";

    const userMessage = `Current turn is ~${maxTurn}. Evaluating batch ${batchNum}/${totalBatches} (${batch.length} results).${editLines}\n\nWhich can be safely removed?\n\n${lines.join("\n\n")}`;

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
