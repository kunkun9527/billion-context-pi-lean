import { Type, type Static } from "typebox";
import {
  convertToLlm,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { MAX_COMPRESS_ATTEMPTS } from "./runtime.js";
import { lastTurnBoundaryId } from "./turn-boundary.js";
import { debug, logError, logInfo, logThrow, logWarn } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, measureTurnInputs, adjustedTokenCount } from "./tokens.js";
import { applyToolPromptOverrides, type ToolPromptOverrides } from "./surface.js";
import { parseCompressArgs, resolveBoundaries, resolveBlockSpan, viableRanges, formatRanges, type CompressionBlock, type CompressionState, type CompressParseDiagnostics, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { countUnicodeEscapes, findUnverifiableUserQuote, sanitizeSummary } from "./summary-sanitize.js";
import { assertNotAborted } from "./abort.js";
import { PROXY_STAND_DOWN_MESSAGE } from "./proxy-detect.js";
import { buildSummarizeSystemPrompt, fitToModel, resolveModel, summarizeChecked, SESSION_MODEL_REF, type ContentPart } from "./compress-model.js";

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const RangeSpec = Type.Object({
  startId: Type.String({ description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".' }),
  endId: Type.String({ description: 'Inclusive end ref. Must be at or after startId.' }),
  summary: Type.String({ description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)." }),
  topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality." })),
});

const CompressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own. Omit when each content entry specifies its own topic." })),
  content: Type.Union([
    Type.Array(RangeSpec),
    // Non-strict-tool providers (vLLM openai-completions, supportsStrictTools:
    // false) sometimes stringify nested array arguments — session
    // 01a00a38 died on exactly this: pi's typebox validation rejected
    // "[{\"topic\":...}]" with "content.0: must be object" and the turn's
    // only compress attempt was lost. Accept the JSON-encoded form and parse
    // it in normalizeRanges below.
    Type.String({ description: "JSON-encoded array of ranges — accepted because non-strict-tool providers sometimes stringify array arguments; parsed automatically." }),
  ], { description: "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic." }),
  summaryMaxChars: Type.Optional(Type.Number({ description: "Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit." })),
});

type CompressArgs = Static<typeof CompressParams>;

/** Without a dedicated summary model the main model writes full summaries.
 *  With one, the main model still writes a short but meaningful fallback (kept
 *  verbatim if the dedicated call fails) — never a bare placeholder, which
 *  would become a permanent, useless block summary on failure. */
function compressDescription(ref: string | undefined): string {
  if (!ref) {
    return "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary.";
  }
  return (
    `Replace older conversation ranges. Dedicated summary model ${ref} normally replaces each summary. ` +
    "Choose the ranges and provide a concise but meaningful 1–2 sentence fallback summary for each range; never use a bare placeholder. " +
    "Preserve the goal, key decisions, exact paths/versions/errors, current state, and TODOs in that fallback. " +
    "Example: compress({ content: [{ startId, endId, summary: \"Concise fallback...\" }] })."
  );
}

export function makeCompressTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides, pi?: ExtensionAPI): ToolDefinition<typeof CompressParams> {
  const tool = applyToolPromptOverrides({
    name: "compress",
    label: "Compress",
    description:
      compressDescription(undefined),
    promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
    promptGuidelines: [
      "Each message has an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
      "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
      "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
      "Never compress content the current step is actively using.",
    ],
    parameters: CompressParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? PROXY_STAND_DOWN_MESSAGE }] };
      let result: string;
      const details: CompressResultDetails = {};
      try {
        const release = await runtime.acquireLock(ctx.sessionManager.getSessionId());
        try {
          result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId, signal, collectActiveTools(pi), details);
        } finally {
          release();
        }
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: typeof (params as CompressArgs).content === "string" ? "string" : ((params as CompressArgs).content?.length ?? 0) });
        throw e;
      }
      return { details: details.acpFolded ? details : undefined, content: [{ type: "text", text: result }] };
    },
  }, overrides);
  // Dynamic description: `/acp compact` can switch the summary model mid-
  // session, so the text is computed whenever the host reads it.
  const configuredDescription = overrides?.description;
  Object.defineProperty(tool, "description", {
    configurable: true,
    enumerable: true,
    get() {
      const ref = runtime.getCompressionModelRef();
      if (!ref) return configuredDescription ?? compressDescription(undefined);
      return `${configuredDescription ? `${configuredDescription} ` : ""}${compressDescription(ref)}`;
    },
  });
  return tool;
}

/** Active tools as pi-ai Tool[] — part of the `session` prefix so the
 *  summary request matches the main request and can reuse its prompt cache.
 *  Best-effort: hosts/mocks without these methods yield []. */
function collectActiveTools(pi?: ExtensionAPI): Tool[] {
  if (!pi) return [];
  try {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools()
      .filter((t: ToolInfo) => active.has(t.name))
      .map((t: ToolInfo) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  } catch {
    return [];
  }
}

type RangeEntry = Static<typeof RangeSpec>;

/** Persisted in the compress toolResult's `details` (never sent to the model).
 *  When a dedicated model writes summaries, the call's arguments hold only the
 *  caller's short fallback, and failed ranges are not folded at all — so the
 *  log alone cannot rebuild the blocks. `acpFolded` records exactly what was
 *  folded; state-rebuild prefers it over the arguments. */
export interface CompressResultDetails {
  acpFolded?: {
    version: 1;
    ranges: Array<{ startId: string; endId: string; summary: string; topic?: string }>;
  };
}

// Normalize the compress args via the kernel's lenient parser (fenced /
// trailing-comma / raw-newline / double-stringified / truncated-salvage).
// Returns an error string on bad input — handleCompress THROWS it so pi marks
// the toolResult isError:true, which is what makes the outcome count toward
// the failure cap (a returned string would land as isError:false and count
// as neutral). An empty array passes through (the call site returns "No
// ranges provided.").
export function normalizeRanges(args: CompressArgs): RangeEntry[] | string {
  const effective = repairContentTail(repairBareRangeObjects(args));
  const { ranges, diagnostics } = parseCompressArgs(effective);
  if (ranges.length === 0) {
    if (Array.isArray(effective.content) && effective.content.length === 0) return [];
    return describeDiagnostics(diagnostics, effective.content);
  }
  return ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, topic: r.topic }));
}

