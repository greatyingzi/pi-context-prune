/**
 * Knowledge Matcher — preflight knowledge retrieval before main LLM call.
 *
 * Flow:
 *   1. Extract keywords from user prompt (code, zero cost)
 *   2. Fuzzy match against knowledge graph → candidates
 *   3. One lightweight LLM call to select the most relevant entries
 *   4. Inject selected knowledge into context for the main LLM
 *
 * This adds ~1-2s latency but gives the main LLM precisely the knowledge
 * it needs, instead of dumping the entire graph.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { stream } from "@mariozechner/pi-ai";
import type { FileKnowledge, KnowledgeGraphMap, ContextPruneConfig } from "./types.js";
import { KnowledgeGraph } from "./knowledge-graph.js";

// ── Keyword extraction (code, zero cost) ────────────────────────────────────

/** Extract candidate keywords from user prompt. */
export function extractKeywords(prompt: string): string[] {
  const keywords: string[] = [];

  // 1. Quoted strings: "src/foo.ts" or 'validateEmail' or `template`
  const quoted = prompt.match(/['"`]([^'"`]+)['"`]/g) ?? [];
  for (const q of quoted) {
    keywords.push(q.slice(1, -1));
  }

  // 2. File paths: src/foo.ts, ./bar/baz.ts, ~/config.rs
  const paths = prompt.match(/(?:src\/|\.\.?\/|~\/)[\w.-]+(?:\/[\w.-]+)*/g) ?? [];
  keywords.push(...paths);

  // 3. CamelCase/PascalCase identifiers (2+ segments): validateEmail, FooBar
  const camel = prompt.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? [];
  keywords.push(...camel);

  // 4. snake_case identifiers: parse_config, MIN_BATCH
  const snake = prompt.match(/\b[a-z]+(?:_[a-z]+)+\b|\b[A-Z]+(?:_[A-Z]+)+\b/gi) ?? [];
  keywords.push(...snake);

  // 5. kebab-case identifiers: my-component, foo-bar
  const kebab = prompt.match(/\b[a-z]+(?:-[a-z]+){1,}\b/g) ?? [];
  keywords.push(...kebab);

  // 6. $variable — dollar-sign prefixed variables
  const dollar = prompt.match(/\$([a-zA-Z_]\w{1,})/g) ?? [];
  keywords.push(...dollar);

  // 7. <Component /> JSX / HTML tag names (capture just the name)
  const jsx = prompt.match(/<([A-Z][a-zA-Z0-9]+)(?:\s|\/|>)/g) ?? [];
  for (const tag of jsx) {
    keywords.push(tag.slice(1).replace(/[\s\/>,].*$/, ""));
  }

  // 8. #[...] macro / attribute patterns (Rust, etc.)
  const macro = prompt.match(/#\[([\w()]+)\]/g) ?? [];
  for (const m of macro) {
    keywords.push(m);
  }

  // Deduplicate
  return [...new Set(keywords.filter((k) => k.length >= 2))];
}

// ── Fuzzy matching (code, zero cost) ────────────────────────────────────────

/** Match knowledge graph entries against keywords. Returns scored candidates. */
export function fuzzyMatchGraph(
  graph: KnowledgeGraphMap,
  keywords: string[]
): Array<{ entry: FileKnowledge; score: number; matchedBy: string[] }> {
  const candidates: Array<{ entry: FileKnowledge; score: number; matchedBy: string[] }> = [];

  for (const entry of graph.values()) {
    let score = 0;
    const matchedBy: string[] = [];

    // Pre-compute path segments for segment-level matching
    const pathSegments = entry.path.toLowerCase().split(/[\/\\.]/);

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();

      // Path segment match (high weight — keyword matches a path segment exactly)
      for (const seg of pathSegments) {
        if (seg === kwLower) {
          score += 12;
          matchedBy.push(`path-segment:${kw}`);
          break;
        }
      }

      // Path prefix/suffix match (medium-high weight)
      if (entry.path.toLowerCase().endsWith(kwLower) || entry.path.toLowerCase().includes(kwLower)) {
        // But only if the keyword looks like a file path (contains / or .)
        if (kw.includes("/") || kw.includes(".")) {
          score += 8;
          matchedBy.push(`path:${kw}`);
        }
      }

      // Export match (high weight — user asks about a function/class by name)
      for (const exp of entry.exports) {
        if (exp.toLowerCase() === kwLower || exp.toLowerCase().includes(kwLower)) {
          score += 8;
          matchedBy.push(`export:${exp}`);
          break;
        }
      }

      // Structure match (medium weight)
      for (const struct of entry.structure) {
        if (struct.toLowerCase().includes(kwLower)) {
          score += 5;
          matchedBy.push(`struct:${kw}`);
          break;
        }
      }

      // Changes match (medium weight)
      for (const change of entry.changes) {
        if (change.toLowerCase().includes(kwLower)) {
          score += 4;
          matchedBy.push(`change:${kw}`);
          break;
        }
      }

      // Import match (lower weight)
      for (const imp of entry.imports) {
        if (imp.toLowerCase().includes(kwLower)) {
          score += 3;
          matchedBy.push(`import:${kw}`);
          break;
        }
      }
    }

    // Base relevance: recently touched files get a small boost
    const maxTurn = Math.max(entry.lastEditTurn, entry.lastReadTurn);
    if (maxTurn > 0) score += 1;

    if (score > 0) {
      candidates.push({ entry, score, matchedBy });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── LLM selection (1 lightweight call) ─────────────────────────────────────

const SELECTION_PROMPT = `You are a knowledge retrieval assistant. Given a user's message and a list of candidate file knowledge entries, select the MOST RELEVANT entries for answering the user's message.

Rules:
- Select only entries that are directly relevant to the user's question or task.
- Prefer entries about files the user explicitly mentions or that contain functions/types the user asks about.
- If the user asks about a bug or change, prefer entries with matching changes.
- If the user asks about a feature or behavior, prefer entries with matching exports or structure.
- Return between 0 and 5 entries. It's OK to return 0 if nothing is relevant.
- Respond with valid JSON only, no markdown fencing:

{ "selected": [0, 2, 4] }

The numbers are indices into the candidates list.`;

export interface KnowledgeSelection {
  selected: number[];
}

/** Use a lightweight LLM call to select the most relevant entries. */
export async function selectRelevantKnowledge(
  candidates: Array<{ entry: FileKnowledge; score: number }>,
  userPrompt: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<Array<FileKnowledge>> {
  if (candidates.length === 0) return [];
  if (candidates.length <= 3) return candidates.map((c) => c.entry);

  // Serialize candidates for the LLM
  const candidateText = candidates
    .slice(0, 15) // Cap at 15 candidates to keep prompt small
    .map((c, i) => {
      const e = c.entry;
      const parts: string[] = [`[${i}] ${e.path}`];
      if (e.exports.length > 0) parts.push(`  exports: ${e.exports.join(", ")}`);
      if (e.structure.length > 0) parts.push(`  structure: ${e.structure.slice(0, 3).join("; ")}`);
      if (e.changes.length > 0) parts.push(`  changes: ${e.changes.join("; ")}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const prompt = `${SELECTION_PROMPT}\n\nUser message:\n${userPrompt}\n\nCandidates:\n${candidateText}`;

  try {
    // Use stream() like the summarizer does — ensures provider options work
    const auth = ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    const responseStream = stream(
      ctx.model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        // Limit output size — we just need a small JSON array
        maxTokens: 200,
      }
    );

    // Consume stream
    for await (const _event of responseStream) {
      // Just consume — we get the final result below
    }

    const response = await responseStream.result();
    const text = typeof response === "string" ? response : response.text ?? "";

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*"selected"[\s\S]*\}/);
    if (!jsonMatch) return candidates.slice(0, 3).map((c) => c.entry);

    const parsed = JSON.parse(jsonMatch[0]) as KnowledgeSelection;
    if (!Array.isArray(parsed.selected)) return candidates.slice(0, 3).map((c) => c.entry);

    return parsed.selected
      .filter((i) => i >= 0 && i < candidates.length)
      .map((i) => candidates[i].entry);
  } catch {
    // Fallback: return top 3 by score
    return candidates.slice(0, 3).map((c) => c.entry);
  }
}

