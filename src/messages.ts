import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { defaultCountTokens, truncateLargeToolOutputs, type Config, type CoreMessage } from "acp-kernel";
import { rewriteTagTokens } from "./tag-tokens.js";
import type { TurnBoundaryEntry } from "./turn-boundary.js";

type AgentMessage = SessionMessageEntry["message"];

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  output?: unknown;
  summary?: string;
};

// Refs are zero-padded to 5 digits below 100,000 and widen naturally above
// (acp-kernel >= 0.0.101, up to m9999999).
const REF_TAG_SOURCE = "(?:\x3cacp\\s[^>]*\x3em\\d{5,7}\x3c/acp\x3e|\\[m\\d{1,7}\\])";
const REF_TAG = new RegExp(`^${REF_TAG_SOURCE}\\s?\\n?`);
const TRAILING_REF_TAG = new RegExp(`\\n*${REF_TAG_SOURCE}\\s*$`);

/** Host-injected status-panel custom messages (written by src/commands.ts) —
 *  UI-only, never projected into LLM context, so never user-like entries. */
export const ACP_STATUS_CUSTOM_TYPE = "acp-status";

/** /acp-export handoff docs (src/export.ts) — UI-only transcript output,
 *  persistent in the session but never projected into LLM context (#255). */
export const ACP_EXPORT_CUSTOM_TYPE = "acp-export";

/** /acp-rule outputs (src/commands.ts) — UI-only transcript output, same
 *  exclusion as acp-status/acp-export (#526): the rules themselves already
 *  reach the model through the feature's own channel, so the human-facing
 *  report must never be re-billed as model context. */
export const ACP_RULE_CUSTOM_TYPE = "acp-rule";

/** Nudge persistence record (issue #326): written via pi.appendEntry as a
 *  type:"custom" entry — never projected into the sent view (see above), so
 *  the compact one-liner stays out of model context while surviving restarts. */
export const ACP_NUDGE_CUSTOM_TYPE = "acp-nudge";
export interface AcpNudgeRecord {
  text: string;
}

/** Custom-message types excluded from LLM-context projection (#255, #380):
 *  UI-only panels/docs that persist in the session but must not reach the model. */
const CONTEXT_EXCLUDED_CUSTOM_TYPES = new Set<string>([ACP_STATUS_CUSTOM_TYPE, ACP_EXPORT_CUSTOM_TYPE, ACP_RULE_CUSTOM_TYPE]);

/** True for host-injected custom_message entries that participate in LLM
 *  context: non-empty custom_message except the UI-only types in
 *  CONTEXT_EXCLUDED_CUSTOM_TYPES (acp-status panels, acp-export docs,
 *  acp-rule reports)
 *  (Pi-native projection semantics, session-manager.d.ts). The non-empty gate
 *  uses the exact same extractText check as the projection below, so an entry
 *  either enters context or it doesn't. */
export function isCustomMessageEntry(entry: TurnBoundaryEntry): entry is TurnBoundaryEntry & { type: "custom_message" } {
  if (entry.type !== "custom_message") return false;
  if (entry.customType !== undefined && CONTEXT_EXCLUDED_CUSTOM_TYPES.has(entry.customType)) return false;
  return extractText(entry.content).length > 0;
}

export function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      // custom_message participates in LLM context per Pi native semantics
      // (session-manager.d.ts) — project it as a user message.
      if (isCustomMessageEntry(entry)) {
        const text = extractText(entry.content);
        if (text.length > 0) {
          out.push({ id: entry.id, role: "user", contentType: "text", text });
        }
      }
      continue;
    }
    const cores = projectMessage(entry.message, entry.id);
    out.push(...cores);
  }
  return withFacadeResultNames(out);
}

/** Lean facade tool wrapping decompress/search_context/acp_status/acp_cache. */
const FACADE_TOOL = "acp_context";

/** The kernel keys recency policies (neverPreserveRecentTools, protected tool
 *  lists) on tool names; project acp_context calls under the operation they
 *  wrap so those policies keep working behind the Lean facade. Only the
 *  projection changes — outgoing messages keep the real tool name. */
function policyToolName(name: string, args: unknown): string {
  if (name !== FACADE_TOOL) return name;
  const op = (args as { op?: unknown } | null | undefined)?.op;
  return typeof op === "string" && op.length > 0 && op !== "help" ? op : name;
}

/** Give facade tool results the operation name of their call (see
 *  policyToolName). Returns `cores` itself when nothing changes. */
