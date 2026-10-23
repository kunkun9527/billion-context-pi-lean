import type { CompressionBlock } from "acp-kernel";
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
/** pi's getContextUsage() is only a provider measurement while it is anchored on
 *  a valid assistant usage. With no anchor, or a `context_edit` after it (pi's
 *  auto-retry appends one to omit every failed attempt), pi's
 *  estimateProjectedContextTokens distrusts the usage and re-estimates every
 *  message of its own projection — the raw, unfolded history, not the sent
 *  view. Flooring on that number pinned the meter at 120–170% after a single
 *  failed request and fired false EMERGENCY nudges. Expects `entries` in branch
 *  order with context edits applied but edit entries kept (applyContextEdits). */
export declare function hostUsageMeasured(entries: AnchorEntry[]): boolean;
/** Host context tokens when they are a provider measurement (see
 *  hostUsageMeasured), else 0 so callers fall back to the sent-view estimate. */
export declare function measuredHostTokens(usage: {
    tokens?: number | null;
} | null | undefined, entries: AnchorEntry[]): number;
/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — the host's provider-usage number
 *  still reflects the pre-compression request. Failed/no-op compresses don't
 *  count (nothing was reclaimed). */
export declare function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean;
export interface AnchorStaleness {
    predates: boolean;
    netReclaimed: number;
}
export declare function compressionAnchorStaleness(entries: AnchorEntry[], blocks: readonly CompressionBlock[], countTokens: (text: string) => number): AnchorStaleness;
export {};