// Qwen-family models in non-strict tool-call mode sometimes emit the `content`
// array as a JSON-encoded string whose LAST entry object is missing its closing
// `}` (tail `"]` instead of `"}]`). The kernel's lenient parser then drops that
// last range — or every range, when it is the only one — and reports a
// misleading "truncated"/"no-valid-ranges" diagnostic. Repair the brace before
// delegating so the whole array parses. Args are returned unchanged when the
// repair does not apply.
function repairContentTail(args: CompressArgs): CompressArgs {
  if (typeof args.content !== "string") return args;
  const repaired = tailRepair(args.content);
  return repaired === undefined ? args : { ...args, content: repaired };
}

// Deterministic tail-repair: if the trimmed string ends with `"]` and the char
// before it is a closing `"`, retry the parse with `"}]` appended. A valid JSON
// array never still parses after appending `}`, so this has no false positives.
export function tailRepair(s: string): string | undefined {
  const t = s.trimEnd();
  if (!t.endsWith("]")) return undefined;
  const body = t.slice(0, -1).trimEnd();
  if (!body.endsWith('"')) return undefined;
  const candidate = body + "}]";
  try {
    if (Array.isArray(JSON.parse(candidate))) return candidate;
  } catch {
    // not the missing-brace case
  }
  return undefined;
}

// Small models in non-strict tool-call mode sometimes emit `content` as a
// string of bare range objects WITHOUT the wrapping array brackets — one
// object (`{"startId":...}`) or several concatenated (`{...}{...}`, missing
// the outer `[]` and/or the commas between entries). The kernel parser only
// salvages entries from a `[`-anchored array, so these payloads die with a
// misleading "must be an ARRAY" / "failed to parse" diagnostic that the model
// cannot act on (#480). Extract the top-level objects and re-wrap them as a
// proper array before delegating.
function repairBareRangeObjects(args: CompressArgs): CompressArgs {
  if (typeof args.content !== "string") return args;
  const repaired = arrayWrapRepair(args.content);
  return repaired === undefined ? args : { ...args, content: repaired };
}

// Deterministic re-wrap: collect the balanced `{...}` segments at depth 0
// (outside strings), keep those that validate as range specs, and return them
// as a JSON array string. Returns undefined when nothing range-shaped is
// found at top level, leaving accurate error reporting to the normal path.
export function arrayWrapRepair(s: string): string | undefined {
  const objects = extractTopLevelObjects(s)
    .map((candidate): unknown => {
      try {
        return JSON.parse(candidate);
      } catch {
        return undefined;
      }
    })
    .filter((o): o is Record<string, unknown> => isRangeLikeObject(o));
  if (objects.length === 0) return undefined;
  return JSON.stringify(objects);
}

// Balanced `{...}` segments at depth 0 (outside strings). Stray closers
// resync instead of aborting, so garbage between or before objects is skipped;
// `[`-anchored arrays never yield candidates (their `{` sit at depth ≥ 1).
function extractTopLevelObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0 && ch === "{" && start === -1) start = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth < 0) {
        depth = 0;
        start = -1;
        continue;
      }
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

// Same field aliases the kernel's validateEntry accepts — the repair must not
// reject shapes the parser would have accepted.
function isRangeLikeObject(o: unknown): o is Record<string, unknown> {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  const hasStart = typeof r.startId === "string" || typeof r.startRef === "string" || typeof r.messageId === "string";
  const hasEnd = typeof r.endId === "string" || typeof r.endRef === "string" || typeof r.messageId === "string";
  return hasStart && hasEnd && typeof r.summary === "string" && r.summary.length > 0;
}

function describeDiagnostics(diagnostics: CompressParseDiagnostics, content: CompressArgs["content"]): string {
  const shape = typeof content === "string"
    ? "a JSON-encoded string (non-strict-tool providers stringify array arguments)"
    : content === null ? "null" : `a ${typeof content}`;
  const base = `Invalid compress content (${diagnostics.kind}): got ${shape}`;
  if (diagnostics.kind === "truncated") {
    return `${base}; the input was truncated and no complete ranges could be recovered. Shorten the summary or split into smaller ranges.`;
  }
  if (diagnostics.invalidItems > 0) {
    return `${base}; ${diagnostics.invalidItems} entr${diagnostics.invalidItems === 1 ? "y was" : "ies were"} dropped as invalid. Each range must be an object with string fields startId, endId, summary.`;
  }
  const parseErr = jsonParseError(content);
  if (parseErr !== undefined) {
    return `${base}; the JSON failed to parse: ${parseErr}. Fix the malformed JSON (e.g. a missing closing brace or quote) and retry.`;
  }
  return `${base}. content must be an ARRAY of {startId, endId, summary} objects.`;
}

// Short diagnostic for why a JSON-shaped string fails to parse, or undefined
// when it parses fine or is not JSON-shaped. Gives the model a retryable signal
// (the parser's own position) instead of the misleading "must be an ARRAY".
function jsonParseError(content: CompressArgs["content"]): string | undefined {
  if (typeof content !== "string") return undefined;
  const t = content.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    JSON.parse(t);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Panel block count, or -1 for non-panels. Accepts BOTH the legacy
 *  "… B blocks)" form (0-block runs; historical transcripts replayed by
 *  index/floor-stale) and the #376 "… blocks: b3=m00044–m00097*, …" form. */
export function compressPanelBlocks(text: string): number {
  if (!text.trimStart().startsWith("▣ ACP |")) return -1;
  const m = text.match(/, (\d+) blocks?\)/);
  if (m) return Number(m[1]);
  // Count span-form entries by their label tokens (bN= / bN(Tn)=), NOT by
  // capturing to the next ")" — tier labels carry a ")" that would truncate a
  // naive capture and undercount any batch whose first new block is T2/T3.
  const idx = text.indexOf(", blocks: ");
  if (idx === -1) return -1;
  const header = text.slice(idx).split("\n", 1)[0] ?? "";
  return header.match(/\bb\d+(?:\(T\d+\))?=/g)?.length ?? 0;
}

