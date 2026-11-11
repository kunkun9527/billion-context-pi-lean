/** The anchor applies only when enabled in config AND the live model is a
 *  Claude model on a `*responses` API (the wire format handled here). */
export declare function claudeFoldAnchorApplies(enabled: boolean | undefined, model: {
    api?: string;
    id?: string;
} | undefined): boolean;
/** Earliest ref by numeric order (refs may outgrow 5 digits). */
export declare function earliestRef(refs: string[]): string | undefined;
export interface FoldAnchorOutcome {
    body?: unknown;
    /** Index of the anchored input item, when one was marked. */
    index?: number;
    reason?: string;
}
/** Mark the last text part that precedes `startRef` (the earliest compressible
 *  message). Conservative: the anchor sits at or before the last tagged item
 *  whose ref is below `startRef`, so untagged assistant items belonging to the
 *  range can never be anchored. Pure: returns a shallow-copied body. */
export declare function applyFoldAnchor(body: unknown, startRef: string | undefined): FoldAnchorOutcome;
