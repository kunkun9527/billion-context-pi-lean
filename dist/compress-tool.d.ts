import { Type, type Static } from "typebox";
import { type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { type ToolPromptOverrides } from "./surface.js";
import { type CompressionBlock, type CompressionState, type NudgeDecision } from "acp-kernel";
declare const RangeSpec: Type.TObject<{
    startId: Type.TString;
    endId: Type.TString;
    summary: Type.TString;
    topic: Type.TOptional<Type.TString>;
}>;
declare const CompressParams: Type.TObject<{
    topic: Type.TOptional<Type.TString>;
    content: Type.TUnion<[Type.TArray<Type.TObject<{
        startId: Type.TString;
        endId: Type.TString;
        summary: Type.TString;
        topic: Type.TOptional<Type.TString>;
    }>>, Type.TString]>;
    summaryMaxChars: Type.TOptional<Type.TNumber>;
}>;
type CompressArgs = Static<typeof CompressParams>;
export declare function makeCompressTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides, pi?: ExtensionAPI): ToolDefinition<typeof CompressParams>;
type RangeEntry = Static<typeof RangeSpec>;
/** Persisted in the compress toolResult's `details` (never sent to the model).
 *  When a dedicated model writes summaries, the call's arguments hold only the
 *  caller's short fallback, and failed ranges are not folded at all — so the
 *  log alone cannot rebuild the blocks. `acpFolded` records exactly what was
 *  folded; state-rebuild prefers it over the arguments. */
export interface CompressResultDetails {
    acpFolded?: {
        version: 1;
        ranges: Array<{
            startId: string;
            endId: string;
            summary: string;
            topic?: string;
        }>;
    };
}
export declare function normalizeRanges(args: CompressArgs): RangeEntry[] | string;
export declare function tailRepair(s: string): string | undefined;
export declare function arrayWrapRepair(s: string): string | undefined;
/** Panel block count, or -1 for non-panels. Accepts BOTH the legacy
 *  "… B blocks)" form (0-block runs; historical transcripts replayed by
 *  index/floor-stale) and the #376 "… blocks: b3=m00044–m00097*, …" form. */
export declare function compressPanelBlocks(text: string): number;
/** Success = completed run that created >= 1 block (partial range errors
 *  still count: progress was made). A 0-block panel must NOT be success —
 *  it would reset the retry counter while the emergency nudge re-fires,
 *  looping no-op compressions (issue #6). */
export declare function isCompressSuccessText(text: string): boolean;
/** No-op = completed run that compressed nothing (0-block panel: every
 *  range skipped). Counted as a FAILED attempt by noteCompressOutcomes so
 *  the retry cap applies. Non-panels ("No ranges provided.") stay neutral. */
export declare function isCompressNoopText(text: string): boolean;
export declare function blockSpanLabel(block: CompressionBlock, state: CompressionState): string;
export declare function summaryFingerprintLine(blockId: string, summary: string): string;
export declare function tierReadyHint(state: CompressionState, config: ReturnType<AcpRuntime["configFor"]>): string;
/** Header for the post-fold range list. Below the model's minimum benefit
 *  (the same bar that silences nudges and idle compact) it says to stop. */
export declare function remainingRangesHeader(nudge: NudgeDecision | undefined, config: {
    modelContextLimit: number;
    nudge: {
        minPressureBenefitTokens?: number;
    };
}): string;
type AgentMessage = SessionMessageEntry["message"];
/**
 * Lean: put each active block's full current summary back into the outbound
 * compress-call arguments. The kernel stubs those summaries to 200 chars
 * because it renders the full text as separate `acp_summary_` messages, but
 * coreOutToAgentMessages drops those (pi has no slot for them), so without this
 * the main model only ever sees its own stubbed fallback — never the summary
 * the dedicated model wrote — and decompresses blocks just to read them.
 * Arguments are parsed with normalizeRanges, so every shape the tool accepts
 * (bare objects, startRef/endRef, single-range, string content) is covered.
 * Ranges match blocks by start/end ref; a single-range call whose callId owns a
 * single active block (legacy blocks without refs) maps directly. Ranges with
 * no active block are dropped, as the kernel does for dead ranges.
 */
export declare function inlineBlockSummaries(messages: AgentMessage[], blocks: readonly CompressionBlock[]): AgentMessage[];
export {};