function withFacadeResultNames(cores: CoreMessage[]): CoreMessage[] {
  let callNames: Map<string, string> | undefined;
  let out = cores;
  for (let i = 0; i < cores.length; i++) {
    const c = cores[i]!;
    if (c.contentType !== "tool-result" || c.toolName !== FACADE_TOOL || !c.toolCallId) continue;
    callNames ??= new Map(
      cores.flatMap((m) => (m.contentType === "tool-call" && m.toolCallId && m.toolName ? [[m.toolCallId, m.toolName] as const] : [])),
    );
    const name = callNames.get(c.toolCallId);
    if (!name || name === FACADE_TOOL) continue;
    if (out === cores) out = cores.slice();
    out[i] = { ...c, toolName: name };
  }
  return out;
}

/** Pi `context_edit` entry (session-manager.d.ts ContextEditEntry, Pi >= 1.x;
 *  declared locally because the pinned dev types predate it). */
interface ContextEditLike {
  type: "context_edit";
  targetId: string;
  replacement: { content: unknown } | null;
}

function isContextEdit(entry: SessionEntry): boolean {
  return (entry as { type: string }).type === "context_edit";
}

/** Apply Pi `context_edit` entries the way Pi's own buildSessionProjection does
 *  (projectContextEntry): `replacement: null` omits the target from model
 *  context, otherwise only its content is replaced (assistant/toolResult string
 *  content becomes one text part). `buildContextEntries()` returns the raw path,
 *  so without this the rebuild re-sends attempts Pi omitted (auto-retry's
 *  _omitRecoveryAttempt) and ignores content replacements. The edit entries
 *  themselves stay in the array (they project to nothing) so callers can see
 *  where an edit happened. Returns `entries` itself when there is no edit. */
export function applyContextEdits(entries: SessionEntry[]): SessionEntry[] {
  let edits: Map<string, ContextEditLike> | undefined;
  for (const entry of entries) {
    if (isContextEdit(entry)) {
      const edit = entry as unknown as ContextEditLike;
      (edits ??= new Map()).set(edit.targetId, edit);
    }
  }
  if (!edits) return entries;
  const out: SessionEntry[] = [];
  for (const entry of entries) {
    const edit = edits.get(entry.id);
    if (!edit) out.push(entry);
    else if (edit.replacement !== null) out.push(replaceEntryContent(entry, edit.replacement.content));
  }
  return out;
}

function replaceEntryContent(entry: SessionEntry, content: unknown): SessionEntry {
  if (entry.type === "message") {
    const role = (entry.message as { role?: string }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") return entry;
    const next = (role === "assistant" || role === "toolResult") && typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    return { ...entry, message: { ...entry.message, content: next } } as SessionEntry;
  }
  if (entry.type === "custom_message") return { ...entry, content } as SessionEntry;
  return entry;
}

// Conservative cap on how many entries an incremental projection may append in
// one turn: a healthy host appends a handful per turn, and anything larger means
// the structural assumption misfired — fall back to a full projection instead of
// extending a possibly-wrong cache (same posture as live-only-tail's tail cap).
const MAX_INCREMENTAL_ENTRIES = 64;

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
export class EntryProjectionCache {
  private count = 0;
  private firstId: string | null = null;
  private lastId: string | null = null;
  private cores: CoreMessage[] = [];

  /** Project `entries`, reusing the previous turn's work when the array is a
   *  structural extension of the last one seen. Returns a defensive copy: the
   *  internal array is shared across turns, and callers hand it to kernel code
   * that must never observe (or mutate) cross-turn state. */
  project(entries: SessionEntry[]): CoreMessage[] {
    if (
      this.count > 0 &&
      entries.length >= this.count &&
      entries.length - this.count <= MAX_INCREMENTAL_ENTRIES &&
      this.firstId !== null &&
      this.lastId !== null &&
      entries[0]?.id === this.firstId &&
      entries[this.count - 1]?.id === this.lastId &&
      !entries.slice(this.count).some(isContextEdit)
    ) {
      for (let i = this.count; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.type === "message") {
          this.cores.push(...projectMessage(entry.message, entry.id));
        } else if (isCustomMessageEntry(entry)) {
          const text = extractText(entry.content);
          if (text.length > 0) this.cores.push({ id: entry.id, role: "user", contentType: "text", text });
        }
      }
      this.count = entries.length;
      this.lastId = entries[entries.length - 1]!.id;
      return withFacadeResultNames(this.cores.slice());
    }
    this.cores = entriesToCoreMessages(entries);
    this.count = entries.length;
    this.firstId = entries[0]?.id ?? null;
    this.lastId = entries[entries.length - 1]?.id ?? null;
    return this.cores.slice();
  }

  /** Drop the cache (state rebuilt, session switched). */
  reset(): void {
    this.count = 0;
    this.firstId = null;
    this.lastId = null;
    this.cores = [];
  }
}

