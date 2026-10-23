// pi's getContextUsage() anchors on the last assistant message with valid
// provider usage; a successful compress after that anchor leaves it reflecting
// the pre-compression request until the next turn reports fresh usage.
import type { CompressionBlock } from "acp-kernel";
import { isCompressSuccessText } from "./compress-tool.js";
import { extractText } from "./messages.js";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null | undefined;

type AnchorEntry = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: UsageLike;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown;
  };
};

function validAnchorUsage(u: UsageLike): boolean {
  if (!u) return false;
  const total = (u.totalTokens ?? 0) || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return total > 0;
}

interface AnchorScan {
  lastUsageIdx: number;
  lastEditIdx: number;
  lastCompressIdx: number;
  compressIdxByCallId: Map<string, number>;
}

function scanEntries(entries: AnchorEntry[]): AnchorScan {
  let lastUsageIdx = -1;
  let lastCompressIdx = -1;
  let lastEditIdx = -1;
  const compressIdxByCallId = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.type === "context_edit") lastEditIdx = i;
    const m = entries[i]!.message;
    if (!m) continue;
    if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && validAnchorUsage(m.usage)) {
      lastUsageIdx = i;
    } else if (
      m.role === "toolResult" &&
      m.toolName === "compress" &&
      m.toolCallId !== undefined &&
      m.isError !== true &&
      isCompressSuccessText(extractText(m.content))
    ) {
      lastCompressIdx = i;
      compressIdxByCallId.set(m.toolCallId, i);
    }
  }
  return { lastUsageIdx, lastEditIdx, lastCompressIdx, compressIdxByCallId };
}

/** pi's getContextUsage() is only a provider measurement while it is anchored on
 *  a valid assistant usage. With no anchor, or a `context_edit` after it (pi's
 *  auto-retry appends one to omit every failed attempt), pi's
 *  estimateProjectedContextTokens distrusts the usage and re-estimates every
 *  message of its own projection — the raw, unfolded history, not the sent
 *  view. Flooring on that number pinned the meter at 120–170% after a single
 *  failed request and fired false EMERGENCY nudges. Expects `entries` in branch
 *  order with context edits applied but edit entries kept (applyContextEdits). */
export function hostUsageMeasured(entries: AnchorEntry[]): boolean {
  const scan = scanEntries(entries);
  return scan.lastUsageIdx >= 0 && scan.lastEditIdx < scan.lastUsageIdx;
}

/** Host context tokens when they are a provider measurement (see
 *  hostUsageMeasured), else 0 so callers fall back to the sent-view estimate. */
export function measuredHostTokens(
  usage: { tokens?: number | null } | null | undefined,
  entries: AnchorEntry[],
): number {
  const tokens = usage?.tokens ?? 0;
  return tokens > 0 && hostUsageMeasured(entries) ? tokens : 0;
}

/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — the host's provider-usage number
 *  still reflects the pre-compression request. Failed/no-op compresses don't
 *  count (nothing was reclaimed). */
export function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean {
  const scan = scanEntries(entries);
  return scan.lastCompressIdx > scan.lastUsageIdx;
}

export interface AnchorStaleness {
  // anchor still reflects the pre-compression request
  predates: boolean;
  // Σ max(0, compressedTokens − summary) over active blocks whose compress
  // landed after the anchor; unattributable/pre-anchor blocks are excluded
  netReclaimed: number;
}

// issue #325: flooring at a stale anchor's raw value re-fires a false EMERGENCY,
// while skipping it under-counts by the fixed overhead the host already counts.
// Return how much was reclaimed since the anchor so callers floor at
// `anchor − netReclaimed` instead of either extreme.
export function compressionAnchorStaleness(
  entries: AnchorEntry[],
  blocks: readonly CompressionBlock[],
  countTokens: (text: string) => number,
): AnchorStaleness {
  const scan = scanEntries(entries);
  let netReclaimed = 0;
  for (const block of blocks) {
    if (!block.active || block.compressCallId == null) continue;
    const idx = scan.compressIdxByCallId.get(block.compressCallId);
    if (idx == null || idx <= scan.lastUsageIdx) continue;
    const saved = (block.compressedTokens ?? 0) - countTokens(block.summary ?? "");
    netReclaimed += saved > 0 ? saved : 0;
  }
  return { predates: scan.lastCompressIdx > scan.lastUsageIdx, netReclaimed };
}
