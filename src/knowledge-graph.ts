/**
 * Knowledge Graph — organizes summarized tool results by file.
 *
 * Instead of N time-ordered summaries, the graph stores one FileKnowledge
 * entry per file, accumulating exports, imports, structure, and changes.
 * This gives O(1) lookup for "what does file X contain?" instead of
 * scanning N summaries.
 *
 * Updated after each flush with data extracted by the LLM during
 * structured summarization. No regex-based parsing.
 *
 * Persisted to session for reconstruction.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { FileKnowledge, KnowledgeGraphMap, StructuredFileInfo } from "./types.js";
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
   * Update the graph from LLM-extracted file info (structured summarization).
   * Each file entry from the LLM response is merged into the graph:
   * - exports/imports/structure: OVERWRITE (LLM has the latest view)
   * - changes: APPEND (each edit is a separate event)
   *
   * This is the primary update path — no regex-based extraction needed.
   */
  updateFromStructuredFiles(files: StructuredFileInfo[]): void {
    for (const info of files) {
      if (!info.path) continue;

      let entry = this.graph.get(info.path);
      if (!entry) {
        entry = {
          path: info.path,
          exports: [],
          imports: [],
          structure: [],
          changes: [],
          lastReadTurn: -1,
          lastEditTurn: -1,
        };
        this.graph.set(info.path, entry);
      }

      // LLM has the latest view — overwrite exports/imports/structure
      if (info.exports && info.exports.length > 0) {
        entry.exports = [...new Set(info.exports)];
      }
      if (info.imports && info.imports.length > 0) {
        entry.imports = [...new Set(info.imports)];
      }
      if (info.structure && info.structure.length > 0) {
        entry.structure = [...new Set(info.structure)];
      }

      // Changes are additive — each edit is a separate event
      if (info.changes && info.changes.length > 0) {
        for (const change of info.changes) {
          if (!entry.changes.includes(change)) {
            entry.changes.push(change);
          }
        }
        // Keep only last 5 changes per file
        if (entry.changes.length > 5) {
          entry.changes = entry.changes.slice(-5);
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

    // Sort: recently changed files first
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
        const imports = entry.imports.slice(-5).join("; ");
        parts.push(`  imports: ${imports}`);
      }
      if (entry.structure.length > 0) {
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
