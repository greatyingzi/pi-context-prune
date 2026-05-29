/**
 * Knowledge Graph — organizes summarized tool results by file.
 *
 * Instead of N time-ordered summaries, the graph stores one FileKnowledge
 * entry per file, accumulating exports, imports, structure, and changes.
 * This gives O(1) lookup for "what does file X contain?" instead of
 * scanning N summaries.
 *
 * Updated after each flush. Persisted to session for reconstruction.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, FileKnowledge, KnowledgeGraphMap } from "./types.js";
import { CUSTOM_TYPE_KNOWLEDGE } from "./types.js";

export class KnowledgeGraph {
  private graph: KnowledgeGraphMap = new Map();

  /** Clear all knowledge. */
  reset(): void {
    this.graph.clear();
  }

  /** Get the underlying map. */
  getGraph(): KnowledgeGraphMap {
    return this.graph;
  }

  /**
   * Update the graph with knowledge extracted from summarized batches.
   * For each batch, extracts file paths from read/edit/write tool calls
   * and updates the corresponding FileKnowledge entry.
   */
  updateFromBatches(batches: CapturedBatch[]): void {
    for (const batch of batches) {
      for (const tc of batch.toolCalls) {
        const path = this.extractFilePath(tc.toolName, tc.args);
        if (!path) continue;

        let entry = this.graph.get(path);
        if (!entry) {
          entry = {
            path,
            exports: [],
            imports: [],
            structure: [],
            changes: [],
            lastReadTurn: -1,
            lastEditTurn: -1,
          };
          this.graph.set(path, entry);
        }

        if (tc.toolName === "read") {
          entry.lastReadTurn = Math.max(entry.lastReadTurn, batch.turnIndex);
          // Extract knowledge from result text (best-effort parsing)
          this.extractReadKnowledge(entry, tc.resultText);
        } else if (tc.toolName === "edit" || tc.toolName === "write") {
          entry.lastEditTurn = Math.max(entry.lastEditTurn, batch.turnIndex);
          // Extract change description from result or args
          this.extractEditKnowledge(entry, tc.args, tc.resultText);
        }
      }
    }
  }

  /**
   * Update the graph from a summary text (post-summarization).
   * The summary contains structured knowledge that's more reliable than
   * raw result parsing.
   */
  updateFromSummary(path: string, summaryText: string, turnIndex: number, isEdit: boolean): void {
    let entry = this.graph.get(path);
    if (!entry) {
      entry = {
        path,
        exports: [],
        imports: [],
        structure: [],
        changes: [],
        lastReadTurn: -1,
        lastEditTurn: -1,
      };
      this.graph.set(path, entry);
    }

    // Parse summary for structured knowledge
    this.extractSummaryKnowledge(entry, summaryText, isEdit);

    if (isEdit) {
      entry.lastEditTurn = Math.max(entry.lastEditTurn, turnIndex);
    } else {
      entry.lastReadTurn = Math.max(entry.lastReadTurn, turnIndex);
    }
  }

  /** Extract file path from tool call args. */
  private extractFilePath(toolName: string, args: Record<string, unknown>): string | undefined {
    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      const p = args.path ?? args.filePath;
      return typeof p === "string" ? p : undefined;
    }
    return undefined;
  }

  /** Best-effort extraction of knowledge from a raw file read result. */
  private extractReadKnowledge(entry: FileKnowledge, resultText: string): void {
    // Quick heuristics — not perfect but covers common patterns
    const lines = resultText.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Exports: export function/class/interface/const/type/enum
      const exportMatch = trimmed.match(/^export\s+(?:default\s+)?(?:function|class|interface|const|type|enum|async\s+function)\s+(\w+)/);
      if (exportMatch) {
        const name = exportMatch[1];
        if (!entry.exports.includes(name)) {
          entry.exports.push(name);
        }
        // Also add to structure
        const sig = trimmed.length > 80 ? trimmed.substring(0, 80) + "…" : trimmed;
        if (!entry.structure.includes(sig)) {
          entry.structure.push(sig);
        }
      }

      // Imports: import { ... } from '...'
      const importMatch = trimmed.match(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const imports = importMatch[1] || importMatch[2];
        const from = importMatch[3];
        const importStr = imports ? `{ ${imports.trim()} } from ${from}` : `from ${from}`;
        if (!entry.imports.some((i) => i === importStr)) {
          entry.imports.push(importStr);
        }
      }
    }
  }

  /** Extract change description from edit args/result. */
  private extractEditKnowledge(entry: FileKnowledge, args: Record<string, unknown>, _resultText: string): void {
    // Extract from edit args what changed
    const description = this.buildChangeDescription(args);
    if (description && !entry.changes.includes(description)) {
      // Keep only last 5 changes per file
      entry.changes.push(description);
      if (entry.changes.length > 5) {
        entry.changes = entry.changes.slice(-5);
      }
    }
  }

  /** Build a one-line change description from edit args. */
  private buildChangeDescription(args: Record<string, unknown>): string {
    // Pi edit args typically have: path, oldText, newText
    const oldText = String(args.oldText ?? "").trim();
    const newText = String(args.newText ?? "").trim();

    if (!oldText && newText) return `added ${this.truncateSnippet(newText)}`;
    if (oldText && !newText) return `removed ${this.truncateSnippet(oldText)}`;
    if (oldText && newText) return `changed ${this.truncateSnippet(oldText)} → ${this.truncateSnippet(newText)}`;
    return "";
  }

  /** Truncate a code snippet for change descriptions. */
  private truncateSnippet(text: string, maxLen = 60): string {
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.substring(0, maxLen) + "…";
  }

  /** Extract knowledge from a summary text (post-LLM summarization). */
  private extractSummaryKnowledge(entry: FileKnowledge, summaryText: string, isEdit: boolean): void {
    // Parse bullet points from summary for structured data
    const lines = summaryText.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Look for export mentions
      const exportMention = trimmed.match(/exports?[:\s]+(.*?)(?:\.|$)/i);
      if (exportMention) {
        const names = exportMention[1].split(/[,\s]+/).filter((n) => n.length > 0 && n !== "and");
        for (const name of names) {
          const clean = name.replace(/[`*[\]()]/g, "").trim();
          if (clean && !entry.exports.includes(clean) && clean.length < 40) {
            entry.exports.push(clean);
          }
        }
      }

      // For edits, add the summary line as a change description
      if (isEdit && trimmed.startsWith("-") && trimmed.length > 5) {
        const desc = trimmed.replace(/^[-•*]\s*/, "").trim();
        if (desc && !entry.changes.includes(desc) && desc.length < 120) {
          entry.changes.push(desc);
          if (entry.changes.length > 5) {
            entry.changes = entry.changes.slice(-5);
          }
        }
      }

      // Structure: interface/type/function mentions
      const structMatch = trimmed.match(/(?:interface|type|class|function|enum)\s+(\w+)/);
      if (structMatch) {
        const name = structMatch[1];
        if (!entry.exports.includes(name) && !entry.structure.some((s) => s.includes(name))) {
          const sig = trimmed.length > 80 ? trimmed.substring(0, 80) + "…" : trimmed;
          entry.structure.push(sig);
        }
      }
    }
  }

  /**
   * Serialize the graph to a compact text block for context injection.
   * One section per file, minimal formatting.
   */
  serialize(): string {
    if (this.graph.size === 0) return "";

    const sections: string[] = ["<file-knowledge>"];

    // Sort: recently edited files first, then recently read
    const sorted = [...this.graph.values()].sort((a, b) => {
      const aMax = Math.max(a.lastEditTurn, a.lastReadTurn);
      const bMax = Math.max(b.lastEditTurn, b.lastReadTurn);
      return bMax - aMax;
    });

    for (const entry of sorted) {
      const parts: string[] = [];

      if (entry.exports.length > 0) {
        parts.push(`  exports: ${entry.exports.join(", ")}`);
      }
      if (entry.imports.length > 0) {
        // Keep imports compact
        const imports = entry.imports.slice(-5).join("; ");
        parts.push(`  imports: ${imports}`);
      }
      if (entry.structure.length > 0) {
        // Keep structure compact — last 8 items
        const structs = entry.structure.slice(-8).join("\n    ");
        parts.push(`  structure:\n    ${structs}`);
      }
      if (entry.changes.length > 0) {
        parts.push(`  changes: ${entry.changes.join("; ")}`);
      }

      if (parts.length > 0) {
        sections.push(`  ${entry.path}:`);
        sections.push(...parts);
      }
    }

    sections.push("</file-knowledge>");
    return sections.join("\n");
  }

  /** Serialize to JSON for session persistence. */
  toJSON(): Array<FileKnowledge> {
    return [...this.graph.values()];
  }

  /** Restore from JSON. */
  fromJSON(data: Array<FileKnowledge>): void {
    this.graph.clear();
    for (const entry of data) {
      this.graph.set(entry.path, entry);
    }
  }

  /** Reconstruct from session entries. */
  reconstructFromSession(ctx: ExtensionContext, branch?: any[]): void {
    this.reset();
    const entries = branch ?? ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE_KNOWLEDGE && entry.data) {
        // Use the last persisted snapshot (overwrite previous)
        this.fromJSON(entry.data as Array<FileKnowledge>);
      }
    }
  }

  /** Persist current state to session. */
  persist(pi: ExtensionAPI): void {
    pi.appendEntry(CUSTOM_TYPE_KNOWLEDGE, this.toJSON());
  }
}