function projectMessage(message: AgentMessage, id: string): CoreMessage[] {
  const msg = message as AnyMessage;
  const role = msg.role;
  if (role === "user") {
    return [{ id, role: "user", contentType: "text", text: extractText(msg.content) }];
  }
  if (role === "toolResult") {
    return [{
      id,
      role: "tool",
      contentType: "tool-result",
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      text: extractText(msg.content),
    }];
  }
  if (role === "assistant") {
    // Thinking rides in every request but never into the text projection — meter
    // it via CoreMessage.thinkingTokens (issue #353). Kernel contract: attach to
    // exactly one core per turn — the first emitted one.
    const thinking = thinkingTokenCount(msg.content);
    const thinkingField = thinking > 0 ? { thinkingTokens: thinking } : {};
    const calls = allToolCalls(msg.content);
    if (calls.length > 0) {
      const textParts = extractText(msg.content);
      if (calls.length === 1) {
        const call = calls[0]!;
        const argStr = stringifyArgs(call.arguments);
        const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return [{ id, role: "assistant", contentType: "tool-call", toolName: policyToolName(call.name, call.arguments), toolCallId: call.id, text, ...thinkingField }];
      }
      return calls.map((call, i) => {
        const argStr = stringifyArgs(call.arguments);
        return {
          id: `${id}#${call.id}`,
          role: "assistant" as const,
          contentType: "tool-call" as const,
          toolName: policyToolName(call.name, call.arguments),
          toolCallId: call.id,
          text: argStr || textParts,
          ...(i === 0 ? thinkingField : {}),
        };
      });
    }
    const text = extractText(msg.content);
    // Drop thinking-only turns: empty assistant text makes OpenAI-compatible
    // providers (e.g. GLM) return 400 (no body), which Pi misreads as overflow.
    if (!text.trim()) return [];
    return [{ id, role: "assistant", contentType: "text", text, ...thinkingField }];
  }
  const customText = extractText(msg.content) || fallbackText(msg);
  return customText.length > 0
    ? [{ id, role: "user", contentType: "text", text: customText }]
    : [];
}

function fallbackText(msg: AnyMessage): string {
  const parts: string[] = [];
  if (msg.command) parts.push(`$ ${msg.command}`);
  const out = extractText(msg.output);
  if (out) parts.push(out);
  if (msg.summary) parts.push(msg.summary);
  return parts.join("\n").trim();
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  return safeStringify(args);
}


export function extractText(content: unknown): string {
  if (typeof content === "string") return stripRefTag(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(stripRefTag(b.text));
  }
  return parts.join("\n");
}

// Thinking blocks are invisible to extractText but resent with every request —
// measure their volume so kernel counting sees the full payload (issue #353).
export function thinkingTokenCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; thinking?: string };
    if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
  }
  return parts.length > 0 ? defaultCountTokens(parts.join("\n")) : 0;
}

function stripRefTag(text: string): string {
  return text.replace(REF_TAG, "").replace(TRAILING_REF_TAG, "");
}

export function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    const b = block as { type?: string };
    if (b?.type === "image") n++;
  }
  return n;
}
export const TRUNCATION_MARKER = "[truncated for context space]";

function allToolCalls(content: unknown): { name: string; id: string; arguments?: unknown }[] {
  if (!Array.isArray(content)) return [];
  const calls: { name: string; id: string; arguments?: unknown }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "toolCall" && b.name) calls.push({ name: b.name, id: b.id ?? "", arguments: b.arguments });
  }
  return calls;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function coreOutToAgentMessages(
  coreOut: CoreMessage[],
  originalById: Map<string, AgentMessage>,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const emittedSplit = new Set<string>();
  const kernelTextByCallId = new Map<string, string>();
  for (const core of coreOut) {
    if (core.contentType === "tool-call" && core.toolCallId && core.text) {
      kernelTextByCallId.set(core.toolCallId, core.text);
    }
  }

  for (const core of coreOut) {
    if (core.id.startsWith("acp_summary_")) continue;

    const hashIdx = core.id.indexOf("#");
    if (hashIdx < 0) {
      const original = originalById.get(core.id);
      if (original) out.push(patchRefTag(original, core));
      continue;
    }

    const baseId = core.id.substring(0, hashIdx);
    if (emittedSplit.has(baseId)) continue;
    emittedSplit.add(baseId);

    const original = originalById.get(baseId);
    if (!original) continue;

    const survivingCallIds = new Set(
      coreOut
        .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
        .map((c) => c.toolCallId)
        .filter((id): id is string => !!id),
    );

    out.push(reconstructToolCallMessage(original, core, survivingCallIds, kernelTextByCallId));
  }

  return out;
}

