import { baseIdOf, type CoreMessage, type CompressionBlock } from "acp-kernel";

// Port of billion-context b22a032: the last visible message before a fold is
// a stable cache prefix across later forward folds. Unlike the proxy, Pi's
// provider serializer owns the wire, so identify the selected message there
// conservatively and skip it if it cannot be matched uniquely.
type Anchor = { role: CoreMessage["role"]; ref?: string; text?: string; callId?: string };
type Wire = "anthropic" | "responses";
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | undefined => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : undefined;

export function foldAnchorMessageIds(
  original: readonly CoreMessage[], processed: readonly CoreMessage[],
  blocks: readonly Pick<CompressionBlock, "active" | "createdAt" | "effectiveMessageIds">[],
  limit: number, accept: (m: CoreMessage) => boolean,
): string[] {
  const active = blocks.filter(b => b.active && b.effectiveMessageIds.length > 0);
  const byBase = new Map<string, number[]>();
  active.forEach((b, i) => { for (const id of b.effectiveMessageIds) {
    const base = baseIdOf(id);
    byBase.set(base, [...(byBase.get(base) ?? []), i]);
  } });
  const visible = new Set(processed.map(m => m.id));
  const anchors = new Map<number, string | undefined>();
  let last: string | undefined;
  for (const m of original) {
    if (visible.has(m.id)) {
      if (accept(m)) last = m.id;
    } else {
      for (const i of byBase.get(baseIdOf(m.id)) ?? []) if (!anchors.has(i)) anchors.set(i, last);
    }
  }
  const all: string[] = [];
  for (const { i } of active.map((b, i) => ({ i, createdAt: b.createdAt })).sort((a, b) => b.createdAt - a.createdAt || b.i - a.i)) {
    const id = anchors.get(i);
    if (id !== undefined && !all.includes(id)) all.push(id);
  }
  if (all.length <= limit) return all;
  const oldest = limit > 2 ? 2 : 0;
  return [...all.slice(0, limit - oldest), ...(oldest ? all.slice(-oldest) : [])];
}

export function foldAnchorPolicy(api: string | undefined, origin: string | undefined): Wire | undefined {
  if (process.env.BILI_NO_CACHE_CONTROL || !origin) return;
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return; }
  const within = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (api === "anthropic-messages" && (within("anthropic.com") || within("githubcopilot.com"))) return "anthropic";
  if (api === "openai-responses" && within("githubcopilot.com")) return "responses";
  return;
}

/** Snapshot identities only; never retain or modify Pi's persisted messages. */
export function prepareFoldAnchors(
  original: readonly CoreMessage[], processed: readonly CoreMessage[],
  blocks: readonly CompressionBlock[], refs: Record<string, string>,
  originals: Map<string, unknown>, wire: Wire,
  model: { api?: string; provider?: string; id?: string },
): Anchor[] {
  const byId = new Map(original.map(m => [m.id, m]));
  // Pi only normalizes tool IDs on cross-model replay. For Responses, Copilot
  // normalizes the entire ID before splitting it; OpenAI-family providers
  // preserve the separator. Track collisions before matching the wire payload.
  const idsByRaw = new Map<string, Set<string>>();
  const rawsById = new Map<string, Set<string>>();
  const callCounts = new Map<string, number>();
  for (const m of original) {
    if (m.role !== "assistant" || m.contentType !== "tool-call" || !m.toolCallId) continue;
    callCounts.set(m.toolCallId, (callCounts.get(m.toolCallId) ?? 0) + 1);
    const source = obj(originals.get(baseIdOf(m.id)));
    if (!source) continue;
    const same = source.provider === model.provider && source.api === model.api && source.model === model.id;
    let id = m.toolCallId;
    if (!same) {
      if (wire === "anthropic") id = normalizeIdPart(id, false);
      else if (["openai", "openai-codex", "opencode"].includes(model.provider ?? "") && id.includes("|")) {
        id = normalizeIdPart(id.split("|")[0]!, true);
      } else id = normalizeIdPart(id, true);
    }
    if (wire === "responses") id = id.split("|")[0]!;
    if (!id) continue;
    if (!idsByRaw.has(m.toolCallId)) idsByRaw.set(m.toolCallId, new Set());
    idsByRaw.get(m.toolCallId)!.add(id);
    if (!rawsById.has(id)) rawsById.set(id, new Set());
    rawsById.get(id)!.add(m.toolCallId);
  }
  const identity = (m: CoreMessage): Anchor | undefined => {
    if (wire === "responses" && m.role !== "user" && m.contentType !== "tool-result") return;
    if (m.contentType === "tool-call" || m.contentType === "tool-result") {
      const ids = m.toolCallId && idsByRaw.get(m.toolCallId);
      if (!ids || ids.size !== 1 || callCounts.get(m.toolCallId!) !== 1) return;
      const callId = ids.values().next().value!;
      if (rawsById.get(callId)?.size !== 1) return;
      // A synthesized or substituted tool result can reuse the same call ID.
      // Its ACP ref distinguishes the actual selected result on the wire.
      const ref = m.contentType === "tool-result" ? refs[m.id] : undefined;
      if (m.contentType === "tool-result" && !ref) return;
      return { role: m.role, callId, ...(ref ? { ref } : {}) };
    }
    if (m.contentType !== "text" || (m.role !== "user" && m.role !== "assistant")) return;
    const originalMessage = obj(originals.get(baseIdOf(m.id)));
    const content = originalMessage?.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content)
      ? content.map(obj).filter(b => b?.type === "text" && typeof b.text === "string" && b.text.trim()).map(b => b!.text as string) : [];
    const ref = m.role === "user" ? refs[m.id] : undefined;
    const text = texts.at(-1);
    return ref || text ? { role: m.role, ref, text } : undefined;
  };
  // Upstream's Anthropic policy chooses the newest block, not the newest
  // block which happens to have an anchor.
  const newest = blocks.reduce<CompressionBlock | undefined>((best, b) =>
    b.active && b.effectiveMessageIds.length > 0 && (!best || b.createdAt >= best.createdAt) ? b : best, undefined);
  const selected = wire === "anthropic" ? (newest ? [newest] : []) : blocks;
  const ids = foldAnchorMessageIds(original, processed, selected, wire === "anthropic" ? 1 : 40, m => !!identity(m));
  return ids.map(id => identity(byId.get(id)!)).filter((a): a is Anchor => !!a);
}