// ── Serialization for injection ─────────────────────────────────────────────

/** Serialize selected knowledge entries for context injection. */
export function serializeForInjection(
  entries: Array<FileKnowledge>,
  pathsWithActiveSummary?: Set<string>
): string {
  if (entries.length === 0) return "";

  const sections: string[] = ["<relevant-knowledge>"];

  for (const entry of entries) {
    // Skip files that already have an unpruned summary in context
    if (pathsWithActiveSummary?.has(entry.path)) continue;

    const parts: string[] = [];
    if (entry.exports.length > 0) {
      parts.push(`  exports: ${entry.exports.join(", ")}`);
    }
    if (entry.imports.length > 0) {
      parts.push(`  imports: ${entry.imports.slice(-3).join("; ")}`);
    }
    if (entry.structure.length > 0) {
      parts.push(`  structure:\n    ${entry.structure.slice(-5).join("\n    ")}`);
    }
    if (entry.changes.length > 0) {
      // Cap changes at last 3
      parts.push(`  changes: ${entry.changes.slice(-3).join("; ")}`);
    }

    if (parts.length > 0) {
      sections.push(`  ${entry.path}:`);
      sections.push(...parts);
    }
  }

  sections.push("</relevant-knowledge>");

  // If all entries were skipped, return empty
  if (sections.length <= 2) return "";
  return sections.join("\n");
}