/** Success = completed run that created >= 1 block (partial range errors
 *  still count: progress was made). A 0-block panel must NOT be success —
 *  it would reset the retry counter while the emergency nudge re-fires,
 *  looping no-op compressions (issue #6). */
export function isCompressSuccessText(text: string): boolean {
  return compressPanelBlocks(text) > 0;
}

/** No-op = completed run that compressed nothing (0-block panel: every
 *  range skipped). Counted as a FAILED attempt by noteCompressOutcomes so
 *  the retry cap applies. Non-panels ("No ranges provided.") stay neutral. */
export function isCompressNoopText(text: string): boolean {
  return compressPanelBlocks(text) === 0;
}

// Issue #250 loop breaker: small models repeat an identical compress call with
// refs that can NEVER resolve (stale/consumed/unknown) — the kernel rejects
// every time and the model just retries the same dead refs for minutes. A
// range is "dead" when the kernel's boundary resolver will reject it no matter
// what summary is written, so repeating the same dead range set is guaranteed
// to fail. After DEAD_REPEAT_REJECT identical failures we stop running the
// kernel and return a hard rejection that lists the LIVE compressible ranges
// (from the nudge decision already computed in this call), so the model gets
// usable refs without having to call acp_status.
const DEAD_REPEAT_REJECT = 2;

function paddedRef(n: number): string {
  return `m${String(n).padStart(5, "0")}`;
}

// issue #376: report each new block's ACTUAL coverage, not the requested
// startId/endId — kernel protection exclusions and turn-integrity rollback
// can shrink a range post-hoc, so inferring coverage from the request drifts
// the model's block ledger against nudge ranges. Span = first/last ref of
// effectiveMessageIds; `*` marks spans containing still-existing refs the
// block does not cover (excluded — see the ⚠️ warnings line); tier ≥ 2 marked.
export function blockSpanLabel(block: CompressionBlock, state: CompressionState): string {
  const nums: number[] = [];
  for (const id of block.effectiveMessageIds) {
    const ref = state.messageRefs.byRaw[id];
    if (!ref || !ref.startsWith("m")) continue;
    const n = Number(ref.slice(1));
    if (Number.isInteger(n) && n > 0) nums.push(n);
  }
  const tierMark = block.tier >= 2 ? `(T${block.tier})` : "";
  if (nums.length === 0) return `${block.blockId}${tierMark}`;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of nums) {
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  const present = new Set(nums);
  let star = "";
  for (let n = lo; n <= hi; n++) {
    if (!present.has(n) && state.messageRefs.byRef[paddedRef(n)] !== undefined) {
      star = "*";
      break;
    }
  }
  const span = lo === hi ? paddedRef(lo) : `${paddedRef(lo)}–${paddedRef(hi)}`;
  return `${block.blockId}${tierMark}=${span}${star}`;
}

// #535 P1: one-line integrity fingerprint per new/updated block — cheap
// head/tail excerpt + char length so the model can verify its summary was
// stored intact without decompressing.
export function summaryFingerprintLine(blockId: string, summary: string): string {
  const head = summary.slice(0, 30).replace(/\r?\n/g, " ");
  const tail = summary.slice(-100).replace(/\r?\n/g, " ");
  return ` · ${blockId} summary ${summary.length}ch · head "${head}" … tail "${tail}"`;
}

function blockHasVisibleAnchor(block: CompressionBlock, visibleIds: Set<string>): boolean {
  if (visibleIds.has(`acp_summary_${block.blockId}`)) return true;
  return block.effectiveMessageIds.some((id) => visibleIds.has(id));
}

function hasActiveOwner(state: CompressionState, ownedIds: string[], visibleIds: Set<string>): boolean {
  const owned = new Set(ownedIds);
  for (const block of state.blocks) {
    if (!block.active) continue;
    const inheritsOwned = block.directBlockIds.some((childId) => {
      const child = state.blocks.find((c) => c.blockId === childId);
      return child !== undefined && child.effectiveMessageIds.some((id) => owned.has(id));
    });
    if (inheritsOwned && blockHasVisibleAnchor(block, visibleIds)) return true;
  }
  return false;
}

function refIsDead(ref: string, state: CompressionState, visibleIds: Set<string>): boolean {
  const trimmed = ref.trim();
  if (/^b\d+$/i.test(trimmed)) {
    const block = state.blocks.find((b) => b.blockId.toLowerCase() === trimmed.toLowerCase());
    if (!block) return true;
    if (block.active && blockHasVisibleAnchor(block, visibleIds)) return false;
    return !hasActiveOwner(state, block.effectiveMessageIds, visibleIds);
  }
  const m = trimmed.match(/^m(\d+)$/i);
  if (!m) return true;
  const rawId = state.messageRefs.byRef[trimmed] ?? state.messageRefs.byRef[paddedRef(Number(m[1]))];
  if (!rawId) return true;
  if (visibleIds.has(rawId)) return false;
  return !hasActiveOwner(state, [rawId], visibleIds);
}

function compressibleSnapshotText(nudge: NudgeDecision | undefined): string {
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  if (ranges.length === 0) {
    return "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
  }
  return formatRanges(ranges, []);
}