function normalizeIdPart(id: string, responses: boolean): string {
  const normalized = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return responses ? normalized.replace(/_+$/, "") : normalized;
}
function textMatches(value: unknown, anchor: Anchor): boolean {
  if (typeof value !== "string") return false;
  if (anchor.ref) {
    const escaped = anchor.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:<acp\\s[^>]*>${escaped}</acp>|\\[${escaped}\\])`).test(value);
  }
  return !!anchor.text && value === anchor.text;
}

/** Add markers by copy; undefined means leave the provider payload untouched. */
export function applyFoldAnchors(payload: unknown, wire: Wire, anchors: readonly Anchor[]): unknown | undefined {
  const body = obj(payload);
  if (!body || anchors.length === 0) return;
  const field = wire === "anthropic" ? "messages" : "input";
  const items = body[field];
  if (!Array.isArray(items)) return;
  let out = items;
  let mark: Obj = { type: "ephemeral" };
  if (wire === "anthropic") {
    // Count all existing breakpoints, including nested tool-result blocks and
    // top-level cache_control. Unknown or mixed TTLs are left entirely alone.
    const marks: unknown[] = [];
    const scan = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) scan(x); return; }
      const o = obj(v); if (!o) return;
      if (o.cache_control !== undefined) marks.push(o.cache_control);
      for (const [k, x] of Object.entries(o)) if (k !== "cache_control") scan(x);
    };
    scan(body);
    if (marks.length >= 4) return;
    const ttls = marks.map(m => obj(m)?.ttl);
    if (marks.some(m => obj(m)?.type !== "ephemeral") || ttls.some(ttl => ttl !== undefined && ttl !== "5m" && ttl !== "1h")) return;
    const long = ttls.some(ttl => ttl === "1h");
    if (long && ttls.some(ttl => ttl !== "1h")) return;
    if (long) mark = { type: "ephemeral", ttl: "1h" };
  }
  for (const anchor of anchors) {
    // Collect only unambiguous exact matches. Tool results can be grouped in
    // a single Anthropic user message; the breakpoint goes on that result.
    const matches: { item: number; part: number }[] = [];
    for (let i = 0; i < out.length; i++) {
      const item = obj(out[i]); if (!item) continue;
      if (wire === "responses") {
        const isTool = item.type === "function_call_output" && anchor.role === "tool" && anchor.callId && item.call_id === anchor.callId;
        const isUser = item.role === "user" && (item.type === undefined || item.type === "message") && anchor.role === "user";
        if (!isTool && !isUser) continue;
        const value = item[isTool ? "output" : "content"];
        const parts = typeof value === "string" ? [{ type: "input_text", text: value }] : Array.isArray(value) ? value : [];
        if ((isUser || anchor.ref) && !parts.some(p => textMatches(obj(p)?.text, anchor))) continue;
        let last = -1; for (let j = 0; j < parts.length; j++) if (obj(parts[j])?.type === "input_text") last = j;
        if (last >= 0) matches.push({ item: i, part: last });
      } else {
        if (item.role !== (anchor.role === "tool" ? "user" : anchor.role)) continue;
        const parts = typeof item.content === "string" ? [{ type: "text", text: item.content }] : Array.isArray(item.content) ? item.content : [];
        for (let j = 0; j < parts.length; j++) {
          const part = obj(parts[j]); if (!part) continue;
          const toolContent = typeof part.content === "string" ? [{ text: part.content }] : Array.isArray(part.content) ? part.content : [];
          const call = anchor.callId && ((anchor.role === "tool" && part.type === "tool_result" && part.tool_use_id === anchor.callId && (!anchor.ref || toolContent.some(p => textMatches(obj(p)?.text, anchor)))) || (anchor.role === "assistant" && part.type === "tool_use" && part.id === anchor.callId));
          if (call || (!anchor.callId && part.type === "text" && textMatches(part.text, anchor))) matches.push({ item: i, part: j });
        }
      }
    }
    if (matches.length !== 1) continue;
    const { item: index, part: partIndex } = matches[0]!;
    const item = obj(out[index])!;
    const key = wire === "responses" && item.type === "function_call_output" ? "output" : "content";
    const value = item[key];
    const parts = typeof value === "string" ? [{ type: wire === "responses" ? "input_text" : "text", text: value }] : Array.isArray(value) ? value : [];
    const part = obj(parts[partIndex]);
    const marker = wire === "anthropic" ? "cache_control" : "prompt_cache_breakpoint";
    if (!part || part[marker] !== undefined) continue;
    const replacement = [...parts];
    replacement[partIndex] = { ...part, [marker]: wire === "anthropic" ? mark : { mode: "explicit" } };
    out = [...out]; out[index] = { ...item, [key]: replacement };
    if (wire === "anthropic") break;
  }
  return out === items ? undefined : { ...body, [field]: out };
}
