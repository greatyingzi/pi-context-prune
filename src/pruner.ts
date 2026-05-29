import type { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";

/**
 * Filters the `context` event message array.
 * 1. Removes ToolResultMessage entries where toolCallId is in the index (existing behavior).
 * 2. Removes summary messages (customType: context-prune-summary) whose referenced
 *    toolCallIds are ALL stale — e.g. reads of files that were later edited.
 */
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[] {
  return messages.filter((msg) => {
    // Remove toolResult messages that have been summarized
    if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)) {
      return false;
    }

    // Remove summary messages whose toolCallRefs are entirely stale
    if (msg.customType === CUSTOM_TYPE_SUMMARY && msg.details?.toolCallRefs) {
      const refs: Array<{ toolCallId: string }> = msg.details.toolCallRefs;
      if (refs.length > 0 && refs.every((ref) => indexer.isStale(ref.toolCallId))) {
        return false;
      }
    }

    return true;
  });
}
