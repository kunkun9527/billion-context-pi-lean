export type FoldAnchorSetting = boolean | "tool-output";
export type FoldAnchorMode = "text" | "tool-output";
/** Anchor mode, or undefined when off: the anchor applies only when not
 *  disabled in config AND the live model is a Claude model on a `*responses`
 *  API (the wire format handled here). Any value other than false or
 *  "tool-output" means the default text-part anchor. */
export declare function claudeFoldAnchorMode(setting: FoldAnchorSetting | undefined, model: {
    api?: string;
    id?: string;
} | undefined): FoldAnchorMode | undefined;
/** Earliest ref by numeric order (refs may outgrow 5 digits). */
export declare function earliestRef(refs: string[]): string | undefined;
export interface FoldAnchorOutcome {
    body?: unknown;
    /** Index of the anchored input item, when one was marked. */
    index?: number;
    reason?: string;
}
/** Mark the last text part (or, in "tool-output" mode, tool output) that precedes `startRef` (the earliest compressible
 *  message, or the previous one when none remains; it may already be folded
 *  away — the scan compares ref numbers, so it need not appear in the body).
 *  Conservative: the anchor sits at or before the last tagged item
 *  whose ref is below `startRef`, so untagged assistant items belonging to the
 *  range can never be anchored. Pure: returns a shallow-copied body. */
export declare function applyFoldAnchor(body: unknown, startRef: string | undefined, mode?: FoldAnchorMode): FoldAnchorOutcome;
