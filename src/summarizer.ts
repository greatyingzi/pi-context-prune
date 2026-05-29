import { stream } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
  StructuredFileInfo,
} from "./types.js";
import { serializeBatchForSummarizer, serializeAllBatchesForStructured } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing tool calls made by an AI coding assistant.
The summary replaces the original tool output in future context, so preserve
information the assistant may need later.

Summarize by tool type:

- **read**: file path + key structure (exports, interfaces, function signatures,
  class definitions). Omit implementation details and raw code. Note if the
  file was empty or didn't exist.

- **edit/write**: file path + what changed and why. Include function/variable
  names affected. Omit unchanged code.

- **bash**: command + exit code + critical output (errors, key results).
  Omit verbose stdout/logs. For search commands (grep, find, rg), summarize
  the number of matches and most relevant hits.

- **Other tools**: tool name + one-sentence outcome + any data the assistant
  will reference later.

Keep each tool call to 1-3 bullet points. Be concise. Preserve specific names
(variables, functions, file paths) verbatim.`;

/**
 * System prompt for structured JSON summarization.
 * Requests strict JSON output with one entry per turn, keyed by turnIndex.
 */
const STRUCTURED_SYSTEM_PROMPT = `You are summarizing tool calls from multiple turns of an AI coding assistant.
The summaries replace the original tool outputs in future context, so preserve
information the assistant may need later.
Each turn is delimited by XML tags: <turn index="N"> ... </turn>.

Summarize by tool type:

- **read**: file path + key structure (exports, interfaces, function signatures,
  class definitions). Omit implementation details and raw code.

- **edit/write**: file path + what changed and why. Include function/variable
  names affected. Omit unchanged code.

- **bash**: command + exit code + critical output (errors, key results).
  Omit verbose stdout/logs. For search commands, summarize match count
  and most relevant hits.

- **Other tools**: tool name + outcome + any data needed later.

Respond with valid JSON only (no markdown fencing, no prose outside the JSON):
{
  "summaries": [
    {
      "turnIndex": <number>,
      "summaryText": "concise markdown summary, 1-3 bullet points per tool call, preserve specific names verbatim"
    }
  ],
  "files": [
    {
      "path": "src/foo.ts",
      "exports": ["Foo", "Bar"],
      "imports": ["{ Baz } from qux"],
      "structure": ["interface Config { ... }", "function parse(s: string): T"],
      "changes": ["added validateEmail()"]
    }
  ]
}

