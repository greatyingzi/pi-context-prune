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
} from "./types.js";
import { serializeBatchForSummarizer, serializeAllBatchesForStructured } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

/**
 * System prompt for the structured (single-call) summarization path.
 * Requests JSON output with one entry per turn, keyed by turnIndex.
 */
const STRUCTURED_SYSTEM_PROMPT = `You are summarizing tool calls from multiple turns of an AI coding assistant.
Each turn is delimited by XML tags: <turn index="N"> ... </turn>.

For each turn, provide a concise summary covering:
- Tool names and what each did
- Key outcomes: success/failure and the most important data
- Any findings the future conversation needs to remember

Respond with valid JSON only (no markdown fencing, no prose outside the JSON):
{
  "summaries": [
    {
      "turnIndex": <number>,  // must match the turn index from the XML tag
      "summaryText": "concise markdown summary of this turn's tool calls, 1-3 bullet points per tool"
    }
  ]
}

Order the entries in the same order as the turns appear in the input.`;

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
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  );
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
    if (obj && Array.isArray(obj.summaries)) return obj.summaries;
  } catch {}

  // Try removing trailing commas before ] or }
  try {
    const fixed = candidate.replace(/,\s*([}\]])/g, "$1");
    const obj = JSON.parse(fixed);
    if (obj && Array.isArray(obj.summaries)) return obj.summaries;
  } catch {}

  return null;
}

/**
 * Summarizes all batches in a single LLM call using structured JSON output.
 *
 * All pending batches are serialized with XML turn delimiters, sent to the LLM
 * in one request, and the JSON response is parsed to extract per-turn summaries.
 * This reduces N parallel LLM calls to 1 (or 2 for very large batches).
 *
 * Returns an array of per-batch results (same shape as summarizeBatches).
 * Each element is either a SummarizeResult (success) or null (parsing failed).
 * Token usage is attributed proportionally: input tokens by batch text size ratio,
 * output tokens and cost split evenly.
 */
export async function summarizeAllBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  if (batches.length === 1) {
    // Single batch — use the standard path (no overhead from JSON parsing)
    return [await summarizeBatch(batches[0], config, ctx, { signal: options.signal })];
  }

  try {
    const model = resolveModel(config, ctx);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return batches.map(() => null);
    }

    const serialized = serializeAllBatchesForStructured(batches);
    const userMessage = "<tool-call-turns>\n" + serialized + "\n</tool-call-turns>";

    let lastReportedChars = -1;
    const reportTextProgress = (chars: number) => {
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        // Report as the first batch for progress purposes
        options.onBatchTextProgress?.(0, batches.length, batches[0], chars);
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

    if (options.signal?.aborted) throw new Error("summarizeAllBatches: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(receivedTextChars(response));

    if (response.stopReason === "aborted") {
      throw new Error("summarizeAllBatches: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Structured summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const parsed = tryParseStructuredJson(llmText);
    if (!parsed || parsed.length === 0) {
      ctx.ui.notify(
        "pruner: structured summary returned no valid entries — falling back to parallel calls",
        "warning"
      );
      // Fall back to parallel-per-batch
      return summarizeBatches(batches, config, ctx, options);
    }

    // Build a lookup map: turnIndex -> summaryText
    const summaryMap = new Map<number, string>();
    for (const entry of parsed) {
      if (entry.turnIndex != null && entry.summaryText) {
        summaryMap.set(entry.turnIndex, entry.summaryText);
      }
    }

    // Attribute usage proportionally across batches
    const totalUsage = response.usage;
    const totalInputChars = batches.reduce((s, b) => {
      return s + b.toolCalls.reduce((cs, tc) => cs + tc.resultText.length + JSON.stringify(tc.args).length, 0);
    }, 0);

    const results: Array<SummarizeResult | null> = [];
    for (const batch of batches) {
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
      const inputRatio = totalInputChars > 0 ? batchInputChars / totalInputChars : 1 / batches.length;
      const outputRatio = 1 / batches.length;

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
            total: totalUsage.cost.total / batches.length,
          },
        },
      });
    }

    return results;
  } catch (err: any) {
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(
      `pruner: structured summarization failed (${err.message}) — falling back to parallel calls`,
      "warning"
    );
    // Fall back to parallel-per-batch
    return summarizeBatches(batches, config, ctx, options);
  }
}