function deadRepeatRejectionText(spans: string[], count: number, snapshot: string): string {
  return [
    "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)",
    `[ACP] REJECTED — this exact compress call has now failed ${count}× (ranges ${spans.join(", ")}). Those refs are stale: they point at content already compressed into an active block, or at refs that no longer exist. Repeating this call cannot succeed — do not retry it.`,
    "",
    "Current compressible ranges (use these refs exactly as listed):",
    snapshot,
    "",
    "If none of these fit, call acp_status for the full picture — or continue the task without compressing.",
  ].join("\n");
}

function cappedRejectionText(snapshot: string): string {
  return [
    "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)",
    `[ACP] PAUSED — ${MAX_COMPRESS_ATTEMPTS} compress attempts already failed this turn; further compress calls are rejected until the next user message.`,
    "",
    "Current compressible ranges (use these refs exactly as listed):",
    snapshot,
    "",
    "Continue the task; compress becomes available again on the next user message.",
  ].join("\n");
}

function tier3OnlyRewrite(newBlocks: CompressionBlock[], allBlocks: CompressionBlock[]): string[] | null {
  if (newBlocks.length === 0) return null;
  const byId = new Map(allBlocks.map((b) => [b.blockId, b]));
  const spans: string[] = [];
  for (const b of newBlocks) {
    const consumed = b.directBlockIds.map((id) => byId.get(id));
    if (
      b.tier !== 3 ||
      b.directMessageIds.length > 0 ||
      b.directBlockIds.length === 0 ||
      consumed.some((c) => !c || c.tier !== 3)
    ) {
      return null;
    }
    spans.push(`${b.startRef ?? "?"}..${b.endRef ?? "?"}`);
  }
  return spans;
}

