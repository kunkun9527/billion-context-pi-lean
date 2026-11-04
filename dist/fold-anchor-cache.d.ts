import { type CoreMessage, type CompressionBlock } from "acp-kernel";
type Anchor = {
    role: CoreMessage["role"];
    ref?: string;
    text?: string;
    callId?: string;
};
type Wire = "anthropic" | "responses";
export declare function foldAnchorMessageIds(original: readonly CoreMessage[], processed: readonly CoreMessage[], blocks: readonly Pick<CompressionBlock, "active" | "createdAt" | "effectiveMessageIds">[], limit: number, accept: (m: CoreMessage) => boolean): string[];
export declare function foldAnchorPolicy(api: string | undefined, origin: string | undefined): Wire | undefined;
/** Snapshot identities only; never retain or modify Pi's persisted messages. */
export declare function prepareFoldAnchors(original: readonly CoreMessage[], processed: readonly CoreMessage[], blocks: readonly CompressionBlock[], refs: Record<string, string>, originals: Map<string, unknown>, wire: Wire, model: {
    api?: string;
    provider?: string;
    id?: string;
}): Anchor[];
/** Add markers by copy; undefined means leave the provider payload untouched. */
export declare function applyFoldAnchors(payload: unknown, wire: Wire, anchors: readonly Anchor[]): unknown | undefined;
export {};
