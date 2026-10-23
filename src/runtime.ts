import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  defaultPrompts,
  type CompressionCore,
  type CompressionState,
  type Config,
  type Prompts,
} from "acp-kernel";
import { resolveCompress, resolveConfig, type AdapterConfig } from "./config.js";
import { applyStrictReasoningGate, resolveReasoningDrop, type CompressReasoningConfig } from "./reasoning-drop.js";
import type { SentViewMeterRecord } from "./tokens.js";
import { applyContextEdits, entriesToCoreMessages, EntryProjectionCache } from "./messages.js";
import { SessionStateStore } from "./state.js";
import { hasCompressHistory, rebuildStateFromLog } from "./state-rebuild.js";
import { loadUserConfig, applyUserConfig, saveCompressionModelId } from "./user-config.js";
import { sanitizeSurfaceConfig } from "./surface.js";
import { ThrottleEpisode } from "./throttle-retry.js";
import { logInfo, logWarn, setDebugEnabled } from "./log.js";
import { OverflowEpisode } from "./overflow-selfheal.js";
import { findOffBranchBlocks, markOffBranchBlocks, withBranchGuard } from "./branch-guard.js";

type AgentMessage = SessionMessageEntry["message"];

export interface AcpRuntime {
  core: CompressionCore;
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
  noteCompressOutcomes(sid: string, turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean };
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
  stripImagesFor(ctx: ExtensionContext): { enabled: boolean; keepRecent: number };
  /** Re-read ~/.<dir>/acp.json + <cwd>/<dir>/acp.json and re-derive the adapter
   *  config when the contents change. Cheap no-op when unchanged. Called at
   *  session_start and on every context event so config edits apply live. */
  reloadConfig(cwd: string): Promise<void>;
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
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
function pruneOrphanRefs(state: CompressionState, messages: ReturnType<typeof entriesToCoreMessages>): void {
  const retainedRawIds = new Set(messages.map((message) => message.id));
  for (const block of state.blocks) {
    for (const rawId of [...block.directMessageIds, ...block.effectiveMessageIds]) retainedRawIds.add(rawId);
  }
  for (const [rawId, ref] of Object.entries(state.messageRefs.byRaw)) {
    if (retainedRawIds.has(rawId)) continue;
    delete state.messageRefs.byRaw[rawId];
    if (state.messageRefs.byRef[ref] === rawId) delete state.messageRefs.byRef[ref];
  }
  for (const [ref, rawId] of Object.entries(state.messageRefs.byRef)) {
    if (!retainedRawIds.has(rawId)) delete state.messageRefs.byRef[ref];
  }
}
/** Max FAILED compress calls per user turn before the nudge circuit breaker engages. */
export const MAX_COMPRESS_ATTEMPTS = 3;

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  // Lean: withBranchGuard keeps blocks whose range was partly left on another
  // branch inactive (see branch-guard.ts).
  const core = withBranchGuard(createCore({
    // CJK-aware base counter (kernel default); the meter's real-scale floor
    // (src/index.ts) covers provider-anchored calibration.
    countTokens: defaultCountTokens,
  }));
  const store = new SessionStateStore();
  const locks = new Map<string, Promise<void>>();
  const factoryAdapter = adapter;
  let adapterRef = adapter;
  let lastUserConfigKey: string | undefined;
  let promptsRef: Prompts = defaultPrompts;
  const nudgeShownTurns = new Map<string, Set<string>>();
  const nudgeShownTokens = new Map<string, Map<string, number>>();
  function markNudgeShown(sid: string, turnKey: string, tokenCount?: number): void {
    let turns = nudgeShownTurns.get(sid);
    if (!turns) { turns = new Set(); nudgeShownTurns.set(sid, turns); }
    turns.add(turnKey);
    if (tokenCount !== undefined) {
      let toks = nudgeShownTokens.get(sid);
      if (!toks) { toks = new Map(); nudgeShownTokens.set(sid, toks); }
      toks.set(turnKey, tokenCount);
    }
  }
  function nudgeShownFor(sid: string, turnKey: string): boolean {
    return nudgeShownTurns.get(sid)?.has(turnKey) ?? false;
  }
  function nudgeShownTokensFor(sid: string, turnKey: string): number | undefined {
    return nudgeShownTokens.get(sid)?.get(turnKey);
  }
  function clearNudgeTracking(sid: string): void {
    nudgeShownTurns.delete(sid);
    nudgeShownTokens.delete(sid);
    nudgeRecordedTurns.delete(sid);
  }
  function clearNudgeTokenStamps(sid: string): void {
    nudgeShownTokens.delete(sid);
  }
  const nudgeRecordedTurns = new Map<string, Set<string>>();
  function markNudgeRecorded(sid: string, turnKey: string): void {
    let turns = nudgeRecordedTurns.get(sid);
    if (!turns) { turns = new Set(); nudgeRecordedTurns.set(sid, turns); }
    turns.add(turnKey);
  }
  function nudgeRecordedFor(sid: string, turnKey: string): boolean {
    return nudgeRecordedTurns.get(sid)?.has(turnKey) ?? false;
  }
  // Per-session overflow self-heal state (learned window + armed emergency).
  const overflowEpisodes = new Map<string, OverflowEpisode>();
  function overflowFor(sid: string): OverflowEpisode {
    let ep = overflowEpisodes.get(sid);
    if (!ep) { ep = new OverflowEpisode(); overflowEpisodes.set(sid, ep); }
    return ep;
  }
  function overflowDrop(sid: string): void {
    overflowEpisodes.delete(sid);
  }