// #344: the rewrite guard stops the loop but its recovery hint only covers
// message-type ranges. When the session's actionable mass is tier blocks, name
// them so repetition-prone models get a concrete next action instead of
// hunting (and re-hitting the guard).
export function tierReadyHint(state: CompressionState, config: ReturnType<AcpRuntime["configFor"]>): string {
  if (!config.tiers.enabled) return "";
  const active = state.blocks.filter((b) => b.active);
  const first = (bs: CompressionBlock[]) => bs[0]?.blockId ?? "";
  const last = (bs: CompressionBlock[]) => bs[bs.length - 1]?.blockId ?? "";
  const t2 = active.filter((b) => b.tier === 2);
  if (t2.length >= config.tiers.tier3Trigger) {
    return `Actionable now: condense tier-2 blocks ${first(t2)}..${last(t2)} into a single tier-3 block (compress({ content: [{ startId: "${first(t2)}", endId: "${last(t2)}", summary: "..." }] })).`;
  }
  const t1 = active.filter((b) => b.tier === 1);
  if (t1.length >= config.tiers.tier2Trigger) {
    return `Actionable now: distill tier-1 blocks ${first(t1)}..${last(t1)} into a single tier-2 block (compress({ content: [{ startId: "${first(t1)}", endId: "${last(t1)}", summary: "..." }] })).`;
  }
  return "";
}

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string, signal?: AbortSignal, tools: Tool[] = [], detailsOut?: CompressResultDetails): Promise<string> {
  assertNotAborted(signal);
  const maybeRanges = normalizeRanges(args);
  // Argument errors throw (not return): pi-agent-core only sets isError:true
  // on THROWN tool errors, and the failure counter keys off isError. A
  // returned string would land as isError:false — neutral, so it neither
  // counts toward the cap nor lifts it.
  if (typeof maybeRanges === "string") throw new Error(maybeRanges);
  const ranges = maybeRanges;
  if (ranges.length === 0) return "No ranges provided.";
  const { state: initialState, coreMessages, entries } = await runtime.stateFor(ctx);
  assertNotAborted(signal);
  const { config, imageTokens, fixedTokens, sentTokens } = measureTurnInputs(runtime, ctx, { state: initialState, coreMessages, entries });
  const modelId = ctx.model?.id ?? "default";
  // Preview uses the shared effective window and fixed overhead, but does not
  // consume send-only overflow arms, calibration samples or meter records.
  const firstTokenCount = adjustedTokenCount(runtime.core, coreMessages, initialState, config, sentTokens, imageTokens, fixedTokens);
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state: initialState,
    config,
    tokenCount: firstTokenCount,
  });
  const state = turn.state;
  const messages = turn.messages;
  const sid = ctx.sessionManager.getSessionId();
  // Issue #309: normalize at ingest — the kernel stores/renders summaries
  // verbatim, so double-escaped \uXXXX runs would persist into every future
  // prompt. Unverifiable user-quote claims are logged as evidence only.
  const sanitizedRanges = ranges.map((r) => {
    const span = `${r.startId}..${r.endId}`;
    const s = sanitizeSummary(r.summary);
    if (s.unescaped) {
      debug.event("compress", { sid, event: "summary-unescaped", span, escapes: countUnicodeEscapes(r.summary), beforeLen: r.summary.length, afterLen: s.text.length });
    }
    const unverifiedQuote = findUnverifiableUserQuote(s.text);
    if (unverifiedQuote !== null) {
      logWarn("compress", { sid, event: "summary-unverifiable-quote", span, claim: unverifiedQuote });
    }
    return s.text === r.summary ? r : { ...r, summary: s.text };
  });
  // Same key the context transform records compress outcomes under.
  const turnKey = lastTurnBoundaryId(entries) ?? sid;
  const snapshot = compressibleSnapshotText(turn.nudge);
  if (runtime.compressRetryCappedFor(sid, turnKey)) {
    logWarn("compress", { sid, event: "capped-reject", turnKey });
    return cappedRejectionText(snapshot);
  }
  const visibleIds = new Set(messages.map((m) => m.id));
  const deadSpans = ranges
    .filter((r) => refIsDead(r.startId, state, visibleIds) || refIsDead(r.endId, state, visibleIds))
    .map((r) => `${r.startId}..${r.endId}`);
  const allDead = deadSpans.length === ranges.length;
  // beforeTokens on the same CJK-aware scale as the kernel's countTokens, so
  // "X → Y (~Z reclaimed)" compares like-for-like.
  const beforeTokens = estimateTokens(messages, collectCoveredMessageIds(state), imageTokens);
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;
  // Dedicated summary model (#241 port): replace the caller's summaries before
  // the kernel sees them. Skipped for all-dead calls (nothing will fold).
  // Failures keep the caller's fallback summary; re-sanitize model output.
  const dedicated: DedicatedSummaryResult = allDead
    ? { ranges: sanitizedRanges, note: null, warn: false, failed: [] }
    : await writeDedicatedSummaries({ ranges: sanitizedRanges, runtime, ctx, messages, state, config, tools, summaryMaxChars, topLevelTopic, signal });
  assertNotAborted(signal);
  const failedIdx = new Set(dedicated.failed.map((f) => f.index));
  if (failedIdx.size > 0 && failedIdx.size === dedicated.ranges.length) {
    // Thrown, not returned: counts toward the per-turn retry cap, so a
    // persistently failing summary model cannot loop the main model.
    throw new Error(
      `Summary model ${dedicated.modelLabel ?? "?"} failed for every range (${dedicated.failed.map((f) => `${f.span}: ${f.error}`).join("; ")}). ` +
        "Nothing was compressed — folding with your short fallback would replace the detailed summary. " +
        "Retry later; if it keeps failing, the user can run /acp compact reset so the main model writes summaries.",
    );
  }
  const finalRanges = dedicated.ranges.filter((_, i) => !failedIdx.has(i)).map((r) => {
    const s = sanitizeSummary(r.summary);
    return s.text === r.summary ? r : { ...r, summary: s.text };
  });

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    modelId,
    ranges: ranges.length,
    spans: finalRanges.map((r) => ({ span: `${r.startId}..${r.endId}`, summaryLen: r.summary.length, summary: r.summary, topic: r.topic ?? topLevelTopic ?? null })),
    blocksBefore: state.blocks.length,
    activeBefore: state.blocks.filter((b) => b.active).length,
    beforeMsgCount: messages.length,
    beforeTokens,
  });
  // #540: select changed blocks by before/after runId diff — every
  // applyCompression assigns a fresh runId to both NEW and REFOLDED blocks,
  // while a refold keeps its original array position. A tail slice
  // (slice(-blocksCreated)) mislabels a non-tail refolded block (e.g. refold
  // of b1 in [b1,b2,b3] would present b3's stale summary as the new one).
  const beforeRunIds = new Map(state.blocks.map((b) => [b.blockId, b.runId]));
  const applied = runtime.core.applyCompression({
    ranges: finalRanges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId })),
    messages,
    state,
    config,
  });
  assertNotAborted(signal);
  const changedBlocks = applied.state.blocks.filter((b) => beforeRunIds.get(b.blockId) !== b.runId);
  const rewriteSpans = applied.result.blocksCreated > 0
    ? tier3OnlyRewrite(changedBlocks, applied.state.blocks)
    : null;
  if (rewriteSpans) {
    await runtime.save(state, ctx);
    logWarn("compress", {
      sid: ctx.sessionManager.getSessionId(),
      event: "tier3-rewrite-rejected",
      spans: rewriteSpans,
    });
    const hint = tierReadyHint(state, config);
    throw new Error(
      `Range ${rewriteSpans.join(", ")} only re-condenses terminal tier-3 block(s) — T3 is the highest tier, so rewriting it reclaims nothing and can repeat forever (dog/billion-context-pi#3). Nothing was compressed. ` +
        (hint ? `${hint} ` : "") +
        `Use search_context or decompress to retrieve details, or pick a range containing uncompressed messages (acp_status lists compressible ranges).`,
    );
  }
  await runtime.save(applied.state, ctx);
  const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;
  if (detailsOut && changedBlocks.length > 0 && dedicated.modelLabel !== undefined) {
    // One request can refold several blocks without changing their endpoints.
    // Record actual changed blocks, excluding failed/skipped ranges entirely.
    detailsOut.acpFolded = {
      version: 1,
      ranges: changedBlocks.map((block) => {
        // Refolds must replay with message refs: original block-boundary specs
        // would create a new parent instead. The kernel only refolds blocks
        // whose message span resolves; new blocks always retain their spec.
        const span = beforeRunIds.has(block.blockId)
          ? resolveBlockSpan(block, applied.state.messageRefs.byRaw)!
          : { startRef: block.startRef!, endRef: block.endRef! };
        return { startId: span.startRef, endId: span.endRef, summary: block.summary, ...(block.topic ? { topic: block.topic } : {}) };
      }),
    };
  }
  if (blocksCreated > 0) {
    runtime.clearDeadCompress(sid);
  } else if (allDead) {
    const count = runtime.noteDeadCompress(sid, ranges.map((r) => `${r.startId}..${r.endId}`).join("|"));
    if (count >= DEAD_REPEAT_REJECT) {
      logWarn("compress", { sid, event: "dead-range-reject", count, spans: deadSpans });
      return deadRepeatRejectionText(deadSpans, count, snapshot);
    }
  }

  // Re-measure the post-compression sent view on the SAME scale as beforeTokens
  // (post-processTurn view: visible text + every active block's summary anchor
  // + ref-tag overhead), so "X → Y (~Z reclaimed)" compares like-for-like —
  // including the new block's own summary, which the model will pay for next.
  // Post-compression count: feeding the stale pre-compression sentTokens would
  // mis-scale this pass's emergency-truncate band (threshold 0.95) and skew
  // afterTokens (issue #289).
  const postSentTokens = adjustedTokenCount(runtime.core, coreMessages, applied.state, config, estimateTokens(coreMessages, collectCoveredMessageIds(applied.state), imageTokens) + fixedTokens, imageTokens, fixedTokens);
  const afterTurn = runtime.core.processTurn({
    messages: coreMessages,
    state: applied.state,
    config,
    tokenCount: postSentTokens,
  });
  const afterTokens = estimateTokens(afterTurn.messages, collectCoveredMessageIds(applied.state), imageTokens);
  const reclaimed = Math.max(0, beforeTokens - afterTokens);

  const newBlocks = changedBlocks;
  debug.event("compress-out", {
    sid: ctx.sessionManager.getSessionId(),
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    afterMsgCount: applied.state.blocks.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 3),
    blocksAfter: applied.state.blocks.length,
    activeAfter: applied.state.blocks.filter((b) => b.active).length,
    newBlocks: newBlocks.map((b) => ({ blockId: b.blockId, tier: b.tier, summaryLen: b.summary.length, directMsgCount: b.directMessageIds.length, effectiveMsgCount: b.effectiveMessageIds.length, summary: b.summary })),
  });

  logInfo("compress", {
    sid: ctx.sessionManager.getSessionId(),
    event: "applied",
    ranges: ranges.length,
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    warnings: warnings.length,
    errors: errors.length,
    newBlockIds: newBlocks.map((b) => b.blockId),
  });
  if (errors.length > 0) {
    logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "errors", count: errors.length, errors: errors.slice(0, 5) });
  }
  if (warnings.length > 0) {
    logWarn("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
  }

  const spanClause = blocksCreated > 0
    ? `blocks: ${newBlocks.map((b) => blockSpanLabel(b, applied.state)).join(", ")}`
    : "0 blocks";
  const lines = [`▣ ACP | ${formatK(beforeTokens)} → ${formatK(afterTokens)} tokens (~${formatK(reclaimed)} reclaimed, ${spanClause})`];
  if (blocksCreated > 0) {
    for (const b of newBlocks) lines.push(summaryFingerprintLine(b.blockId, b.summary));
  }
  if (dedicated.note) lines.push(`${dedicated.warn ? "⚠️" : "ℹ️"} ${dedicated.note}`);
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  // #420: carry the post-compression snapshot so a same-turn follow-up
  // compress has its refs without a planning acp_status call. Computed from
  // afterTurn (processTurn over the applied state), so the list reflects
  // what actually remains — not the pre-fold view.
  // The list is optional: every further fold re-sends everything after its
  // earliest range uncached, so a small remainder costs more prompt cache
  // than it saves (a real session spent ~96K uncached tokens to reclaim 473).
  if (blocksCreated > 0) {
    const afterSnapshot = compressibleSnapshotText(afterTurn.nudge);
    if (!afterSnapshot.startsWith("No compressible")) {
      lines.push(remainingRangesHeader(afterTurn.nudge, config) + "\n" + afterSnapshot);
    }
  }
  return lines.join("\n");
}