function compactedArgsFrom(kernelText: string | undefined, originalArgs: unknown): unknown | null {
  if (!kernelText) return null;
  const start = kernelText.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(kernelText.slice(start));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (safeStringify(parsed) === safeStringify(originalArgs)) return null;
  return parsed;
}

function syncToolCallArgs(
  blocks: unknown[],
  kernelTextFor: (callId: string) => string | undefined,
): unknown[] {
  let changed = false;
  const out = blocks.map((block) => {
    const b = block as { type?: string; id?: string; arguments?: unknown };
    if (b.type !== "toolCall" || !b.id) return block;
    const compacted = compactedArgsFrom(kernelTextFor(b.id), b.arguments);
    if (compacted === null) return block;
    changed = true;
    return { ...b, arguments: compacted };
  });
  return changed ? out : blocks;
}

function reconstructToolCallMessage(
  original: AgentMessage,
  firstCore: CoreMessage,
  survivingCallIds: Set<string>,
  kernelTextByCallId: Map<string, string>,
): AgentMessage {
  const base = original as AnyMessage;
  const match = firstCore.text ? firstCore.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;

  if (base.role === "assistant" || !tag) {
    const rawBlocks2: unknown[] = Array.isArray(base.content)
      ? base.content
      : typeof base.content === "string"
        ? [{ type: "text", text: base.content }]
        : [];
    const filtered2 = rawBlocks2.filter((block) => {
      const b = block as { type?: string; id?: string };
      if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
      return true;
    });
    const peeled2 = syncToolCallArgs(
      peelRefTagBlocks(filtered2),
      (callId) => kernelTextByCallId.get(callId),
    );
    return { ...(original as object), content: peeled2 } as AgentMessage;
  }

  const rawBlocks: unknown[] = Array.isArray(base.content)
    ? base.content
    : typeof base.content === "string"
      ? [{ type: "text", text: base.content }]
      : [];

  const filtered = rawBlocks.filter((block) => {
    const b = block as { type?: string; id?: string };
    if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
    return true;
  });

  const peeled = syncToolCallArgs(
    peelRefTagBlocks(filtered),
    (callId) => kernelTextByCallId.get(callId),
  );
  const stableTag = rewriteTagTokens(tag, coreBodyOf(firstCore.text ?? "", tag));
  const lastTextIdx = [...peeled].reverse().findIndex((b) => (b as { type?: string }).type === "text");
  if (lastTextIdx >= 0) {
    const idx = peeled.length - 1 - lastTextIdx;
    const lastBlock = peeled[idx] as { type: string; text: string };
    const baseText = lastBlock.text ?? "";
    peeled[idx] = { ...lastBlock, text: baseText.length > 0 ? `${baseText}\n\n${stableTag}` : stableTag };
    return { ...(original as object), content: peeled } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text", text: stableTag }, ...peeled] } as AgentMessage;
}

function coreBodyOf(coreText: string, tag: string): string {
  const tagCore = tag.replace(/\s+$/, "");
  let bodyStart = tagCore.length;
  if (coreText.charAt(bodyStart) === "\n") bodyStart += 1;
  return coreText.slice(bodyStart);
}

function patchRefTag(original: AgentMessage, core: CoreMessage): AgentMessage {
  const base = original as AnyMessage;
  // Skip tag injection for assistant messages — the model sees tags on its own
  // previous responses and echoes them, causing visible tag fragments in the terminal.
  // The model can still reference assistant messages by inferring refs from context.
  if (base.role === "assistant") {
    if (core.contentType === "tool-call" && core.toolCallId) {
      const rawBlocks = Array.isArray(base.content) ? base.content : [];
      const synced = syncToolCallArgs(rawBlocks, (callId) =>
        callId === core.toolCallId ? core.text : undefined,
      );
      if (synced !== rawBlocks) {
        return { ...(original as object), content: synced } as AgentMessage;
      }
    }
    // Lean: emergency truncation also rewrites assistant text; the tag skip
    // above must not throw that rewrite away (the safety valve would report
    // savings the request never got).
    const truncatedBody = truncatedCoreBody(core, extractText(base.content));
    return truncatedBody === null ? original : rebuildBodyFromCore(original, truncatedBody);
  }
  const match = core.text ? core.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;
  if (!tag) {
    // Untagged (e.g. protected) messages still carry kernel truncation.
    const truncatedBody = truncatedCoreBody(core, extractText(base.content));
    return truncatedBody === null ? original : rebuildBodyFromCore(original, truncatedBody);
  }
  // Honor kernel body mutations (emergency truncation of large tool-results,
  // future rewrites): if core.text's body differs from the original text,
  // rebuild from the kernel body — otherwise truncation never reaches the model.
  const coreBody = coreBodyOf(core.text ?? "", tag);
  const originalBody = extractText(base.content);
  const trimEnd = (s: string): string => s.replace(/\s+$/, "");
  if (coreBody && trimEnd(coreBody) !== trimEnd(originalBody)) {
    return rebuildBodyFromCore(original, coreBody, rewriteTagTokens(tag, coreBody));
  }
  const stableTag = rewriteTagTokens(tag, originalBody);
  const rawBlocks = Array.isArray(base.content)
    ? base.content
    : typeof base.content === "string"
      ? [{ type: "text" as const, text: base.content }]
      : [];
  const peeled = peelRefTagBlocks(rawBlocks);

  const newBlocks = [...peeled];
  let injected = false;
  for (let i = newBlocks.length - 1; i >= 0; i--) {
    const b = newBlocks[i] as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      const baseText = b.text.replace(/\n*$/, "");
      newBlocks[i] = { ...b, text: `${baseText}\n\n${stableTag}` };
      injected = true;
      break;
    }
  }
  if (injected) {
    return { ...(original as object), content: newBlocks } as AgentMessage;
  }

  return {
    ...(original as object),
    content: [...peeled, { type: "text" as const, text: stableTag }],
  } as AgentMessage;
}