Rules for "files":
- Extract one entry per file that was read, edited, or written.
- "exports": all exported names (functions, classes, interfaces, types, constants).
- "imports": key import statements (deduplicate, compact form).
- "structure": interface/type signatures, function signatures, class definitions — signatures only, no bodies.
- "changes": for edits/writes, what changed in this turn. Empty array for reads.
- "tags": 3-8 lowercase single-word tags describing WHEN this file's knowledge would be relevant. Include: domain concepts ("validation", "email", "config"), technical roles ("middleware", "database", "api"), related feature names, and key identifiers. These tags are used for matching against user queries.
- If a file appears in multiple turns, merge into one entry. Later edits overwrite earlier state.
- Order entries in the same order as turns appear in the input.`;

/**
 * Maximum number of parallel LLM calls for summarization.
 * Batches are split into at most MAX_GROUPS groups, each summarized
 * in one structured JSON LLM call.
 */
const MAX_GROUPS = 3;

/**
 * Maximum retry attempts per group. If a group's LLM call fails
 * (network error, malformed JSON, etc.), it is retried up to this many times.
 */
const MAX_RETRIES = 3;

/**
 * Compute the number of groups for a given batch count.
 * Algorithm: min(ceil(N / 3), MAX_GROUPS)
 * This ensures at most 3 parallel LLM calls regardless of batch count.
 */
function computeGroupCount(n: number): number {
  if (n <= 2) return 1;
  const ceil = Math.ceil(n / 3);
  return Math.min(ceil, MAX_GROUPS);
}

/**
 * Split batches into groups of roughly equal size.
 * Distribution: first (n % groups) groups get ceil(n/groups) batches,
 * remaining groups get floor(n/groups) batches.
 *
 * Examples:
 *   N=10, groups=3 → [4, 3, 3]
 *   N=7,  groups=3 → [3, 2, 2]
 *   N=5,  groups=2 → [3, 2]
 *   N=3,  groups=1 → [3]
 */
function splitIntoGroups<T>(items: T[], groupCount: number): T[][] {
  const base = Math.floor(items.length / groupCount);
  const remainder = items.length % groupCount;
  const groups: T[][] = [];
  let offset = 0;
  for (let i = 0; i < groupCount; i++) {
    const size = base + (i < remainder ? 1 : 0);
    groups.push(items.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

/**
 * Attempts to parse the LLM response as structured JSON.
 * Tries: raw JSON → strip markdown fences → strip trailing comma → give up.
 * Returns null if parsing fails after all attempts.
 */
function tryParseStructuredJson(text: string): { turnIndex: number; summaryText: string }[] | null {
  let candidate = text.trim();

  // Strip markdown code fences if present
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  // Try direct parse
  try {
    const obj = JSON.parse(candidate);
    if (obj && Array.isArray(obj.summaries)) {
      // Attach files data to the parsed result via a side channel
      if (Array.isArray(obj.files)) {
        try { _lastParsedFiles = obj.files; } catch {}
      }
      return obj.summaries;
    }
  } catch {}

  // Try removing trailing commas before ] or }
  try {
    const fixed = candidate.replace(/,\s*([}\]])/g, "$1");
    const obj = JSON.parse(fixed);
    if (obj && Array.isArray(obj.summaries)) {
      if (Array.isArray(obj.files)) {
        try { _lastParsedFiles = obj.files; } catch {}
      }
      return obj.summaries;
    }
  } catch {}

  return null;
}

/** Side channel: files extracted from the last successful structured JSON parse. */
let _lastParsedFiles: StructuredFileInfo[] = [];

/** Retrieve files extracted from the last structured JSON parse. */
export function getLastParsedFiles(): StructuredFileInfo[] {
  return _lastParsedFiles;
}

/** Reset the side channel (call before each summarizeGroup call). */
export function resetParsedFiles(): void {
  _lastParsedFiles = [];
}



export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const responseStream = stream(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) }
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    return {
      summaryText: llmText,
      usage: response.usage,
    };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes all batches using at most MAX_GROUPS parallel structured JSON LLM calls.
 *
 * Algorithm:
 *   1. Split batches into at most 3 groups of roughly equal size
 *   2. Each group is summarized in one LLM call with strict JSON output
 *   3. If a group fails (network error, malformed JSON), retry up to MAX_RETRIES times
 *   4. Never fall back to full parallel — failed groups produce null entries
 *
 * Token usage is attributed proportionally: input tokens by batch text-size ratio,
 * output tokens and cost split evenly within each group.
 */
export async function summarizeAllBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  if (batches.length === 1) {
    return [await summarizeBatch(batches[0], config, ctx, { signal: options.signal })];
  }

  // Compute group count and split batches
  const groupCount = computeGroupCount(batches.length);
  const groups = splitIntoGroups(batches, groupCount);

  // Summarize each group in parallel with retry logic
  const groupResults = await Promise.all(
    groups.map(async (group, groupIdx) => {
      let lastAttempt: Array<SummarizeResult | null> | null = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          ctx.ui.notify(
            `pruner: retrying group ${groupIdx + 1}/${groupCount} (attempt ${attempt + 1}/${MAX_RETRIES})`,
            "warning"
          );
        }

        try {
          const result = await summarizeGroup(group, config, ctx, batches, options);
          lastAttempt = result;
          // Check if all batches in the group were successfully summarized
          if (result.every((r) => r !== null)) {
            return result;
          }
          // Partial success (some nulls) — retry
        } catch (err: any) {
          if (options.signal?.aborted) throw err;
          ctx.ui.notify(
            `pruner: group ${groupIdx + 1} failed (${err.message}), will retry`,
            "warning"
          );
          // Continue to next attempt
        }
      }

      // All retries exhausted — return the last attempt (may have some nulls)
      ctx.ui.notify(
        `pruner: group ${groupIdx + 1} failed after ${MAX_RETRIES} attempts — some summaries may be missing`,
        "error"
      );
      return lastAttempt ?? group.map(() => null);
    })
  );

  // Flatten group results into a single array aligned with the original batches
  return groupResults.flat();
}

/**
 * Summarize a group of batches in one structured JSON LLM call.
 * Returns an array of per-batch results aligned with the group.
 */
async function summarizeGroup(
  group: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  allBatches: CapturedBatch[],
  options: SummarizeBatchesOptions
): Promise<Array<SummarizeResult | null>> {
  const model = resolveModel(config, ctx);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    const authMessage = "error" in auth ? auth.error : "authentication failed";
    ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
    return group.map(() => null);
  }

  // Serialize all batches in the group with XML turn delimiters
  const serialized = serializeAllBatchesForStructured(group);
  const userMessage = "<tool-call-turns>\n" + serialized + "\n</tool-call-turns>";

  let lastReportedChars = -1;
  const reportTextProgress = (chars: number) => {
    if (chars !== lastReportedChars) {
      lastReportedChars = chars;
      const globalIdx = allBatches.indexOf(group[0]);
      options.onBatchTextProgress?.(globalIdx, allBatches.length, group[0], chars);
    }
  };
  reportTextProgress(0);

  const responseStream = stream(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: STRUCTURED_SYSTEM_PROMPT + "\n\n" + userMessage }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) }
  );

  for await (const event of responseStream) {
    if (options.signal?.aborted) break;
    if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
      reportTextProgress(receivedTextChars(event.partial));
    }
  }

  if (options.signal?.aborted) throw new Error("summarizeGroup: aborted during stream");

  const response = await responseStream.result();
  reportTextProgress(receivedTextChars(response));

  if (response.stopReason === "aborted") {
    throw new Error("summarizeGroup: stream stopped with reason aborted");
  }
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
  }

  const llmText = response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  // Reset side channel before parsing
  resetParsedFiles();

  // Parse structured JSON
  const parsed = tryParseStructuredJson(llmText);
  if (!parsed || parsed.length === 0) {
    throw new Error(`structured summary returned no valid entries (${llmText.slice(0, 100)}...)`);
  }

  // Build a lookup map: turnIndex -> summaryText
  const summaryMap = new Map<number, string>();
  for (const entry of parsed) {
    if (entry.turnIndex != null && entry.summaryText) {
      summaryMap.set(entry.turnIndex, entry.summaryText);
    }
  }

  // Attribute usage proportionally across batches in the group
  const totalUsage = response.usage;
  const totalInputChars = group.reduce((s, b) => {
    return s + b.toolCalls.reduce((cs, tc) => cs + tc.resultText.length + JSON.stringify(tc.args).length, 0);
  }, 0);

  const results: Array<SummarizeResult | null> = [];
  for (const batch of group) {
    const summaryText = summaryMap.get(batch.turnIndex);
    if (!summaryText) {
      // This turn was not in the LLM response — mark as null
      results.push(null);
      continue;
    }

    // Attribute input tokens by text-size ratio, output tokens evenly
    const batchInputChars = batch.toolCalls.reduce(
      (s, tc) => s + tc.resultText.length + JSON.stringify(tc.args).length,
      0
    );
    const inputRatio = totalInputChars > 0 ? batchInputChars / totalInputChars : 1 / group.length;
    const outputRatio = 1 / group.length;

    results.push({
      summaryText,
      usage: {
        input: Math.round(totalUsage.input * inputRatio),
        output: Math.round(totalUsage.output * outputRatio),
        cacheRead: Math.round(totalUsage.cacheRead * inputRatio),
        cacheWrite: Math.round(totalUsage.cacheWrite * inputRatio),
        totalTokens: Math.round(totalUsage.totalTokens * ((inputRatio + outputRatio) / 2)),
        cost: {
          input: totalUsage.cost.input * inputRatio,
          output: totalUsage.cost.output * outputRatio,
          cacheRead: totalUsage.cost.cacheRead * inputRatio,
          cacheWrite: totalUsage.cost.cacheWrite * inputRatio,
          total: totalUsage.cost.total / group.length,
        },
      },
    });
  }

  return results;
}
