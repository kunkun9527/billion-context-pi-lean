import { type CompressionCore, type CompressionState, type Config, type CoreMessage } from "acp-kernel";
import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
type AgentMessage = SessionMessageEntry["message"];
export declare function collectCoveredMessageIds(state: {
    blocks: {
        active: boolean;
        effectiveMessageIds: string[];
    }[];
}): Set<string>;
export declare const IMAGE_TOKEN_COST = 1600;
export declare function modelSupportsImages(model: unknown): boolean;
export declare function collectImageTokens(entries: {
    id: string;
    type?: string;
    message?: AgentMessage;
}[], visionCapable: boolean): Map<string, number>;
export declare function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>, imageTokensById?: Map<string, number>): number;
/** Shared ruler for send, display and compress preview. This only reads the
 * overflow episode: consuming its one-shot arm, calibration samples and the
 * previous-turn meter remain send-only policies in the context hook. */
export declare function measureTurnInputs(runtime: AcpRuntime, ctx: ExtensionContext, { state, coreMessages, entries }: Awaited<ReturnType<AcpRuntime["stateFor"]>>): {
    config: Config;
    fullWindow: number;
    systemPromptTokens: number;
    imageTokens: Map<string, number>;
    fixedTokens: number;
    sentTokens: number;
    realUsage: import("@earendil-works/pi-coding-agent").ContextUsage | undefined;
    realPromptTokens: number;
    predates: boolean;
    hostFloor: number;
};
/** Display keeps its existing fresh-anchor floor; it neither samples live
 * calibration nor consumes the armed emergency. Compress preview uses only
 * the view count, since it resolves boundaries rather than sending a request. */
export declare function displayTokenCount(viewTokens: number, measurement: ReturnType<typeof measureTurnInputs>): number;
export declare function sentViewTokenCount(core: CompressionCore, messages: CoreMessage[], state: CompressionState, config: Config, prelim: number, imageTokensById?: Map<string, number>, systemPromptTokens?: number): {
    viewTokens: number;
    drifted: boolean;
};
export declare function adjustedTokenCount(core: CompressionCore, messages: CoreMessage[], state: CompressionState, config: Config, prelim: number, imageTokensById?: Map<string, number>, systemPromptTokens?: number): number;
/** Per-session record of the EXACT sent view measured off the previous real
 *  processTurn output (issue #561) — replaces re-running a probe processTurn
 *  (clone + full second pass over the whole history) on every steady-state
 *  turn. */
export interface SentViewMeterRecord {
    viewTokens: number;
    /** The raw (pre-prune) estimate of the same turn, on the sentTokens scale.
     *  Lean: the next turn adds its raw growth since then to viewTokens. */
    rawTokens: number;
    /** blockSignature() of the state the view was measured on. */
    blockSig: string;
    /** historyCanary() of the projected messages the view was measured on. */
    history: HistoryCanary;
    limit: number;
    /** False when the measured view may be dishonest (post-truncation output,
     *  or the record is absent) — callers must then run the full probe. */
    usable: boolean;
}
/** Block count plus each active block's id, coverage size, run, tier and
 *  summary length: a decompress + compress pair, an absorb that keeps the
 *  active count, or an in-place refold (same id and coverage, rewritten
 *  summary) still changes it. Length suffices — only the size is metered. */
export declare function blockSignature(state: CompressionState): string;
export interface HistoryCanary {
    count: number;
    firstId: string | null;
    lastId: string | null;
}
export declare function historyCanary(messages: CoreMessage[]): HistoryCanary;
/** Signature check for adopting the previous turn's measured view (issue #561):
 *  the meter describes LAST turn's (state, config, history); it is only
 *  transferable when nothing structural moved — same window, same block
 *  signature, history only appended to — and the raw estimate did not shrink.
 *  Pure function, unit-testable. */
export declare function sentViewMeterMatches(meter: SentViewMeterRecord | undefined, state: CompressionState, config: Config, rawTokens: number, messages: CoreMessage[]): boolean;
/** Lean: the previous view plus everything appended since. Adopting the bare
 *  previous viewTokens dropped the new messages' growth from the meter. */
export declare function adoptedViewTokens(meter: SentViewMeterRecord, rawTokens: number): number;
export {};