  // Issue #561: the sent-view meter replaces the per-turn probe processTurn
  // (clone + full second pass). Steady-state turns read the previous turn's
  // measured view instead of re-measuring; see noteSentViewCount for fields.
  const sentViewMeters = new Map<string, SentViewMeterRecord>();
  function noteSentViewCount(sid: string, record: SentViewMeterRecord): void {
    sentViewMeters.set(sid, record);
  }
  function peekSentViewCount(sid: string): SentViewMeterRecord | undefined {
    return sentViewMeters.get(sid);
  }
  function dropSentViewCount(sid: string): void {
    sentViewMeters.delete(sid);
  }

  const deadCompressCounts = new Map<string, Map<string, number>>();
  function noteDeadCompress(sid: string, fingerprint: string): number {
    let per = deadCompressCounts.get(sid);
    if (!per) { per = new Map(); deadCompressCounts.set(sid, per); }
    const count = (per.get(fingerprint) ?? 0) + 1;
    per.set(fingerprint, count);
    return count;
  }
  function clearDeadCompress(sid: string): void {
    deadCompressCounts.delete(sid);
  }

  function getCompressionModelRef(): string | undefined {
    const ref = adapterRef.compressionModelId;
    return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
  }
  async function setCompressionModelRef(value: string | null): Promise<void> {
    await saveCompressionModelId(value);
    const next = { ...adapterRef };
    if (value === null) delete next.compressionModelId;
    else next.compressionModelId = value;
    adapterRef = next;
    // Force the next reload to re-read merged global/project config.
    lastUserConfigKey = undefined;
  }
  const lastSentMessages = new Map<string, AgentMessage[]>();
  function setLastSentMessages(sid: string, messages: AgentMessage[]): void {
    lastSentMessages.set(sid, messages);
  }
  function getLastSentMessages(sid: string): AgentMessage[] | null {
    return lastSentMessages.get(sid) ?? null;
  }
  function dropLastSentMessages(sid: string): void {
    lastSentMessages.delete(sid);
  }

  const throttleEpisodes = new Map<string, ThrottleEpisode>();
  function throttleFor(sid: string): ThrottleEpisode {
    let ep = throttleEpisodes.get(sid);
    if (!ep) { ep = new ThrottleEpisode(); throttleEpisodes.set(sid, ep); }
    return ep;
  }
  function throttleDrop(sid: string): void {
    const ep = throttleEpisodes.get(sid);
    if (ep) ep.reset(); // abort a pending kick sleep before releasing the entry
    throttleEpisodes.delete(sid);
  }

  // Per-session tokenCount scale (estimate vs provider). When the anchor flips
  // stale↔not-stale the meter switches rulers; a growth delta spanning that
  // switch is a false artifact (issue #267), so the caller resets the baseline.
  const tokenScaleStale = new Map<string, boolean>();
  function noteTokenScale(sid: string, stale: boolean): boolean {
    const prev = tokenScaleStale.get(sid);
    tokenScaleStale.set(sid, stale);
    return prev !== undefined && prev !== stale;
  }
  function dropTokenScale(sid: string): void {
    tokenScaleStale.delete(sid);
  }

