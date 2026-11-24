// Claude cache anchor for the Responses wire format (on by default; turn off
// with acp.json `compress.claudeFoldAnchor: false`). The next fold most likely starts at the earliest
// compressible range, so everything before it survives that fold unchanged.
// CLIProxyAPI only places breakpoints on the system prompt and the latest
// message, so that stable prefix is rewritten after every fold. Marking the
// last item before the range lets Claude cache it: by default its last
// input_text/output_text part, skipping items without one (function_call,
// function_call_output). With `claudeFoldAnchor: "tool-output"` a
// function_call_output gets an item-level `cache_control` instead of being
// skipped. CLIProxyAPI >= 8.1.1 hoists it onto the Claude tool_result
// (router-for-me/CLIProxyAPI#7782); older versions drop it, and other endpoints
// may not accept it, so it is opt-in.
// When no range remains (right after the last fold) src/index.ts keeps the
// previous start: the prefix before it is unchanged and already cached.

// The host appends exactly one ref tag at the END of a user text part or a
// tool output; tags quoted elsewhere in text (e.g. a user pasting old output)
// must not count, so only a trailing tag is a real ref.
const TRAILING_REF_TAG = /<acp\b[^>]*>m(\d{5,})<\/acp>\s*$/;

export type FoldAnchorSetting = boolean | "tool-output";
export type FoldAnchorMode = "text" | "tool-output";

/** Anchor mode, or undefined when off: the anchor applies only when not
 *  disabled in config AND the live model is a Claude model on a `*responses`
 *  API (the wire format handled here). Any value other than false or
 *  "tool-output" means the default text-part anchor. */
export function claudeFoldAnchorMode(setting: FoldAnchorSetting | undefined, model: { api?: string; id?: string } | undefined): FoldAnchorMode | undefined {
  if (setting === false || !/responses$/.test(model?.api ?? "") || !/claude/i.test(model?.id ?? "")) return undefined;
  return setting === "tool-output" ? "tool-output" : "text";
}

function refNumber(ref: string): number | undefined {
  const m = /^m(\d+)$/.exec(ref);
  return m ? Number(m[1]) : undefined;
}

function itemTexts(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const { content, output } = item as { content?: unknown; output?: unknown };
  const out: string[] = [];
  if (typeof output === "string") out.push(output);
  for (const list of [content, output]) {
    if (!Array.isArray(list)) continue;
    for (const part of list) {
      const text = (part as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") out.push(text);
    }
  }
  if (typeof content === "string") out.push(content);
  return out;
}

function itemRefs(item: unknown): number[] {
  const refs: number[] = [];
  for (const text of itemTexts(item)) {
    const m = TRAILING_REF_TAG.exec(text);
    if (m) refs.push(Number(m[1]));
  }
  return refs;
}

/** Earliest ref by numeric order (refs may outgrow 5 digits). */
export function earliestRef(refs: string[]): string | undefined {
  let best: string | undefined;
  let bestNum = Infinity;
  for (const ref of refs) {
    const n = refNumber(ref);
    if (n !== undefined && n < bestNum) {
      best = ref;
      bestNum = n;
    }
  }
  return best;
}

function lastTextPart(item: unknown): Record<string, unknown> | undefined {
  if (!item || typeof item !== "object") return undefined;
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Record<string, unknown> | undefined;
    if ((part?.type === "input_text" || part?.type === "output_text") && typeof part.text === "string" && part.text.trim()) {
      return part;
    }
  }
  return undefined;
}

/** Item to mark at index i: its last text part; in "tool-output" mode a tool
 *  output itself. */
function anchorTarget(item: unknown, mode: FoldAnchorMode): Record<string, unknown> | undefined {
  if (mode === "tool-output" && (item as { type?: unknown } | undefined)?.type === "function_call_output") return item as Record<string, unknown>;
  return lastTextPart(item);
}

export interface FoldAnchorOutcome {
  body?: unknown;
  /** Index of the anchored input item, when one was marked. */
  index?: number;
  reason?: string;
}

/** Mark the last text part (or, in "tool-output" mode, tool output) that precedes `startRef` (the earliest compressible
 *  message, or the previous one when none remains; it may already be folded
 *  away — the scan compares ref numbers, so it need not appear in the body).
 *  Conservative: the anchor sits at or before the last tagged item
 *  whose ref is below `startRef`, so untagged assistant items belonging to the
 *  range can never be anchored. Pure: returns a shallow-copied body. */
export function applyFoldAnchor(body: unknown, startRef: string | undefined, mode: FoldAnchorMode = "text"): FoldAnchorOutcome {
  const start = startRef ? refNumber(startRef) : undefined;
  if (start === undefined) return { reason: "no-range" };
  const input = (body as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input)) return { reason: "no-input" };

  let boundary = -1;
  for (let i = 0; i < input.length; i++) {
    const refs = itemRefs(input[i]);
    if (refs.some((r) => r >= start)) break;
    if (refs.length > 0) boundary = i;
  }
  if (boundary < 0) return { reason: "no-boundary" };

  for (let i = boundary; i >= 0; i--) {
    const target = anchorTarget(input[i], mode);
    if (!target) continue;
    if (target.cache_control) return { reason: "already-marked", index: i };
    const marked = { ...target, cache_control: { type: "ephemeral" } };
    const nextInput = [...input];
    if (target === input[i]) {
      nextInput[i] = marked;
    } else {
      const item = input[i] as { content: unknown[] };
      nextInput[i] = { ...item, content: item.content.map((p) => (p === target ? marked : p)) };
    }
    return { body: { ...(body as object), input: nextInput }, index: i };
  }
  return { reason: "no-text-part" };
}