/** Header for the post-fold range list. Below the model's minimum benefit
 *  (the same bar that silences nudges and idle compact) it says to stop. */
export function remainingRangesHeader(nudge: NudgeDecision | undefined, config: { modelContextLimit: number; nudge: { minPressureBenefitTokens?: number } }): string {
  const remaining = viableRanges(nudge?.compressibleRanges ?? []).reduce((sum, r) => sum + r.tokens, 0);
  const minBenefit = config.nudge.minPressureBenefitTokens ?? Math.max(5000, Math.round(config.modelContextLimit * 0.01));
  if (remaining < minBenefit) {
    return `Remaining compressible content is small (~${formatK(remaining)} tokens, below the ${formatK(minBenefit)} minimum benefit): another compress call would re-send the history after its range uncached and cost more prompt cache than it saves. Stop compressing unless the user explicitly asks to fold these too; a general request to compress as much as possible is already met. Ranges, for reference only:`;
  }
  return "Remaining compressible ranges (optional; each further compress call re-sends the history after its earliest range uncached, so fold them only if worth it, all in one call; use these refs exactly as listed):";
}

interface DedicatedSummaryInput {
  ranges: RangeEntry[];
  runtime: AcpRuntime;
  ctx: ExtensionContext;
  messages: CoreMessage[];
  state: CompressionState;
  tools: Tool[];
  summaryMaxChars?: number;
  topLevelTopic?: string;
  config: ReturnType<AcpRuntime["configFor"]>;
  signal?: AbortSignal;
}

interface DedicatedSummaryResult {
  ranges: RangeEntry[];
  note: string | null;
  warn: boolean;
  /** Ranges whose summary call failed. They are NOT folded: a short caller
   *  fallback would otherwise replace the detailed summary (or, on a refold,
   *  the earlier blocks' summaries) the dedicated model was meant to write. */
  failed: Array<{ index: number; span: string; error: string }>;
  modelLabel?: string;
}

/** Write each range's summary with the configured dedicated model
 *  (`compressionModelId`). `session` = the active model with the captured
 *  provider-bound prefix (prompt-cache reuse); otherwise a registry model gets
 *  the extracted range transcript. Any per-range failure keeps the caller's
 *  fallback summary, so compression never blocks on the side call. */