  // [#455] Per-session window of FRESH-anchor provider usage samples. The
  // calibration anchor caps the internal estimate at measured × headroom, but
  // only while recent samples agree: a jittering getContextUsage() (±15K on
  // near-identical views in the #452 log) must not become a moving cap.
  const HOST_USAGE_WINDOW = 4;
  const HOST_USAGE_MIN_SAMPLES = 3;
  const HOST_USAGE_SPREAD_MAX = 0.25;
  const hostUsageSamples = new Map<string, number[]>();
  function noteHostUsage(sid: string, tokens: number): boolean {
    if (tokens <= 0) return false;
    let win = hostUsageSamples.get(sid);
    if (!win) {
      win = [];
      hostUsageSamples.set(sid, win);
    }
    win.push(tokens);
    if (win.length > HOST_USAGE_WINDOW) win.shift();
    if (win.length < HOST_USAGE_MIN_SAMPLES) return false;
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    return (hi - lo) / lo <= HOST_USAGE_SPREAD_MAX;
  }
  function dropHostUsageSamples(sid: string): void {
    hostUsageSamples.delete(sid);
  }

  // [#455] Persistent >2x internal-vs-provider disagreement, one warn per
  // episode: fires on the third consecutive divergent turn, resets when the
  // rulers converge or the session ends.
  const sizeDivergenceStreaks = new Map<string, number>();
  function noteSizeDivergence(sid: string, divergent: boolean): boolean {
    if (!divergent) {
      sizeDivergenceStreaks.delete(sid);
      return false;
    }
    const streak = (sizeDivergenceStreaks.get(sid) ?? 0) + 1;
    sizeDivergenceStreaks.set(sid, streak);
    return streak === 3;
  }
  function dropSizeDivergence(sid: string): void {
    sizeDivergenceStreaks.delete(sid);
  }

  // [#464] Kernel observability signals (acp-kernel#302): terminalEscape is
  // the "compression cannot save this session" last signal, truncationSkipped
  // explains a silent emergency-truncate no-op. One episode flag each — the
  // kernel fires them every stuck turn, users must see them once.
  const terminalEscapeEpisodes = new Set<string>();
  function noteTerminalEscape(sid: string, active: boolean): boolean {
    if (!active) {
      terminalEscapeEpisodes.delete(sid);
      return false;
    }
    if (terminalEscapeEpisodes.has(sid)) return false;
    terminalEscapeEpisodes.add(sid);
    return true;
  }
  function dropTerminalEscape(sid: string): void {
    terminalEscapeEpisodes.delete(sid);
  }
  const truncationSkipEpisodes = new Set<string>();
  function noteTruncationSkipped(sid: string, active: boolean): boolean {
    if (!active) {
      truncationSkipEpisodes.delete(sid);
      return false;
    }
    if (truncationSkipEpisodes.has(sid)) return false;
    truncationSkipEpisodes.add(sid);
    return true;
  }
  function dropTruncationSkipped(sid: string): void {
    truncationSkipEpisodes.delete(sid);
  }

  // [#361] session ids already logged for the strict-echo auto-disable, so the
  // info event fires once per session rather than once per LLM call.
  const strictEchoLogged = new Set<string>();

  // Compress-failure tracking (see wireContextTransform): counts FAILED/no-op
  // compress calls per user turn so the nudge circuit breaker can stop
  // re-injecting the nudge at a model that answers every nudge with another
  // failed attempt (issue #6 emergency loop). The failed toolResult itself
  // persists in the session log — no transient retry prompt is injected
  // (transient re-injection per LLM call caused the #223 infinite loop). The
  // caller feeds only CURRENT-turn outcomes; success resets the counter,
  // neutral outcomes (non-error text that is not a success panel) leave it
  // frozen so mixed failure modes cannot bypass the cap.
  interface CompressOutcomeTracker {
    seen: Set<string>;
    failTurnKey: string | null;
    failCount: number;
  }
  const compressOutcomes = new Map<string, CompressOutcomeTracker>();
  function compressTrackerFor(sid: string): CompressOutcomeTracker {
    let t = compressOutcomes.get(sid);
    if (!t) { t = { seen: new Set(), failTurnKey: null, failCount: 0 }; compressOutcomes.set(sid, t); }
    return t;
  }