/** The kernel-truncated body of `core` (ref tag stripped), or null when the
 *  kernel did not newly truncate it relative to `originalBody`. */
function truncatedCoreBody(core: CoreMessage, originalBody: string): string | null {
  const body = stripRefTag(core.text ?? "");
  if (!body.includes(TRUNCATION_MARKER) || originalBody.includes(TRUNCATION_MARKER)) return null;
  return body;
}

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
export function protectLatestUserMessage(
  inMessages: CoreMessage[],
  outMessages: CoreMessage[],
  config: Config,
  tokenCount: number,
): LatestUserGuardResult {
  let latest: CoreMessage | undefined;
  for (let i = inMessages.length - 1; i >= 0; i--) {
    if (inMessages[i]!.role === "user") { latest = inMessages[i]; break; }
  }
  const at = latest ? outMessages.findIndex((m) => m.id === latest!.id) : -1;
  const out = at >= 0 ? outMessages[at]! : undefined;
  if (!latest || !out || truncatedCoreBody(out, latest.text ?? "") === null) {
    return { messages: outMessages, remainingTokens: tokenCount };
  }
  const originalById = new Map(inMessages.map((m) => [m.id, m.text ?? ""]));
  let savedByOthers = 0;
  for (const m of outMessages) {
    if (m === out) continue;
    const before = originalById.get(m.id);
    if (before === undefined || truncatedCoreBody(m, before) === null) continue;
    savedByOthers += defaultCountTokens(before) - defaultCountTokens(stripRefTag(m.text ?? ""));
  }
  const tag = (out.text ?? "").match(REF_TAG)?.[0] ?? "";
  const restored: CoreMessage = { ...out, text: `${tag}${latest.text ?? ""}` };
  const hidden = outMessages.slice();
  hidden[at] = { ...out, text: "" };
  const pending = tokenCount - savedByOthers;
  const trunc = truncateLargeToolOutputs(hidden, pending, config, defaultCountTokens, {
    protectRecentMessages: config.preserveRecentMessages,
    includeTextMessages: true,
  });
  const messages = trunc.messages.slice();
  messages[at] = restored;
  return { messages, restoredId: latest.id, remainingTokens: pending - trunc.savedTokens };
}

function rebuildBodyFromCore(
  original: AgentMessage,
  coreBody: string,
  tag?: string,
): AgentMessage {
  const base = original as AnyMessage;
  const trimmed = coreBody.replace(/\s+$/, "");
  const text = tag ? `${trimmed}\n\n${tag}` : trimmed;
  if (typeof base.content === "string") {
    return { ...(original as object), content: text } as AgentMessage;
  }
  if (Array.isArray(base.content)) {
    const nonText = base.content.filter((b) => (b as { type?: string }).type !== "text");
    return {
      ...(original as object),
      content: [...nonText, { type: "text" as const, text }],
    } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text" as const, text }] } as AgentMessage;
}

function peelRefTagBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      const stripped = stripRefTag(b.text);
      if (stripped.length > 0 || b.text.length === 0) out.push({ ...b, text: stripped });
    } else {
      out.push(block);
    }
  }
  return out;
}