async function writeDedicatedSummaries(input: DedicatedSummaryInput): Promise<DedicatedSummaryResult> {
  const ref = input.runtime.getCompressionModelRef();
  const ranges = input.ranges.map((range) => ({ ...range }));
  if (!ref) return { ranges, note: null, warn: false, failed: [] };
  const sid = input.ctx.sessionManager.getSessionId();
  const maxTokens = Math.max(256, Math.ceil((input.summaryMaxChars ?? 20000) / 3));
  const isSession = ref === SESSION_MODEL_REF;

  let model: Model<Api> | undefined;
  if (isSession) {
    model = input.ctx.model as Model<Api> | undefined;
    if (!model) return { ranges, note: "session summary model unavailable; kept caller-provided fallback summaries", warn: true, failed: [] };
  } else {
    let resolved: ReturnType<typeof resolveModel> | undefined;
    try {
      resolved = resolveModel(input.ctx.modelRegistry, ref);
    } catch (e) {
      logWarn("compress", { sid, event: "compression-model-unresolved", ref, error: e instanceof Error ? e.message : String(e) });
    }
    if (!resolved?.model) {
      if (resolved) logWarn("compress", { sid, event: "compression-model-unresolved", ref, ambiguous: resolved.ambiguous.length });
      return { ranges, note: `summary model ${ref} is not resolvable; kept caller-provided fallback summaries`, warn: true, failed: [] };
    }
    model = resolved.model;
  }
  // Setup failures (above, and a host without nested completion) are
  // configuration problems, not per-call ones: keep folding with the caller's
  // fallback and warn, rather than stop compressing altogether.
  if (typeof (input.ctx.modelRegistry as unknown as { complete?: unknown }).complete !== "function") {
    return { ranges, note: "host model registry has no complete() (needs pi >= 1.x); kept caller-provided fallback summaries", warn: true, failed: [] };
  }

  let prefix: Message[] | null = null;
  if (isSession) {
    const captured = input.runtime.getLastSentMessages(sid);
    if (captured) {
      try { prefix = convertToLlm(captured); } catch { prefix = null; }
    }
  }
  const sessionSystemPrompt = isSession ? (input.ctx.getSystemPrompt?.() ?? "") : "";

  // Extracted-content path (registry model, and session mode when no prefix
  // was captured — it always shared this path): summarize exactly what the kernel will fold. A dry run of
  // applyCompression (it clones state) yields each range's block after pair
  // expansion, protected-zone exclusion and integrity withdrawals — a bare
  // ref slice would hand the model a tool result without the call that says
  // what it is, while the kernel still folds that call.
  const planned = prefix ? new Map<number, CompressionBlock>() : plannedFolds(input, ranges);
  let used = 0;
  const failed: DedicatedSummaryResult["failed"] = [];
  for (const [index, range] of ranges.entries()) {
    if (input.signal?.aborted) break;
    const topic = range.topic ?? input.topLevelTopic;
    try {
      let context: Context;
      if (prefix) {
        context = { systemPrompt: sessionSystemPrompt, messages: [...prefix, { role: "user", content: buildRangeInstruction(range, topic), timestamp: Date.now() }], tools: input.tools };
      } else {
        const block = planned.get(index);
        const extracted = block ? foldedContent(input.messages, input.state, block) : extractRangeContent(input.messages, input.state, range.startId, range.endId);
        if (!extracted) continue;
        const instruction = buildRangeInstruction(range, topic, range.summary);
        context = {
          systemPrompt: buildSummarizeSystemPrompt(input.runtime.prompts, topic),
          messages: [{ role: "user", content: `${instruction}\n\n<content>\n${fitToModel(extracted, model, maxTokens)}\n</content>`, timestamp: Date.now() }],
        };
      }
      const span = `${range.startId}..${range.endId}`;
      range.summary = await summarizeChecked(input.ctx, model, context, maxTokens, input.signal, (text, kind) =>
        logWarn("compress", { sid, event: kind === "planning" ? "summary-planning-leak" : "summary-transcript-echo", ref, span, text, action: "retry" }));
      used += 1;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logWarn("compress", { sid, event: "compression-model-failed", ref, span: `${range.startId}..${range.endId}`, error });
      failed.push({ index, span: `${range.startId}..${range.endId}`, error });
    }
  }

  const label = `${model.provider}/${model.id}`;
  const fallbackKept = ranges.length - used - failed.length;
  const mode = isSession ? (prefix ? ", shared prefix" : ", extracted content") : "";
  const parts: string[] = [];
  if (used > 0) parts.push(`summaries written by ${isSession ? "session model " : ""}${label} (${used}/${ranges.length}${mode})`);
  if (failed.length > 0) {
    parts.push(`NOT compressed — summary model ${label} failed for ${failed.map((f) => `${f.span} (${f.error})`).join(", ")}; retry ${failed.length === 1 ? "that range" : "those ranges"} later`);
  }
  if (fallbackKept > 0) parts.push(`caller fallbacks kept for ${fallbackKept} range(s) with no extractable content`);
  return {
    ranges,
    note: parts.length > 0 ? parts.join("; ") : null,
    warn: failed.length > 0 || fallbackKept > 0,
    failed,
    modelLabel: label,
  };
}

function buildRangeInstruction(range: RangeEntry, topic: string | undefined, callerNote?: string): string {
  return (
    `Write the single detailed summary replacing ${range.startId} through ${range.endId}.` +
    (topic ? ` Topic: ${topic}.` : "") +
    " Follow the compression rules in the system prompt. Output only the summary text." +
    (callerNote?.trim() ? `\n\n<caller_note>\n${callerNote.trim()}\n</caller_note>` : "")
  );
}

/** Dry-run the kernel fold for every range at once (same messages, state and
 *  config as the real apply, so the same protected zone and pairing) and map
 *  each range to the NEW block it would create. Refolds and failed ranges map
 *  to nothing; their callers fall back to the ref-slice extraction. */
function plannedFolds(input: DedicatedSummaryInput, ranges: RangeEntry[]): Map<number, CompressionBlock> {
  const planned = new Map<number, CompressionBlock>();
  try {
    const existing = new Set(input.state.blocks.map((b) => b.blockId));
    const dry = input.runtime.core.applyCompression({
      // Placeholder summary of exactly the minimum length: the fold must not
      // depend on the caller's fallback length (the real apply uses the
      // dedicated model's summary, which a short fallback would not predict).
      ranges: ranges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: "p".repeat(Math.max(1, input.config.compress.minSummaryLength)), topic: r.topic ?? input.topLevelTopic })),
      messages: input.messages,
      state: input.state,
      config: input.config,
    });
    const created = dry.state.blocks.filter((b) => !existing.has(b.blockId));
    ranges.forEach((r, i) => {
      const block = created.find((b) => b.startRef === r.startId && b.endRef === r.endId);
      if (block) planned.set(i, block);
    });
  } catch {
    // Planning is advisory: the real apply reports its own errors.
  }
  return planned;
}

