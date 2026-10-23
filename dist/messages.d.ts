import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { type Config, type CoreMessage } from "acp-kernel";
import type { TurnBoundaryEntry } from "./turn-boundary.js";
type AgentMessage = SessionMessageEntry["message"];
/** Host-injected status-panel custom messages (written by src/commands.ts) —
 *  UI-only, never projected into LLM context, so never user-like entries. */
export declare const ACP_STATUS_CUSTOM_TYPE = "acp-status";
/** /acp-export handoff docs (src/export.ts) — UI-only transcript output,
 *  persistent in the session but never projected into LLM context (#255). */
export declare const ACP_EXPORT_CUSTOM_TYPE = "acp-export";
/** /acp-rule outputs (src/commands.ts) — UI-only transcript output, same
 *  exclusion as acp-status/acp-export (#526): the rules themselves already
 *  reach the model through the feature's own channel, so the human-facing
 *  report must never be re-billed as model context. */
export declare const ACP_RULE_CUSTOM_TYPE = "acp-rule";
/** Nudge persistence record (issue #326): written via pi.appendEntry as a
 *  type:"custom" entry — never projected into the sent view (see above), so
 *  the compact one-liner stays out of model context while surviving restarts. */
export declare const ACP_NUDGE_CUSTOM_TYPE = "acp-nudge";
export interface AcpNudgeRecord {
    text: string;
}
/** True for host-injected custom_message entries that participate in LLM
 *  context: non-empty custom_message except the UI-only types in
 *  CONTEXT_EXCLUDED_CUSTOM_TYPES (acp-status panels, acp-export docs,
 *  acp-rule reports)
 *  (Pi-native projection semantics, session-manager.d.ts). The non-empty gate
 *  uses the exact same extractText check as the projection below, so an entry
 *  either enters context or it doesn't. */
export declare function isCustomMessageEntry(entry: TurnBoundaryEntry): entry is TurnBoundaryEntry & {
    type: "custom_message";
};
export declare function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[];
/** Apply Pi `context_edit` entries the way Pi's own buildSessionProjection does
 *  (projectContextEntry): `replacement: null` omits the target from model
 *  context, otherwise only its content is replaced (assistant/toolResult string
 *  content becomes one text part). `buildContextEntries()` returns the raw path,
 *  so without this the rebuild re-sends attempts Pi omitted (auto-retry's
 *  _omitRecoveryAttempt) and ignores content replacements. The edit entries
 *  themselves stay in the array (they project to nothing) so callers can see
 *  where an edit happened. Returns `entries` itself when there is no edit. */
export declare function applyContextEdits(entries: SessionEntry[]): SessionEntry[];
/** Append-only incremental cache for entriesToCoreMessages (issue #561).
 *
 *  Projection is a pure prefix-stable function: each entry contributes a fixed
 *  slice of CoreMessages, so projecting entries[0..n) then appending the
 *  projection of entries[n..m) equals projecting entries[0..m) — as long as the
 *  first n entries are UNCHANGED. Hosts rebuild the entries array (and the entry
 *  objects) from the append-only session jsonl every turn, so identity caching
 *  is useless; validate structurally instead:
 *    - count only ever GROWS (a drop = host rewind/truncate → full reproject),
 *    - the first and last cached boundary entries still carry the same ids
 *      (canaries against in-place rewrites the count check cannot see),
 *    - at most MAX_INCREMENTAL_ENTRIES new entries per turn,
 *    - no new `context_edit` entry (it rewrites an EARLIER entry's contribution).
 *  Any doubt → full entriesToCoreMessages, identical result, just slower. */
export declare class EntryProjectionCache {
    private count;
    private firstId;
    private lastId;
    private cores;
    /** Project `entries`, reusing the previous turn's work when the array is a
     *  structural extension of the last one seen. Returns a defensive copy: the
     *  internal array is shared across turns, and callers hand it to kernel code
     * that must never observe (or mutate) cross-turn state. */
    project(entries: SessionEntry[]): CoreMessage[];
    /** Drop the cache (state rebuilt, session switched). */
    reset(): void;
}
export declare function extractText(content: unknown): string;
export declare function thinkingTokenCount(content: unknown): number;
export declare function countImageBlocks(content: unknown): number;
export declare const TRUNCATION_MARKER = "[truncated for context space]";
export declare function coreOutToAgentMessages(coreOut: CoreMessage[], originalById: Map<string, AgentMessage>): AgentMessage[];
export interface LatestUserGuardResult {
    messages: CoreMessage[];
    /** Id of the latest user message whose kernel truncation was undone. */
    restoredId?: string;
    /** Estimated request size after the guard (tokenCount scale). */
    remainingTokens: number;
}
/** Lean: the kernel protects the most recent user message from compression
 *  but its emergency truncation only protects the last N messages, so a big
 *  prompt followed by a few tool rounds lost its body without any summary.
 *  Undo that truncation and give the reclaimed budget to the other candidates
 *  (the kernel's own truncator, run with the user message hidden). */
export declare function protectLatestUserMessage(inMessages: CoreMessage[], outMessages: CoreMessage[], config: Config, tokenCount: number): LatestUserGuardResult;
export {};
