import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { type CompressionCore, type CompressionState, type Config, type Prompts } from "acp-kernel";
import { type AdapterConfig } from "./config.js";
import { type CompressReasoningConfig } from "./reasoning-drop.js";
import type { SentViewMeterRecord } from "./tokens.js";
import { entriesToCoreMessages } from "./messages.js";
import { SessionStateStore } from "./state.js";
import { ThrottleEpisode } from "./throttle-retry.js";
import { OverflowEpisode } from "./overflow-selfheal.js";
type AgentMessage = SessionMessageEntry["message"];
export interface AcpRuntime {
    core: CompressionCore;
    /** Startup clears turn-local tracking, not learned overflow windows. */
    startSession(sid: string): void;
    /** Shutdown releases session-scoped episodes/caches; pending locks drain normally. */
    releaseSession(sid: string): void;
    noteLatestUserOverLimit(sid: string, active: boolean): boolean;
    noteDegenerationNotice(sid: string, signature: string): boolean;
    /** Set when the model's traffic routes through the billion-context wire
     *  proxy (#296), which then owns compression.
     *  Once true, the extension stands down: the context transform, system-prompt
     *  injection, compaction-cancel and ACP tools all no-op so the host runs
     *  untouched. Set at session_start (first context event as fallback). */
    refused: boolean;
    /** User-facing reason shown when a refused ACP tool is invoked. Set
     *  together with `refused`. */
    refusalMessage: string | null;
    /** Per-session provider-throttle retry episode (attempt budget + kick
     *  pacing), keyed by session id so concurrent sessions in one extension
     *  instance cannot share an episode. Reset on session_start and on any
     *  real progress / user input. */
    throttleFor: (sid: string) => ThrottleEpisode;
    /** Drop a session's throttle episode entirely (session_shutdown): aborts a
     *  pending kick sleep and releases the map entry so a long-lived process
     *  that cycles through many sessions doesn't accumulate them. */
    throttleDrop: (sid: string) => void;
    /** Per-session tokenCount scale tracker (estimate vs provider). Returns true
     *  when the scale just flipped (stale↔not-stale) so the caller can reset the
     *  growth baseline — a cross-scale delta is a false artifact, not real growth
     *  (issue #267). The first observation for a session never reports a flip. */
    noteTokenScale: (sid: string, stale: boolean) => boolean;
    /** Drop a session's token-scale tracker (session_shutdown). */
    dropTokenScale: (sid: string) => void;
    store: SessionStateStore;
    adapter: AdapterConfig;
    setAdapter(adapter: AdapterConfig): void;
    prompts: Prompts;
    setPrompts(prompts: Prompts): void;
    markNudgeShown(sid: string, turnKey: string, tokenCount?: number): void;
    nudgeShownFor(sid: string, turnKey: string): boolean;
    /** tokenCount at the last actual nudge injection for this turn, for growth-aware re-inject (issue #269). */
    nudgeShownTokensFor(sid: string, turnKey: string): number | undefined;
    /** Clears the token-count stamps recorded by markNudgeShown — used on a token-scale flip (issue #267) so the same-turn re-inject floor (#269 / PR #316) is not computed against an old-scale stamp. */
    clearNudgeTokenStamps(sid: string): void;
    /** Like the nudgeShown* pair but tracks the persisted display-only session
     *  entry (issue #326): at most one record per user turn even when the
     *  emergency nudge re-injects on every LLM call. */
    markNudgeRecorded(sid: string, turnKey: string): void;
    nudgeRecordedFor(sid: string, turnKey: string): boolean;
    /** Process compress toolResults for the CURRENT user turn only (the caller
     *  scopes the list — see collectCompressOutcomes in src/index.ts); idempotent
     *  per toolCallId. turnKey is the last user-turn boundary. Outcome classes:
     *  isError or noop (0-block panel) → failure (count++), success panel
     *  (>= 1 block) → reset, other non-error text → neutral (count unchanged).
     *  Returns the failure count and whether the cap was just reached. */
    noteCompressOutcomes(sid: string, turnKey: string, outcomes: ReadonlyArray<{
        toolCallId: string;
        isError: boolean;
        success: boolean;
        noop?: boolean;
    }>): {
        count: number;
        cappedNow: boolean;
    };
    /** True when this turn already burned MAX_COMPRESS_ATTEMPTS failed/no-op
     *  compress calls — used to stop re-injecting the (dedup-exempt) emergency
     *  nudge that would otherwise keep looping no-op compressions (issue #6). */
    compressRetryCappedFor(sid: string, turnKey: string): boolean;
    clearNudgeTracking(sid: string): void;
    clearCompressRetryTracking(sid: string): void;
    liveContextLimit(ctx: ExtensionContext): number;
    configFor(ctx: ExtensionContext): Config;
    /** [#336] Effective compress.reasoning drop settings for the active model
     *  (three-level merge + defaults). Feeds the request-time pass in the
     *  context transform. */
    reasoningDropFor(ctx: ExtensionContext): Required<CompressReasoningConfig>;
    /** Effective historical-image strip policy for the active model (issue #321).
     *  Host-side policy — deliberately NOT part of the kernel Config object. */
    stripImagesFor(ctx: ExtensionContext): {
        enabled: boolean;
        keepRecent: number;
    };
    /** Re-read ~/.<dir>/acp.json + <cwd>/<dir>/acp.json and re-derive the adapter
     *  config when the contents change. Cheap no-op when unchanged. Called at
     *  session_start and on every context event so config edits apply live. */
    reloadConfig(cwd: string): Promise<void>;
    stateFor(ctx: ExtensionContext): Promise<{
        state: CompressionState;
        coreMessages: ReturnType<typeof entriesToCoreMessages>;
        entries: SessionEntry[];
    }>;
    /** Record the EXACT sent view measured off the real processTurn output for
     *  this turn (issue #561): `viewTokens` counts turn.messages (the pruned,
     *  summary-injected projection that actually went on the wire), and `usable`
     *  marks whether that count is an honest view — a turn that ran with
     *  tokenCount at/above the truncate band may have truncated its output, so
     *  its post-truncation size under-reports and must not be trusted next turn. */
    noteSentViewCount(sid: string, record: SentViewMeterRecord): void;
    /** Last turn's measured sent view, or undefined on the first turn / after a
     *  signature change (blocks added or dropped, window re-centered). */
    peekSentViewCount(sid: string): SentViewMeterRecord | undefined;
    /** Drop a session's sent-view meter (session_shutdown). */
    dropSentViewCount(sid: string): void;
    /** Drop a session's incremental projection cache (session_shutdown): it
     *  holds the full projected CoreMessage[] for the session history. */
    dropProjectionCache(sid: string): void;
    save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
    acquireLock(sid: string): Promise<() => void>;
    /** Per-session overflow self-heal state (learned window + armed emergency).
     *  Keyed by session id so concurrent sessions cannot share an episode. */
    overflowFor(sid: string): OverflowEpisode;
    /** Drop a session's overflow episode entirely (session_shutdown): releases
     *  the map entry so a long-lived process cycling through many sessions
     *  doesn't accumulate them. */
    overflowDrop(sid: string): void;
    /** Record a compress call whose every requested range is dead (refs stale or
     *  unknown — the kernel cannot create a block from it no matter what summary
     *  is written). Returns the failure count for this exact range fingerprint
     *  in this session (issue #250 loop breaker). */
    noteDeadCompress(sid: string, fingerprint: string): number;
    /** Drop a session's dead-range repeat tracking (a successful compress is
     *  progress — reset the #250 loop breaker for the next attempt round;
     *  session_shutdown for memory hygiene). Compress does NOT renumber refs. */
    clearDeadCompress(sid: string): void;
    /** Dedicated summary model ref (`session`, `provider/id`, bare id), or undefined. */
    getCompressionModelRef(): string | undefined;
    /** Persist the ref to the global acp.json (null clears) and apply it now. */
    setCompressionModelRef(value: string | null): Promise<void>;
    /** Exact transformed messages from the latest provider-bound context pass. */
    setLastSentMessages(sid: string, messages: AgentMessage[]): void;
    getLastSentMessages(sid: string): AgentMessage[] | null;
    dropLastSentMessages(sid: string): void;
    /** Record one turn's FRESH-anchor provider usage sample and report whether
     *  the recent window is stable enough to calibrate the internal estimate
     *  against it (issue #455): >=3 of the last 4 samples agree within a 25%
     *  spread. A jittering getContextUsage() must not become a moving cap, so
     *  unstable windows report false and the raw estimate stands. */
    noteHostUsage(sid: string, tokens: number): boolean;
    /** Drop a session's host-usage stability window (session_shutdown). */
    dropHostUsageSamples(sid: string): void;
    /** Track persistent >2x internal-vs-provider size disagreement (issue #455);
     *  returns true exactly once per episode — on the third consecutive
     *  divergent turn — so the caller warns once instead of every turn. A
     *  convergent turn ends the episode. */
    noteSizeDivergence(sid: string, divergent: boolean): boolean;
    /** Drop a session's size-divergence episode (session_shutdown). */
    dropSizeDivergence(sid: string): void;
    /** Track the kernel's terminal-escape signal (issue #464): returns true
     *  exactly once per episode — the first consecutive stuck fire — so the
     *  caller logs/notifies once instead of every turn. A non-escaping turn
     *  ends the episode. */
    noteTerminalEscape(sid: string, active: boolean): boolean;
    /** Drop a session's terminal-escape episode (session_shutdown). */
    dropTerminalEscape(sid: string): void;
    /** Track the kernel's truncation-skipped signal (issue #464): returns true
     *  exactly once per episode for low-frequency diagnostics. A turn that
     *  truncates (or skips nothing) ends the episode. */
    noteTruncationSkipped(sid: string, active: boolean): boolean;
    /** Drop a session's truncation-skipped episode (session_shutdown). */
    dropTruncationSkipped(sid: string): void;
}
/** Max FAILED compress calls per user turn before the nudge circuit breaker engages. */
export declare const MAX_COMPRESS_ATTEMPTS = 3;
export declare function createRuntime(adapter: AdapterConfig): AcpRuntime;
export {};