/** Transcript of exactly what `block` folds, in message order: its direct
 *  messages raw, each consumed block once as a pinned earlier summary. */
function foldedContent(messages: CoreMessage[], state: CompressionState, block: CompressionBlock): ContentPart[] | null {
  const direct = new Set(block.directMessageIds);
  const owner = new Map<string, CompressionBlock>();
  for (const id of block.directBlockIds) {
    const consumed = state.blocks.find((b) => b.blockId === id);
    if (!consumed) continue;
    for (const mid of consumed.effectiveMessageIds) owner.set(mid, consumed);
    owner.set(`acp_summary_${consumed.blockId}`, consumed);
  }
  const emitted = new Set<string>();
  const parts: ContentPart[] = [];
  const pin = (b: CompressionBlock) => {
    if (emitted.has(b.blockId)) return;
    emitted.add(b.blockId);
    parts.push({ text: `[earlier summary ${b.blockId}${b.topic ? ` \u2014 ${b.topic}` : ""}]\n${b.summary}`, pinned: true });
  };
  for (const message of messages) {
    if (direct.has(message.id)) parts.push({ text: formatCoreMessage(message) });
    else {
      const consumed = owner.get(message.id);
      if (consumed) pin(consumed);
    }
  }
  for (const b of new Set(owner.values())) pin(b);
  return parts.length ? parts : null;
}

function formatCoreMessage(message: CoreMessage): string {
  const text = message.text ?? "";
  if (message.contentType === "tool-call") return `[${message.role}:${message.toolName ?? "tool"} call] ${text}`;
  if (message.contentType === "tool-result") return `[${message.role}:${message.toolName ?? "tool"} result] ${text}`;
  return `[${message.role}] ${text}`;
}

/** Transcript of [startId, endId] as the main model sees it; null when the
 *  range cannot resolve. Messages already folded into an active block (and
 *  the kernel's `acp_summary_<blockId>` message standing in for them) are
 *  rendered as that block's summary once, as a pinned part — re-folding a
 *  range over existing blocks (m00195..m01254 over b19+b20) would otherwise
 *  ship 1M+ raw chars, or leave earlier summaries exposed to head/tail
 *  truncation. */
function extractRangeContent(messages: CoreMessage[], state: CompressionState, startId: string, endId: string): ContentPart[] | null {
  try {
    const range = resolveBoundaries({ startRef: startId, endRef: endId, messages, state });
    const slice = messages.slice(range.startIndex, range.endIndex + 1);
    const owner = new Map<string, CompressionBlock>();
    for (const block of state.blocks) {
      if (!block.active) continue;
      for (const id of block.effectiveMessageIds) owner.set(id, block);
      // `messages` is the kernel's pruned output: a folded block appears as
      // its synthetic summary message, not as the messages it covers.
      owner.set(`acp_summary_${block.blockId}`, block);
    }
    const emitted = new Set<string>();
    const parts: ContentPart[] = [];
    for (const message of slice) {
      const block = owner.get(message.id);
      if (!block) {
        parts.push({ text: formatCoreMessage(message) });
        continue;
      }
      if (emitted.has(block.blockId)) continue;
      emitted.add(block.blockId);
      parts.push({ text: `[earlier summary ${block.blockId}${block.topic ? ` \u2014 ${block.topic}` : ""}]\n${block.summary}`, pinned: true });
    }
    return parts.length ? parts : null;
  } catch {
    return null;
  }
}

type AgentMessage = SessionMessageEntry["message"];
const RANGE_KEYS = ["startId", "endId", "startRef", "endRef", "messageId", "summary"];

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
export function inlineBlockSummaries(
  messages: AgentMessage[],
  blocks: readonly CompressionBlock[],
): AgentMessage[] {
  const byCall = new Map<string, CompressionBlock[]>();
  for (const block of blocks) {
    if (!block.active || !block.compressCallId) continue;
    const list = byCall.get(block.compressCallId) ?? [];
    list.push(block);
    byCall.set(block.compressCallId, list);
  }
  if (byCall.size === 0) return messages;

  let changedAny = false;
  const out = messages.map((message) => {
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) return message;
    let changed = false;
    const content = m.content.map((part) => {
      const call = part as { type?: string; id?: string; name?: string; arguments?: unknown };
      if (call.type !== "toolCall" || call.name !== "compress" || !call.id) return part;
      const owned = byCall.get(call.id);
      if (!owned) return part;
      const args = withBlockSummaries(call.arguments, owned);
      if (args === null) return part;
      changed = true;
      return { ...call, arguments: args };
    });
    if (!changed) return message;
    changedAny = true;
    return { ...(message as object), content } as AgentMessage;
  });
  return changedAny ? out : messages;
}

function withBlockSummaries(args: unknown, owned: CompressionBlock[]): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const ranges = normalizeRanges(args as CompressArgs);
  if (typeof ranges === "string" || ranges.length === 0) return null;

  const sole = ranges.length === 1 && owned.length === 1 ? owned[0] : undefined;
  const entries: RangeEntry[] = [];
  for (const r of ranges) {
    const block = owned.find((b) => b.startRef === r.startId && b.endRef === r.endId) ?? sole;
    if (block) entries.push({ ...r, summary: block.summary });
  }
  if (entries.length === 0) return null;

  const obj = args as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key !== "content" && !RANGE_KEYS.includes(key)) next[key] = value;
  }
  next.content = typeof obj.content === "string" ? JSON.stringify(entries) : entries;
  return safeJson(next) === safeJson(obj) ? null : next;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