  function noteCompressOutcomes(sid: string, turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean } {
    const t = compressTrackerFor(sid);
    if (t.failTurnKey !== turnKey) {
      t.failTurnKey = turnKey;
      t.failCount = 0;
    }
    const prevCount = t.failCount;
    for (const o of outcomes) {
      if (t.seen.has(o.toolCallId)) continue;
      t.seen.add(o.toolCallId);
      if (o.isError || o.noop === true) {
        t.failCount += 1;
      } else if (o.success) {
        t.failCount = 0;
      }
      // neutral: counter untouched
    }
    const cappedNow = t.failCount >= MAX_COMPRESS_ATTEMPTS && prevCount < MAX_COMPRESS_ATTEMPTS;
    return { count: t.failCount, cappedNow };
  }

  function compressRetryCappedFor(sid: string, turnKey: string): boolean {
    const t = compressOutcomes.get(sid);
    return t !== undefined && t.failTurnKey === turnKey && t.failCount >= MAX_COMPRESS_ATTEMPTS;
  }

  function clearCompressRetryTracking(sid: string): void {
    compressOutcomes.delete(sid);
  }

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((resolve) => { resolveNext = resolve; });
    const tail = prev.then(() => next);
    locks.set(sid, tail);
    await prev;
    let released = false;
    // Only clear the slot if no later caller has queued behind us — deleting
    // unconditionally dropped their tail, so a third caller ran concurrently.
    return () => {
      if (released) return;
      released = true;
      if (locks.get(sid) === tail) locks.delete(sid);
      resolveNext();
    };
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    const usage = ctx.getContextUsage?.();
    if (usage?.contextWindow && usage.contextWindow > 0) return usage.contextWindow;
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    const m = ctx.model as { provider?: string; id?: string } | undefined;
    return resolveConfig(adapterRef, liveContextLimit(ctx), m?.provider, m?.id);
  }

  function reasoningDropFor(ctx: ExtensionContext): Required<CompressReasoningConfig> {
    const m = ctx.model as { provider?: string; id?: string; baseUrl?: string } | undefined;
    const resolved = resolveReasoningDrop(resolveCompress(adapterRef.compress, m?.provider, m?.id).reasoning);
    // [#361] strict-echo upstreams (DeepSeek thinking mode) must keep reasoning
    // round-tripping or the rebuilt request 400s — force the pass off regardless
    // of config so a thinking-mode session can't be broken by default drop:true.
    const gated = applyStrictReasoningGate(resolved, m?.provider, m?.baseUrl);
    if (resolved.drop && !gated.drop) {
      const sid = ctx.sessionManager.getSessionId();
      if (!strictEchoLogged.has(sid)) {
        strictEchoLogged.add(sid);
        logInfo("runtime", { sid, event: "compress-reasoning-auto-disabled", reason: "strict-echo-upstream", provider: m?.provider ?? null, issue: "#361" });
      }
    }
    return gated;
  }

  function stripImagesFor(ctx: ExtensionContext): { enabled: boolean; keepRecent: number } {
    const m = ctx.model as { provider?: string; id?: string } | undefined;
    const c = resolveCompress(adapterRef.compress, m?.provider, m?.id);
    const raw = Number(c.stripImagesKeepRecent);
    const keepRecent = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
    return { enabled: c.stripImages === true, keepRecent };
  }

  async function reloadConfig(cwd: string): Promise<void> {
    let user;
    try {
      user = await loadUserConfig(cwd);
    } catch (e) {
      logWarn("runtime", { event: "config-reload-failed", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      const key = JSON.stringify(user);
      if (key === lastUserConfigKey) return;
      lastUserConfigKey = key;
      // Re-derive from the factory config (not adapterRef) so a key REMOVED from
      // acp.json actually reverts, instead of lingering from a prior apply.
      adapterRef = sanitizeSurfaceConfig(applyUserConfig(factoryAdapter, user));
      if (adapterRef.debug !== undefined) setDebugEnabled(adapterRef.debug);
      logInfo("runtime", { event: "config-reloaded", limit: adapterRef.modelContextLimit ?? null });
    } catch (e) {
      logWarn("runtime", { event: "config-reload-failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Issue #561: per-session incremental projection cache — pi hosts rebuild the
  // entries array (fresh objects) every turn from an append-only jsonl, so the
  // 24k-entry projection is prefix-stable and only the new tail needs work.
  const projectionCaches = new Map<string, EntryProjectionCache>();
  function dropProjectionCache(sid: string): void {
    projectionCaches.delete(sid);
  }

  async function stateFor(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile() ?? undefined;
    const sessionId = sm.getSessionId();
    let state = await store.load(sessionFile, sessionId);
    const entries = applyContextEdits(sm.buildContextEntries());
    // Issue #299 (ranxianglei/billion-context-pi#299): pi's importFromJsonl
    // copies only the .jsonl, so the `${sessionFile}.acp.json` sidecar never
    // travels with an imported session and compression state silently resets
    // (the adapter then re-compresses already-compressed content). Last resort
    // after the sidecar and parent-session inheritance both miss: replay the
    // successful compress calls recorded in the session log itself.
    if (sessionFile && state.blocks.length === 0 && hasCompressHistory(entries)) {
      const rebuilt = rebuildStateFromLog({ entries, state, config: configFor(ctx), core });
      if (rebuilt.report.blocks > 0) {
        state = rebuilt.state;
        await store.save(state, sessionFile, sessionId);
        logInfo("state", {
          sid: sessionId,
          event: "state-rebuilt",
          blocks: rebuilt.report.blocks,
          callsApplied: rebuilt.report.callsApplied,
          callsSkipped: rebuilt.report.callsSkipped,
        });
      }
    }
    let projection = projectionCaches.get(sessionId);
    if (!projection) { projection = new EntryProjectionCache(); projectionCaches.set(sessionId, projection); }
    const coreMessages = projection.project(entries);
    pruneOrphanRefs(state, coreMessages);
    guardBranch(sm, sessionId, state, coreMessages);
    return { state, coreMessages, entries };
  }

  // Lean: mark blocks whose covered messages are partly on another branch of
  // the session tree; the wrapped core keeps them inactive this turn.
  const offBranchLogged = new Map<string, string>();
  function guardBranch(sm: ExtensionContext["sessionManager"], sessionId: string, state: CompressionState, coreMessages: ReturnType<typeof entriesToCoreMessages>): void {
    const all = (sm as unknown as { getEntries?: () => SessionEntry[] }).getEntries?.();
    const off = all && state.blocks.length > 0
      ? findOffBranchBlocks(state, coreMessages, new Set(all.map((e) => e.id)))
      : [];
    markOffBranchBlocks(state, off);
    const signature = off.join(",");
    if ((offBranchLogged.get(sessionId) ?? "") !== signature) {
      offBranchLogged.set(sessionId, signature);
      logInfo("state", { sid: sessionId, event: "off-branch-blocks", blocks: off });
    }
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  let refused = false;
  let refusalMessage: string | null = null;
  return { core, store, get refused() { return refused; }, set refused(v: boolean) { refused = v; }, get refusalMessage() { return refusalMessage; }, set refusalMessage(v: string | null) { refusalMessage = v; }, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, get prompts() { return promptsRef; }, setPrompts: (p) => { promptsRef = p; }, markNudgeShown, nudgeShownFor, nudgeShownTokensFor, clearNudgeTracking, clearNudgeTokenStamps, markNudgeRecorded, nudgeRecordedFor, noteCompressOutcomes, compressRetryCappedFor, clearCompressRetryTracking, liveContextLimit, configFor, reasoningDropFor, reloadConfig, stateFor, save, acquireLock, overflowFor, overflowDrop, noteSentViewCount, peekSentViewCount, dropSentViewCount, dropProjectionCache, noteDeadCompress, clearDeadCompress, throttleFor, throttleDrop , noteTokenScale, dropTokenScale, noteHostUsage, dropHostUsageSamples, noteSizeDivergence, dropSizeDivergence, noteTerminalEscape, dropTerminalEscape, noteTruncationSkipped, dropTruncationSkipped, stripImagesFor, getCompressionModelRef, setCompressionModelRef, setLastSentMessages, getLastSentMessages, dropLastSentMessages };}
