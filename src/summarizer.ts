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
import { serializeBatchForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;



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
 * Chunk size for parallel summarization.
 * Each chunk is summarized independently via a single LLM call.
 * 3 batches per chunk keeps prompts manageable and avoids JSON-parsing fragility.
 */
const CHUNK_SIZE = 3;

/**
 * Summarizes all batches using chunked parallel LLM calls.
 *
 * Batches are split into chunks of ~3, and each chunk is summarized
 * independently. For small chunks (≤1 batch) the simple path is used;
 * for larger chunks all batches are sent in one call and the LLM
 * returns concatenated summaries separated by a known delimiter.
 *
 * This replaces the previous fragile structured-JSON single-call approach.
 * Chunked parallel calls are more reliable and scale better.
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

  // Split into chunks and summarize each chunk in parallel.
  const chunks: CapturedBatch[][] = [];
  for (let i = 0; i < batches.length; i += CHUNK_SIZE) {
    chunks.push(batches.slice(i, i + CHUNK_SIZE));
  }

  // Run all chunks in parallel
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      if (chunk.length === 1) {
        // Single batch in chunk — use the simple path
        return [await summarizeBatch(chunk[0], config, ctx, {
          signal: options.signal,
          onTextProgress: (chars) => {
            const globalIdx = batches.indexOf(chunk[0]);
            options.onBatchTextProgress?.(globalIdx, batches.length, chunk[0], chars);
          },
        })];
      }

      // Multiple batches in chunk — serialize together and summarize in one call.
      return summarizeChunk(chunk, config, ctx, batches, options);
    })
  );

  // Flatten chunk results into a single array aligned with the original batches
  const results = chunkResults.flat();

  // If any chunk produced null entries, fall back to full parallel (one call per batch).
  // This handles cases where the LLM didn't follow the delimiter format correctly.
  if (results.some((r) => r === null)) {
    ctx.ui.notify(
      "pruner: chunked summary had failures — falling back to parallel calls",
      "warning"
    );
    return summarizeBatches(batches, config, ctx, options);
  }

  return results;
}

/**
 * Summarize a chunk of batches (2-3) in one LLM call.
 * Uses a simple concatenated prompt — no JSON parsing required.
 * The LLM returns summaries separated by a delimiter,
 * which are split client-side.
 */
async function summarizeChunk(
  chunk: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  allBatches: CapturedBatch[],
  options: SummarizeBatchesOptions
): Promise<Array<SummarizeResult | null>> {
  const DELIMITER = "--- NEXT_BATCH ---";

  try {
    const model = resolveModel(config, ctx);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return chunk.map(() => null);
    }

    // Serialize all batches in the chunk with clear delimiters
    const chunkText = chunk.map((batch) => {
      const globalIdx = allBatches.indexOf(batch);
      return `=== Batch ${globalIdx + 1} (turn ${batch.turnIndex}) ===\n` + serializeBatchForSummarizer(batch);
    }).join(`\n\n${DELIMITER}\n\n`);

    const userMessage = `${SYSTEM_PROMPT}\n\nHere are ${chunk.length} batches to summarize.\n` +
      `Provide a separate summary for each batch, separated by "${DELIMITER}".\n\n` +
      `<tool-call-batches>\n${chunkText}\n</tool-call-batches>`;

    let lastReportedChars = -1;
    const reportTextProgress = (chars: number) => {
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        const globalIdx = allBatches.indexOf(chunk[0]);
        options.onBatchTextProgress?.(globalIdx, allBatches.length, chunk[0], chars);
      }
    };
    reportTextProgress(0);

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

    for await (const event of responseStream) {
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(receivedTextChars(event.partial));
      }
    }

    if (options.signal?.aborted) throw new Error("summarizeChunk: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(receivedTextChars(response));

    if (response.stopReason === "aborted") {
      throw new Error("summarizeChunk: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Split by delimiter to get per-batch summaries
    const parts = llmText.split(new RegExp(`${DELIMITER}`, "g"));

    const results: Array<SummarizeResult | null> = [];
    if (parts.length >= chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        const summaryText = parts[i].trim();
        if (!summaryText) {
          results.push(null);
          continue;
        }
        // Split usage evenly across batches in the chunk
        results.push({
          summaryText,
          usage: {
            input: Math.round(response.usage.input / chunk.length),
            output: Math.round(response.usage.output / chunk.length),
            cacheRead: Math.round(response.usage.cacheRead / chunk.length),
            cacheWrite: Math.round(response.usage.cacheWrite / chunk.length),
            totalTokens: Math.round(response.usage.totalTokens / chunk.length),
            cost: {
              input: response.usage.cost.input / chunk.length,
              output: response.usage.cost.output / chunk.length,
              cacheRead: response.usage.cost.cacheRead / chunk.length,
              cacheWrite: response.usage.cost.cacheWrite / chunk.length,
              total: response.usage.cost.total / chunk.length,
            },
          },
        });
      }
    } else {
      // Parsing failed — use the whole text for the first batch, null for rest
      ctx.ui.notify(
        `pruner: chunk summary returned ${parts.length} part(s) instead of ${chunk.length}, splitting may be incomplete`,
        "warning"
      );
      results.push({
        summaryText: llmText.trim(),
        usage: response.usage,
      });
      for (let i = 1; i < chunk.length; i++) {
        results.push(null);
      }
    }

    return results;
  } catch (err: any) {
    if (options.signal?.aborted) throw err;
    // On failure, fall back to individual calls for this chunk
    return Promise.all(
      chunk.map(async (batch) => {
        const globalIdx = allBatches.indexOf(batch);
        return summarizeBatch(batch, config, ctx, {
          signal: options.signal,
          onTextProgress: (chars) => {
            options.onBatchTextProgress?.(globalIdx, allBatches.length, batch, chars);
          },
        });
      })
    );
  }
}
