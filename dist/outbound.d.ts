import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { type CompressReasoningConfig } from "./reasoning-drop.js";
import { type DegenerationGuardConfig } from "./degeneration.js";
type AgentMessage = SessionMessageEntry["message"];
/** Phase 1: rewrite persisted history only. No nudge or live-only host tail may
 * enter this phase: a synthetic user message would falsely close an in-flight
 * compress round (#348). Rebuilds never modify the persisted entry objects. */
export declare function prepareHistoryForSend({ messages, blocks, entries, reasoningDrop, degenerationGuard }: {
    messages: CoreMessage[];
    blocks: CompressionBlock[];
    entries: SessionEntry[];
    reasoningDrop: CompressReasoningConfig;
    degenerationGuard?: boolean | DegenerationGuardConfig;
}): {
    messages: import("@earendil-works/pi-agent-core").AgentMessage[];
    droppedThinkingChars: number;
    collapsedMessages: number;
    maxCollapsedRun: number;
    minRun: number;
    recoveryRun: import("./degeneration.js").DegenerateRun | undefined;
};
/** Phase 3, AFTER transient nudges: restore host traffic, then sanitize the
 * final provider view. Sanitizing before liveTail would miss orphan results
 * carried by the host; uncompressed branches keep their original pairing. */
export declare function finalizeOutboundMessages({ messages, liveMessages, liveTail, hasCompression }: {
    messages: AgentMessage[];
    liveMessages: AgentMessage[];
    liveTail: AgentMessage[] | null;
    hasCompression: boolean;
}): {
    messages: import("@earendil-works/pi-agent-core").AgentMessage[];
    appendedTail: number;
    carriedSystems: number;
    droppedResults: string[];
};
export {};
