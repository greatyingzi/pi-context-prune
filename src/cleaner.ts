/**
 * `/pruner clean` — LLM-evaluated stale tool result removal.
 *
 * Scans the current context for toolResult messages that haven't been indexed,
 * asks the LLM which ones are stale/no longer needed, and adds them to the
 * indexer so they're pruned on the next context event.
 */

import type { ContextPruneConfig, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";

/** Max toolResults to send to LLM for evaluation at once. */
const MAX_EVAL_BATCH = 60;

/** Max chars of result text to include in the evaluation prompt. */
const RESULT_PREVIEW_LENGTH = 150;

const EVAL_SYSTEM_PROMPT = `You are evaluating tool call results from an AI coding assistant's conversation.
The conversation has been going on for many turns. Some early tool results are now stale
or no longer needed because:
- The information has been superseded by later work (files were edited, decisions were made)
- The results were exploratory and the relevant knowledge is already captured in later context
- The results are very old and no longer relevant to the current task

You will receive a list of tool results with their tool name, arguments, turn index, and
a preview of the result text.

For each tool result, decide if it can be safely removed from context without losing
information the assistant still needs. Be conservative — when in doubt, keep it.

IMPORTANT: Always KEEP:
- The most recent read of any file (the assistant may need to reference it)
- Any edit/write operation (these describe what was changed)
- Results from the last 5 turns (too recent to be stale)
- Results containing error messages that haven't been resolved
- Results with unique information not likely to appear elsewhere

Safe to REMOVE:
- Old reads of files that were later edited (content is outdated)
- Duplicate/exploratory reads where the information is captured elsewhere
- Very old search results (grep/find) that were just exploration
- Old bash outputs that were one-time checks

Respond with valid JSON only:
{
  "removeIds": ["toolCallId1", "toolCallId2", ...]
}

If no results should be removed, respond: { "removeIds": [] }`;

interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  turnIndex: number;
  resultPreview: string;
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
 * Scan context messages for unindexed toolResults, ask LLM which are stale,
 * and add them to the indexer.
 *
 * @returns number of tool results marked for removal
 */
export async function cleanToolResults(
  messages: any[],
  indexer: ToolCallIndexer,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
): Promise<{ evaluated: number; removed: number }> {
  // Collect unindexed toolResults
  const candidates: ToolResultInfo[] = [];

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
    });
  }

  if (candidates.length === 0) {
    return { evaluated: 0, removed: 0 };
  }

  // Limit batch size
  const batch = candidates.slice(0, MAX_EVAL_BATCH);

  // Build evaluation prompt
  const lines = batch.map((c, i) =>
    `${i + 1}. [${c.toolCallId}] turn ${c.turnIndex}: ${c.toolName}(${c.argsPreview})\n   Result: ${c.resultPreview}`
  );

  const userMessage = `Evaluate these ${batch.length} tool results. Which can be safely removed?\n\n${lines.join("\n\n")}`;

  // Call LLM
  try {
    const model = ctx.model;
    const response = await model.complete([
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ]);

    const text = typeof response === "string" ? response : response.content ?? "";
    const parsed = tryParseJson(text);

    if (!parsed || !Array.isArray(parsed.removeIds)) {
      return { evaluated: batch.length, removed: 0 };
    }

    const removeSet = new Set(parsed.removeIds);
    let removed = 0;

    for (const candidate of batch) {
      if (removeSet.has(candidate.toolCallId)) {
        // Add to indexer as "summarized" (no actual summary, just marks for pruning)
        indexer.getIndex().set(candidate.toolCallId, {
          toolCallId: candidate.toolCallId,
          toolName: candidate.toolName,
          args: {},
          resultText: "",
          isError: false,
          turnIndex: candidate.turnIndex,
          timestamp: 0,
          filePath: undefined,
        });
        removed++;
      }
    }

    return { evaluated: batch.length, removed };
  } catch (err) {
    return { evaluated: batch.length, removed: 0 };
  }
}

/** Try to parse JSON from LLM response, handling markdown fences. */
function tryParseJson(text: string): { removeIds: string[] } | null {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Find first { and last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.substring(start, end + 1));
  } catch {
    return null;
  }
}
